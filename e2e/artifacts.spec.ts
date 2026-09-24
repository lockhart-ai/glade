import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { desktop, expect, test } from './fixtures'
import { artifactsTab, chat, filesTab, firstRun, inputBar, taskHeader, taskList, taskPanel } from './selectors'

const NOTES = `# Release notes 2.4

## Features

- Per-key rate limiting on the public API.

## Fixes

- The date test no longer fails near midnight.
`

const GUIDE = `# Upgrading to 2.4

Clients over the new limits get 429 responses with a Retry-After header.
`

test('artifacts: the agent declares deliverables; Open, Copy and Reveal; they stay after done and a relaunch', async ({
  launch,
  tempFolder,
}) => {
  // The scripted agent's writes don't touch the disk: the files it declares are made here.
  const root = join(tempFolder(), 'acme-api')
  for (const [path, content] of [
    ['docs/releases/2.4.md', NOTES],
    ['docs/releases/2.4-upgrade.md', GUIDE],
  ] as const) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  const glade = await launch({ agentScript: 'declares-artifacts', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Draft release notes for 2.4, with a short upgrade guide.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)

  // ⌘⌥4 shows Artifacts: a card per declared file, in order, counted in the tab.
  const panel = taskPanel(window)
  const artifacts = artifactsTab(window)
  await window.keyboard.press('Meta+Alt+Digit4')
  await expect(panel.tab(/^Artifacts/)).toHaveAttribute('aria-selected', 'true')
  await expect(panel.tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(artifacts.cards).toHaveCount(2)
  await expect(artifacts.card('Release notes 2.4')).toContainText(
    /^Release notes 2\.4docs\/releases\/2\.4\.mdMarkdown · 9 lines · just now/,
  )
  await expect(artifacts.card('Upgrade guide')).toContainText(
    /^Upgrade guidedocs\/releases\/2\.4-upgrade\.mdMarkdown · 3 lines · just now/,
  )

  // Copy puts the file's contents on the clipboard; Reveal in folder shows it in Finder.
  await artifacts.action('Release notes 2.4', 'Copy').click()
  await expect.poll(async () => (await desktop(glade)).copied).toEqual([NOTES])
  await artifacts.action('Upgrade guide', 'Reveal in folder').click()
  await expect
    .poll(async () => (await desktop(glade)).revealed)
    .toEqual([realpathSync(join(root, 'docs', 'releases', '2.4-upgrade.md'))])

  // Open shows the file in the Files tab.
  const files = filesTab(window)
  await artifacts.action('Upgrade guide', 'Open').click()
  await expect(panel.tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(files.tab('2.4-upgrade.md')).toHaveAttribute('aria-pressed', 'true')
  await expect(files.line(1)).toContainText('# Upgrading to 2.4')

  // Marked done, the task keeps its artifacts.
  const header = taskHeader(window)
  await header.markDone.click()
  await expect(header.pill).toHaveText(/^Done · /)
  await window.keyboard.press('Meta+Alt+Digit4')
  await expect(panel.tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(artifacts.cards).toHaveCount(2)

  // And so does a relaunch.
  await glade.close()
  const relaunched = await launch()
  const again = artifactsTab(relaunched.window)
  const againPanel = taskPanel(relaunched.window)
  await expect(taskHeader(relaunched.window).pill).toHaveText(/^Done · /)
  await expect(againPanel.tab(/^Artifacts/)).toHaveText('Artifacts 2')
  await expect(again.cards).toHaveCount(2)
  await expect(again.card('Release notes 2.4')).toContainText('Markdown · 9 lines')

  // A file that's gone shows as missing, and can't be opened, copied or revealed.
  rmSync(join(root, 'docs', 'releases', '2.4-upgrade.md'))
  await relaunched.window.keyboard.press('Meta+Alt+Digit1')
  await relaunched.window.keyboard.press('Meta+Alt+Digit4')
  await expect(again.card('Upgrade guide')).toContainText('Markdown · missing')
  for (const name of ['Open', 'Copy', 'Reveal in folder'] as const) {
    await expect(again.action('Upgrade guide', name)).toBeDisabled()
  }
  await expect(again.action('Release notes 2.4', 'Copy')).toBeEnabled()
})
