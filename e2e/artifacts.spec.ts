import { copyFileSync, mkdirSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import type { Locator } from '@playwright/test'
import { desktop, expect, test, timeZoneAtHour } from './fixtures'
import {
  artifactsTab,
  chat,
  contextMenu,
  filesTab,
  firstRun,
  inputBar,
  taskHeader,
  taskList,
  taskPanel,
} from './selectors'

const NOTES = `# Release notes 2.4

## Features

- Per-key rate limiting on the public API.

## Fixes

- The date test no longer fails near midnight.
`

const GUIDE = `# Upgrading to 2.4

Clients over the new limits get 429 responses with a Retry-After header.
`

const MINUTE = 60_000
const DAY = 24 * 60

/** The accessible names of what a locator finds, in order: the rows' titles, or the groups' names. */
async function labels(locator: Locator): Promise<(string | null)[]> {
  return locator.evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')))
}

/** The app's clock reads midday, so minutes back are always today, and a day back yesterday, whatever the host's. */
const MIDDAY = { TZ: timeZoneAtHour(12) }

/** The sample screenshots, in the fixture workspace the design screens are captured from. */
const SCREENS = resolve(__dirname, '..', 'scripts', 'fixtures', 'artifacts-workspace', 'screens')

function write(root: string, path: string, content: string | Buffer, minutesAgo?: number): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
  if (minutesAgo !== undefined) {
    const at = new Date(Date.now() - minutesAgo * MINUTE)
    utimesSync(file, at, at)
  }
}

/** A PNG of one colour, `width` × `height`: a large image that takes little room on disk. */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
    const check = Buffer.alloc(4)
    check.writeUInt32BE(crc32(body))
    return Buffer.concat([length, body, check])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  // 8 bits a channel, RGB.
  header.set([8, 2, 0, 0, 0], 8)
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x5b)])
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

test('artifacts: the agent’s deliverables in Today, newest file first; hover actions; an edit moves one up', async ({
  launch,
  tempFolder,
}) => {
  // The scripted agent's writes don't touch the disk: the files it declares are made here, the guide changed last.
  const root = join(tempFolder(), 'acme-api')
  write(root, 'docs/releases/2.4.md', NOTES, 10)
  write(root, 'docs/releases/2.4-upgrade.md', GUIDE, 5)
  const glade = await launch({ agentScript: 'declares-artifacts', chosenFolder: root, env: MIDDAY })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Draft release notes for 2.4, with a short upgrade guide.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)

  // ⌘⌥4 shows Artifacts: a row per declared file under Today, the one changed last first, counted in the tab.
  const panel = taskPanel(window)
  const artifacts = artifactsTab(window)
  await window.keyboard.press('Meta+Alt+Digit4')
  await expect(panel.tab(/^Artifacts/)).toHaveAttribute('aria-selected', 'true')
  await expect(panel.tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(artifacts.groups).toHaveCount(1)
  await expect(artifacts.header('Today')).toHaveAttribute('aria-expanded', 'true')
  await expect(artifacts.header('Today')).toHaveText(/^Today\s*2$/)
  await expect.poll(() => labels(artifacts.rows)).toEqual(['Upgrade guide', 'Release notes 2.4'])
  await expect(artifacts.row('Upgrade guide')).toHaveText(/^Upgrade guideMarkdown5m$/)
  await expect(artifacts.open('Release notes 2.4')).toHaveAttribute('title', 'docs/releases/2.4.md')

  // Hovered, a row's age gives way to Open, Reveal in folder and More.
  await expect(artifacts.action('Release notes 2.4', 'Open')).toBeHidden()
  await artifacts.row('Release notes 2.4').hover()
  await expect(artifacts.action('Release notes 2.4', 'Open')).toBeVisible()
  await expect(artifacts.action('Release notes 2.4', 'Reveal in folder')).toBeVisible()
  await expect(artifacts.row('Release notes 2.4').getByText('10m')).toBeHidden()
  await artifacts.action('Release notes 2.4', 'Reveal in folder').click()
  await expect
    .poll(async () => (await desktop(glade)).revealed)
    .toEqual([realpathSync(join(root, 'docs', 'releases', '2.4.md'))])
  // More opens the row's context menu.
  await artifacts.action('Release notes 2.4', 'More').click()
  const menu = contextMenu(window, 'Artifact actions')
  await expect(menu.items).toHaveCount(6)
  await window.keyboard.press('Escape')
  await expect(menu.menu).toBeHidden()

  // Edited outside the agent (here, by the test, as in the terminal or an editor), the notes move back to the top.
  write(root, 'docs/releases/2.4.md', `${NOTES}\n- One more fix.\n`)
  await expect.poll(() => labels(artifacts.rows)).toEqual(['Release notes 2.4', 'Upgrade guide'])
  await expect(artifacts.row('Release notes 2.4')).toHaveText(/Markdownnow$/)

  // Clicking a row opens its file in the Files tab; back in Artifacts, that row is outlined.
  const files = filesTab(window)
  await artifacts.open('Upgrade guide').click()
  await expect(panel.tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(files.tab('2.4-upgrade.md')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.line(1)).toContainText('# Upgrading to 2.4')
  await window.keyboard.press('Meta+Alt+Digit4')
  await expect(artifacts.row('Upgrade guide')).toHaveAttribute('aria-current', 'true')

  // Folded, Today stays folded; marked done, the task keeps its artifacts.
  await artifacts.header('Today').click()
  await expect(artifacts.rows).toHaveCount(0)
  const header = taskHeader(window)
  await header.markDone.click()
  await expect(header.stateDot).toHaveAccessibleName(/^Done · /)
  await window.keyboard.press('Meta+Alt+Digit4')
  await expect(panel.tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(artifacts.header('Today')).toHaveAttribute('aria-expanded', 'false')

  // And so does a relaunch, with Today as it was left.
  await glade.close()
  const relaunched = await launch({ env: MIDDAY })
  const again = artifactsTab(relaunched.window)
  await expect(taskHeader(relaunched.window).stateDot).toHaveAccessibleName(/^Done · /)
  await expect(taskPanel(relaunched.window).tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(again.header('Today')).toHaveAttribute('aria-expanded', 'false')
  await again.header('Today').click()
  await expect.poll(() => labels(again.rows)).toEqual(['Release notes 2.4', 'Upgrade guide'])

  // A file that's gone stays where it was, as missing, and can't be opened or revealed.
  rmSync(join(root, 'docs', 'releases', '2.4-upgrade.md'))
  await expect(again.row('Upgrade guide')).toContainText('Markdown · missing')
  await expect.poll(() => labels(again.rows)).toEqual(['Release notes 2.4', 'Upgrade guide'])
  await again.row('Upgrade guide').hover()
  await expect(again.action('Upgrade guide', 'Open')).toBeDisabled()
  await expect(again.action('Upgrade guide', 'Reveal in folder')).toBeDisabled()
  await expect(again.action('Upgrade guide', 'More')).toBeEnabled()
})

test('artifacts: date groups that fold and stay folded, thumbnails of images, and opening one', async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-docs')
  mkdirSync(join(root, 'screens'), { recursive: true })
  copyFileSync(join(SCREENS, 'landing-dark.png'), join(root, 'screens', 'landing-dark.png'))
  copyFileSync(join(SCREENS, 'search-mobile.png'), join(root, 'screens', 'search-mobile.png'))
  write(root, 'docs/site/changelog.md', '# Changelog\n')
  write(
    root,
    'screens/logo.svg',
    '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#5B8DEF"/></svg>',
  )
  // Named as an image, but not one.
  write(root, 'screens/broken.png', 'not a picture')
  // Far larger than a row shows: its thumbnail is made off the window's thread.
  write(root, 'screens/poster.png', solidPng(6000, 4000))
  const seed = join(folder, 'artifacts.json')
  writeFileSync(
    seed,
    JSON.stringify({
      workspace: { name: 'Acme API', rootPath: realpathSync(root) },
      panelTab: 'artifacts',
      tasks: [
        {
          title: 'Refresh the developer docs site',
          minutesAgo: 4,
          selected: true,
          artifacts: [
            { path: 'screens/gone.png', title: 'Old landing page', minutesAgo: 60 * DAY },
            { path: 'screens/search-mobile.png', title: 'Search results on mobile', minutesAgo: 45 * DAY },
            { path: 'screens/poster.png', title: 'Launch poster', minutesAgo: DAY + 60 },
            { path: 'screens/logo.svg', title: 'Docs logo', minutesAgo: DAY + 30 },
            { path: 'screens/broken.png', title: 'Broken export', minutesAgo: 20 },
            { path: 'docs/site/changelog.md', title: 'Changelog page draft', minutesAgo: 14 },
            { path: 'screens/landing-dark.png', title: 'Landing page, dark theme', minutesAgo: 8 },
          ],
        },
      ],
    }),
  )
  const glade = await launch({ seed, env: MIDDAY })
  const { window } = glade
  const artifacts = artifactsTab(window)

  // Newest first, under progressive dates: Today and Yesterday open, the older group folded.
  await expect.poll(() => labels(artifacts.groups)).toEqual(['Today', 'Yesterday', 'Older'])
  await expect(artifacts.header('Today')).toHaveAttribute('aria-expanded', 'true')
  await expect(artifacts.header('Yesterday')).toHaveAttribute('aria-expanded', 'true')
  await expect(artifacts.header('Older')).toHaveAttribute('aria-expanded', 'false')
  await expect(artifacts.header('Older')).toHaveText(/^Older\s*2$/)
  await expect
    .poll(() => labels(artifacts.groupRows('Today')))
    .toEqual(['Landing page, dark theme', 'Changelog page draft', 'Broken export'])
  await expect.poll(() => labels(artifacts.groupRows('Yesterday'))).toEqual(['Docs logo', 'Launch poster'])
  await expect(artifacts.groupRows('Older')).toHaveCount(0)

  // Images get thumbnails, a large one too; anything else, or an image that isn't one, its type's tile.
  await expect(artifacts.thumbnail('Landing page, dark theme')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(artifacts.thumbnail('Docs logo')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(artifacts.thumbnail('Launch poster')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(artifacts.row('Broken export')).toHaveAttribute('aria-busy', 'false')
  await expect(artifacts.thumbnail('Broken export')).toHaveCount(0)
  await expect(artifacts.thumbnail('Changelog page draft')).toHaveCount(0)
  await expect(artifacts.row('Launch poster')).toHaveText(/^Launch posterPNG\d\d:\d\d$/)

  // A hovered row shows its buttons in place of its age.
  await artifacts.row('Changelog page draft').hover()
  await expect(artifacts.action('Changelog page draft', 'More')).toBeVisible()

  // Fold Yesterday and open Older: its missing file shows as missing.
  await artifacts.header('Yesterday').click()
  await expect(artifacts.groupRows('Yesterday')).toHaveCount(0)
  await artifacts.header('Older').click()
  await expect
    .poll(() => labels(artifacts.groupRows('Older')))
    .toEqual(['Search results on mobile', 'Old landing page'])
  await expect(artifacts.row('Old landing page')).toContainText('PNG · missing')
  await expect(artifacts.thumbnail('Search results on mobile')).toHaveAttribute('src', /^data:image\/png;base64,/)

  // Clicking a row opens its file in the Files tab.
  await artifacts.open('Landing page, dark theme').click()
  await expect(taskPanel(window).tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(filesTab(window).tab('landing-dark.png')).toHaveAttribute('aria-pressed', 'true')

  // The groups stay as they were left, after a relaunch too; the thumbnails come from where they were kept.
  await glade.close()
  const relaunched = await launch({ env: MIDDAY })
  await relaunched.window.keyboard.press('Meta+Alt+Digit4')
  const again = artifactsTab(relaunched.window)
  await expect(again.header('Today')).toHaveAttribute('aria-expanded', 'true')
  await expect(again.header('Yesterday')).toHaveAttribute('aria-expanded', 'false')
  await expect(again.header('Older')).toHaveAttribute('aria-expanded', 'true')
  await expect(again.thumbnail('Landing page, dark theme')).toHaveAttribute('src', /^data:image\/png;base64,/)
})
