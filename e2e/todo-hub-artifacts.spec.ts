// A file's and a link's tile in the todo hub (P16, #498), end to end: each does what its row in the old Artifacts tab
// did. A file's tile opens it in the Files tab (and is outlined while it shows
// there), or the image viewer for an image, which steps through the images of that todo alone and hands the focus back
// to the tile; a link's opens in the browser, never in Glade. Under the pointer or with the focus, a tile's age gives
// way to its icon buttons, which the keyboard alone reaches and works; More and a right-click open the artifact's
// menu, and Remove from artifacts takes the tile out of its todo's list and count.
//
// The children are filed by a seed (`src/main/capture-seed.ts`), written here over a real folder of files so their
// thumbnails are real.
//
// Two scenarios lost with the old Artifacts tab (#385, #460), restored here driving the todo hub instead: a tile
// follows at once when the agent repoints, renames or removes a file while the tab is open, and a titled image's
// title sits above its own left edge, truncating when it's long.
import { copyFileSync, existsSync, mkdirSync, realpathSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { crc32, deflateSync } from 'node:zlib'
import type { Locator, Page } from '@playwright/test'
import { CURATES_ARTIFACTS_TODO } from '../src/main/agent/scripts'
import { CommandName } from '../src/shared/bridge'
import { ArtifactKind } from '../src/shared/domain'
import { desktop, expect, test } from './fixtures'
import { expectImageLoaded } from './images'
import {
  chat,
  contextMenu,
  filesTab,
  firstRun,
  imageViewer,
  inputBar,
  taskHeader,
  taskList,
  taskPanel,
  todoHub,
} from './selectors'
import { invoke } from './task-view'

/** The sample screenshots, in the fixture workspace the Artifacts tab's design screens are captured from. */
const SCREENS = resolve(__dirname, '..', 'scripts', 'fixtures', 'artifacts-workspace', 'screens')

const MINUTE = 60_000
const TASK = 'Ship the rate-limit fixes for 2.5'
const DOCS = '#503 Document the rate limits'
const SEARCH = '#502 Per-key limits for /search'

const RATES = 'docs/rate-limits.md'
const LONG_TITLE =
  'Every rate limit the public API has, per key, per route and per plan, with worked examples for each client library'
const PR = 'https://github.com/acme/api/pull/509'
const PAGE = 'https://handbook.example.com/token-buckets'

/** The border of a tile at rest (`inner-border`), and of the one whose file the Files tab shows (`slate`). */
const INNER_BORDER = 'rgb(55, 60, 79)'
const SLATE = 'rgb(92, 99, 120)'

interface SeedFile {
  readonly path: string
  readonly title: string
  readonly minutesAgo: number
  readonly todo: string
  /** What's written there: text, a sample screenshot's name, or nothing for a file that's gone. */
  readonly content: { readonly text: string } | { readonly screenshot: string } | null
}

/**
 * Under the done todo, newest first: a Markdown file, a pull request, two images, a file with a very long title and
 * one that's gone. Under the other: an image of its own, an issue, a ticket and a plain page.
 */
const FILES: readonly SeedFile[] = [
  { path: RATES, title: 'Rate limits reference', minutesAgo: 6, todo: '2', content: { text: '# Rate limits\n' } },
  {
    path: 'docs/img/headers.png',
    title: 'Rate limit headers, before and after',
    minutesAgo: 9,
    todo: '2',
    content: { screenshot: 'landing-dark.png' },
  },
  {
    path: 'docs/img/burst.png',
    title: 'Requests in a burst',
    minutesAgo: 12,
    todo: '2',
    content: { screenshot: 'search-mobile.png' },
  },
  { path: 'docs/limits-by-plan.md', title: LONG_TITLE, minutesAgo: 15, todo: '2', content: { text: '# Plans\n' } },
  { path: 'docs/draft.md', title: 'First draft', minutesAgo: 50, todo: '2', content: null },
  {
    path: 'docs/img/search-limit.png',
    title: 'The /search limit, charted',
    minutesAgo: 4,
    todo: '1',
    content: { screenshot: 'theme-tokens.png' },
  },
]

const LINKS = [
  { url: PR, title: 'Document the rate limits', minutesAgo: 7, todo: '2' },
  { url: 'https://github.com/acme/api/issues/502', title: '/search needs its own limit', minutesAgo: 24, todo: '1' },
  { url: 'https://acme.atlassian.net/browse/API-123', title: 'Limit /search per key', minutesAgo: 30, todo: '1' },
  { url: PAGE, title: 'Token buckets, explained', minutesAgo: 19, todo: '1' },
]

function todoCall(id: string, subject: string): object {
  return {
    kind: 'tool_call',
    name: 'TaskCreate',
    input: { subject, description: subject },
    output: `Task #${id} created successfully: ${subject}`,
    turn: 1,
    minutesAgo: 39,
  }
}

/** Writes the workspace's files and the seed that files them, both todos open. Answers with the seed and the root. */
function hubSeed(folder: string): { readonly seed: string; readonly root: string } {
  const root = join(folder, 'api')
  for (const { path, content, minutesAgo } of FILES) {
    if (content === null) continue
    const file = join(root, path)
    mkdirSync(dirname(file), { recursive: true })
    if ('text' in content) writeFileSync(file, content.text)
    else copyFileSync(join(SCREENS, content.screenshot), file)
    // Last changed when it was declared, so main's look at it leaves the list's order as the seed has it.
    const at = new Date(Date.now() - minutesAgo * MINUTE)
    utimesSync(file, at, at)
  }
  const seed = join(folder, 'todo-hub-artifacts.json')
  writeFileSync(
    seed,
    JSON.stringify({
      workspace: { name: 'Acme API', rootPath: realpathSync(root) },
      panelTab: 'todos',
      tasks: [
        {
          title: TASK,
          objective: 'Work #502 and #503 for 2.5, then draft the release notes.',
          status: 'The docs are written. PR #513 is waiting on CI.',
          minutesAgo: 2,
          selected: true,
          messages: [
            { role: 'user', body: 'Work #502 and #503 for 2.5.', turn: 1, minutesAgo: 40 },
            { role: 'agent', body: 'The docs are written, with their screenshots.', turn: 1, minutesAgo: 2 },
          ],
          toolEvents: [
            todoCall('1', SEARCH),
            todoCall('2', DOCS),
            {
              kind: 'tool_call',
              name: 'TaskUpdate',
              input: { taskId: '1', status: 'in_progress', activeForm: 'Waiting on CI · PR #513' },
              output: 'Updated task #1 status',
              turn: 1,
              minutesAgo: 38,
            },
            {
              kind: 'tool_call',
              name: 'TaskUpdate',
              input: { taskId: '2', status: 'completed' },
              output: 'Updated task #2 status',
              turn: 1,
              minutesAgo: 3,
            },
          ],
          artifacts: [
            ...FILES.map(({ path, title, minutesAgo, todo }) => ({ path, title, minutesAgo, todo })),
            ...LINKS,
          ],
          todoPanels: [
            { todo: '1', open: true },
            { todo: '2', open: true },
          ],
        },
      ],
    }),
  )
  return { seed, root }
}

/** The names of the tiles a card shows, in order. */
async function tilesOf(window: Page, card: string): Promise<string[]> {
  const hub = todoHub(window)
  return hub.tiles(hub.card(card)).evaluateAll((tiles) => tiles.map((tile) => tile.getAttribute('aria-label') ?? ''))
}

/** A card's filter pills, as they're named, All first. */
async function pillsOf(window: Page, card: string): Promise<string[]> {
  return todoHub(window)
    .card(card)
    .getByRole('group', { name: 'Show' })
    .getByRole('button')
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''))
}

async function heightOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.height ?? 0
}

async function widthOf(locator: Locator): Promise<number> {
  return (await locator.boundingBox())?.width ?? 0
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

/** An element's box, as `getBoundingClientRect` gives it. */
interface Box {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** What a titled image's viewer is measured by: its title, the image showing, and its actions (Open in Files). */
interface ViewerBoxes {
  readonly title: Box
  readonly image: Box
  readonly actions: Box
}

/** The only task's id, as main has it. */
async function onlyTaskId(window: Page): Promise<string> {
  const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
  const { tasks } = await invoke(window, CommandName.TasksList, { workspaceId: workspaces[0]?.id ?? '' })
  return tasks[0]?.id ?? ''
}

test('todo hub: a file’s tile opens it in Files and is outlined there; its icon buttons show on hover and work by keyboard alone; its menu removes it', async ({
  launch,
  tempFolder,
}) => {
  const { seed, root } = hubSeed(tempFolder())
  const glade = await launch({ seed })
  const { window } = glade
  const hub = todoHub(window)
  const panel = taskPanel(window)
  await expect(taskHeader(window).title).toHaveText(TASK)

  const docs = hub.card(DOCS)
  await expect
    .poll(() => tilesOf(window, DOCS))
    .toEqual([
      'File: Rate limits reference',
      'Link: Document the rate limits',
      'File: Rate limit headers, before and after',
      'File: Requests in a burst',
      `File: ${LONG_TITLE}`,
      'File: First draft',
    ])
  expect(await pillsOf(window, DOCS)).toEqual(['All 6', '5 files', '1 link'])

  // At rest: its title, its type and its age, with no button showing.
  const rates = hub.tile(docs, 'File: Rate limits reference')
  await expect(rates).toHaveText(/^Rate limits referenceMarkdown6m$/)
  await expect(rates.getByText('Markdown')).toHaveAttribute('title', RATES)
  await expect(hub.tileAction(rates, 'Open')).toBeHidden()
  await expect(rates).toHaveCSS('border-top-color', INNER_BORDER)
  const atRest = await heightOf(rates)

  // Under the pointer, its age gives way to Open, Reveal in folder and More, and the tile is no taller for it.
  await rates.hover()
  for (const name of ['Open', 'Reveal in folder', 'More']) await expect(hub.tileAction(rates, name)).toBeVisible()
  await expect(rates.getByText('6m')).toBeHidden()
  await expect.poll(() => heightOf(rates)).toBe(atRest)
  await expect.poll(() => widthOf(hub.tileAction(rates, 'Open'))).toBe(22)

  // By the keyboard alone: Tab from the todo's last pill reaches the tile, then each of its buttons in turn.
  await taskHeader(window).title.hover()
  await hub.kind(docs, '1 link').focus()
  await window.keyboard.press('Tab')
  await expect(rates).toBeFocused()
  await expect(hub.tileAction(rates, 'Open')).toBeVisible()
  await expect(rates.getByText('6m')).toBeHidden()
  await window.keyboard.press('Tab')
  await expect(hub.tileAction(rates, 'Open')).toBeFocused()
  await window.keyboard.press('Tab')
  await expect(hub.tileAction(rates, 'Reveal in folder')).toBeFocused()
  await window.keyboard.press('Enter')
  await expect.poll(async () => (await desktop(glade)).revealed).toEqual([realpathSync(join(root, RATES))])
  // ↵ on a button is the button's: the file didn't open.
  await expect(panel.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Tab')
  await expect(hub.tileAction(rates, 'More')).toBeFocused()
  await window.keyboard.press('Enter')
  const menu = contextMenu(window, 'Artifact actions')
  await expect(menu.items).toHaveText([
    /^Open/,
    /^Open in editor/,
    'Copy contents',
    'Copy path',
    'Reveal in Finder',
    'Remove from artifacts',
  ])
  // The focus is in the menu now, and the pointer elsewhere, but the tile keeps its buttons while its menu is open:
  // the menu hangs under More, and Esc gives More the focus back. (Found by its markup: while a menu is open, the
  // window behind it is hidden from assistive technology, and so from a locator by role.)
  const pinnedMore = window.locator('[aria-label="File: Rate limits reference"] button[aria-label="More"]')
  await expect(pinnedMore).toBeVisible()
  await expect
    .poll(async () => {
      const [under, button] = [await menu.menu.boundingBox(), await pinnedMore.boundingBox()]
      if (under === null || button === null) return null
      return under.y >= button.y + button.height && under.x + under.width <= button.x + button.width + 1
    })
    .toBe(true)
  await window.keyboard.press('Escape')
  await expect(menu.menu).toBeHidden()
  await expect(hub.tileAction(rates, 'More')).toBeFocused()

  // ↵ on the tile itself opens the file in the Files tab.
  await rates.focus()
  await expect(rates).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(panel.tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(filesTab(window).tab('rate-limits.md')).toHaveAttribute('aria-pressed', 'true')

  // Back in Todos, the tile of the file Files shows is outlined, and no other is.
  await panel.tab(/^Todos/).click()
  await expect(rates).toHaveAttribute('aria-current', 'true')
  await expect(rates).toHaveCSS('border-top-color', SLATE)
  await expect(docs.locator('[aria-current]')).toHaveCount(1)

  // A click opens one too, and the outline follows it.
  const long = hub.tile(docs, `File: ${LONG_TITLE}`)
  await long.click()
  await expect(filesTab(window).tab('limits-by-plan.md')).toHaveAttribute('aria-pressed', 'true')
  await panel.tab(/^Todos/).click()
  await expect(long).toHaveAttribute('aria-current', 'true')
  await expect(rates).not.toHaveAttribute('aria-current')
  await expect(rates).toHaveCSS('border-top-color', INNER_BORDER)

  // A title too long for the tile is cut short on one line: the tile is as wide and as tall as the others.
  await expect.poll(() => widthOf(long)).toBe(await widthOf(rates))
  await expect.poll(() => heightOf(long)).toBe(atRest)
  await expect
    .poll(() => hub.tileTitle(long, LONG_TITLE).evaluate((title) => title.scrollWidth > title.clientWidth))
    .toBe(true)
  await long.hover()
  await expect(hub.tileAction(long, 'More')).toBeVisible()
  await expect.poll(() => widthOf(long)).toBe(await widthOf(rates))

  // A file that's gone shows as missing, and can't be opened or revealed: a click on it opens nothing.
  const draft = hub.tile(docs, 'File: First draft')
  await expect(draft).toContainText('Markdown · missing')
  await draft.click()
  await expect(panel.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  await expect(hub.tileAction(draft, 'Open')).toBeDisabled()
  await expect(hub.tileAction(draft, 'Reveal in folder')).toBeDisabled()

  // But it can be taken off the artifacts, from More: its tile leaves the todo's list, and its count.
  await hub.tileAction(draft, 'More').click()
  await menu.item('Remove from artifacts').click()
  await expect(draft).toHaveCount(0)
  await expect(hub.tiles(docs)).toHaveCount(5)
  expect(await pillsOf(window, DOCS)).toEqual(['All 5', '4 files', '1 link'])

  // And from a right-click on a tile: the other todo keeps its own.
  await long.click({ button: 'right' })
  await expect(menu.items).toHaveCount(6)
  await menu.item('Remove from artifacts').click()
  await expect(long).toHaveCount(0)
  expect(await pillsOf(window, DOCS)).toEqual(['All 4', '3 files', '1 link'])
  expect(await pillsOf(window, SEARCH)).toEqual(['All 4', '1 file', '3 links'])
})

test('todo hub: a link’s tile says what it is from its address, opens in the browser and never in Glade, and copies', async ({
  launch,
  tempFolder,
}) => {
  const { seed } = hubSeed(tempFolder())
  const glade = await launch({ seed })
  const { window } = glade
  const hub = todoHub(window)
  const panel = taskPanel(window)
  await expect(taskHeader(window).title).toHaveText(TASK)

  // What each is, from its address alone: a PR's or an issue's number, a ticket's key, any other page's domain.
  const search = hub.card(SEARCH)
  await expect
    .poll(() => tilesOf(window, SEARCH))
    .toEqual([
      'File: The /search limit, charted',
      'Link: Token buckets, explained',
      'Link: /search needs its own limit',
      'Link: Limit /search per key',
    ])
  await expect(hub.tile(search, 'Link: /search needs its own limit')).toHaveText(
    /^\/search needs its own limit#50224m$/,
  )
  await expect(hub.tile(search, 'Link: Limit /search per key')).toHaveText(/^Limit \/search per keyAPI-12330m$/)
  const page = hub.tile(search, 'Link: Token buckets, explained')
  await expect(page).toHaveText(/^Token buckets, explainedhandbook\.example\.com19m$/)
  const pr = hub.tile(hub.card(DOCS), 'Link: Document the rate limits')
  await expect(pr).toHaveText(/^Document the rate limits#5097m$/)
  // The repository is on its number, under the pointer.
  await expect(pr.getByText('#509')).toHaveAttribute('title', '#509 · acme/api')

  // A click opens it in the browser, through main: the panel stays on Todos, and nothing opens in Glade.
  await pr.click()
  await expect.poll(async () => (await desktop(glade)).opened).toEqual([PR])
  await expect(panel.tab(/^Todos/)).toHaveAttribute('aria-selected', 'true')
  await expect(imageViewer(window).viewer).toHaveCount(0)

  // Under the pointer: Open link, Copy link and More, in its age's place.
  await expect(hub.tileAction(page, 'Open link')).toBeHidden()
  await page.hover()
  for (const name of ['Open link', 'Copy link', 'More']) await expect(hub.tileAction(page, name)).toBeVisible()
  await expect(page.getByText('19m')).toBeHidden()
  await hub.tileAction(page, 'Copy link').click()
  await expect.poll(async () => (await desktop(glade)).copied).toEqual([PAGE])
  await hub.tileAction(page, 'Open link').click()
  await expect.poll(async () => (await desktop(glade)).opened).toEqual([PR, PAGE])

  // By the keyboard alone: ↵ on the tile opens it, and its buttons take the focus in turn.
  await page.focus()
  await expect(page).toBeFocused()
  await window.keyboard.press('Enter')
  await expect.poll(async () => (await desktop(glade)).opened).toEqual([PR, PAGE, PAGE])
  await window.keyboard.press('Tab')
  await expect(hub.tileAction(page, 'Open link')).toBeFocused()
  await window.keyboard.press('Tab')
  await expect(hub.tileAction(page, 'Copy link')).toBeFocused()
  await window.keyboard.press('Space')
  await expect.poll(async () => (await desktop(glade)).copied).toEqual([PAGE, PAGE])
  await expect.poll(async () => (await desktop(glade)).opened).toHaveLength(3)

  // Its menu, from More: Open link, Copy link and Remove from artifacts, which takes it out of the todo's list.
  await window.keyboard.press('Tab')
  await expect(hub.tileAction(page, 'More')).toBeFocused()
  await window.keyboard.press('Enter')
  const menu = contextMenu(window, 'Artifact actions')
  await expect(menu.items).toHaveText([/^Open link/, 'Copy link', 'Remove from artifacts'])
  await menu.item('Remove from artifacts').click()
  await expect(page).toHaveCount(0)
  expect(await pillsOf(window, SEARCH)).toEqual(['All 3', '1 file', '2 links'])
  expect(await pillsOf(window, DOCS)).toEqual(['All 6', '5 files', '1 link'])
})

test('todo hub: an image’s tile opens the viewer on that todo’s images alone, and the focus returns to the tile', async ({
  launch,
  tempFolder,
}) => {
  const { seed } = hubSeed(tempFolder())
  const glade = await launch({ seed })
  const { window } = glade
  const hub = todoHub(window)
  const viewer = imageViewer(window)
  await expect(taskHeader(window).title).toHaveText(TASK)

  // An image's tile has its thumbnail where the icon goes, so it's a little taller than the rest.
  const docs = hub.card(DOCS)
  const headers = hub.tile(docs, 'File: Rate limit headers, before and after')
  const burst = hub.tile(docs, 'File: Requests in a burst')
  const rates = hub.tile(docs, 'File: Rate limits reference')
  await expect(hub.tileThumbnail(headers)).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(hub.tileThumbnail(burst)).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(hub.tileThumbnail(rates)).toHaveCount(0)
  await expect(headers).toHaveText(/^Rate limit headers, before and afterPNG9m$/)
  await expect.poll(() => widthOf(hub.tileThumbnail(headers))).toBe(38)
  await expect.poll(() => heightOf(hub.tileThumbnail(headers))).toBe(26)
  await expect.poll(async () => (await heightOf(headers)) - (await heightOf(rates))).toBe(10)

  // A click opens the viewer on it: the first of this todo's two images, in the list's order.
  await headers.click()
  // The viewer takes the focus a moment after it opens: until then ←, → and Esc go to the tile.
  await expect(viewer.close).toBeFocused()
  await expect(viewer.title).toHaveText('Rate limit headers, before and after')
  await expect(viewer.pager).toHaveText('1 of 2')
  await expect(viewer.previous).toBeDisabled()

  // → steps to the todo's other image, past the link between them, and no further: never the other todo's image.
  await window.keyboard.press('ArrowRight')
  await expect(viewer.title).toHaveText('Requests in a burst')
  await expect(viewer.pager).toHaveText('2 of 2')
  await expect(viewer.next).toBeDisabled()
  await window.keyboard.press('ArrowRight')
  await expect(viewer.pager).toHaveText('2 of 2')
  await expect(viewer.title).toHaveText('Requests in a burst')
  await expect(viewer.shown('The /search limit, charted')).toHaveCount(0)
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('1 of 2')
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.title).toHaveText('Rate limit headers, before and after')

  // Esc closes it, and the tile it was opened from has the focus again.
  await window.keyboard.press('Escape')
  await expect(viewer.viewer).toHaveCount(0)
  await expect(headers).toBeFocused()

  // ↵ opens it again, from the keyboard; its Open button does too, and the focus still returns to the tile.
  await window.keyboard.press('Enter')
  await expect(viewer.close).toBeFocused()
  await expect(viewer.pager).toHaveText('1 of 2')
  await window.keyboard.press('Escape')
  await expect(headers).toBeFocused()
  await burst.hover()
  await hub.tileAction(burst, 'Open').click()
  await expect(viewer.close).toBeFocused()
  await expect(viewer.pager).toHaveText('2 of 2')
  await viewer.close.click()
  await expect(viewer.viewer).toHaveCount(0)
  await expect(burst).toBeFocused()

  // The other todo's one image opens alone, with nothing to step to.
  const chart = hub.tile(hub.card(SEARCH), 'File: The /search limit, charted')
  await chart.click()
  await expect(viewer.close).toBeFocused()
  await expect(viewer.title).toHaveText('The /search limit, charted')
  await expect(viewer.pager).toHaveCount(0)
  await window.keyboard.press('ArrowRight')
  await expect(viewer.title).toHaveText('The /search limit, charted')
  await window.keyboard.press('Escape')
  await expect(chart).toBeFocused()

  // A file removed while the viewer is open on it (here by the agent, as `remove_artifact` does): the viewer closes,
  // and its tile leaves the todo's list and count.
  await headers.click()
  await expect(viewer.close).toBeFocused()
  await invoke(window, CommandName.ArtifactsRemove, {
    taskId: await onlyTaskId(window),
    ref: { kind: ArtifactKind.File, path: 'docs/img/headers.png' },
  })
  await expect(viewer.viewer).toHaveCount(0)
  await expect(headers).toHaveCount(0)
  expect(await pillsOf(window, DOCS)).toEqual(['All 5', '4 files', '1 link'])

  // The image left is the todo's only one now.
  await burst.click()
  await expect(viewer.close).toBeFocused()
  await expect(viewer.pager).toHaveCount(0)
  await window.keyboard.press('Escape')
  await expect(burst).toBeFocused()
})

test('todo hub: a tile follows at once when the agent repoints, renames or removes a file, with the tab open (#385)', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-docs')
  mkdirSync(join(root, 'screens'), { recursive: true })
  // Each copy's mtime set explicitly (newest last), so main's look at the files, however the copies land in whatever
  // order the filesystem gives them, sorts the tiles the same way every time.
  const screenshot = (from: string, to: string, minutesAgo: number): void => {
    const file = join(root, 'screens', to)
    copyFileSync(join(SCREENS, from), file)
    const at = new Date(Date.now() - minutesAgo * 60_000)
    utimesSync(file, at, at)
  }
  screenshot('landing-light.png', 'landing.png', 30)
  screenshot('search-mobile.png', 'search-mobile.png', 20)
  screenshot('nav-tree.png', 'nav-tree.png', 10)
  // Retaken in the dark theme, under a new name, after the first turn.
  screenshot('landing-dark.png', 'landing-dark.png', 5)
  const glade = await launch({ agentScript: 'curates-artifacts', chosenFolder: root })
  const { window } = glade
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await inputBar(window).field.fill('Screenshot the landing page, search and navigation.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(1)

  // The Todos tab is open on the one todo, its three screenshots tiled under it, newest first.
  const hub = todoHub(window)
  await taskPanel(window)
    .tab(/^Todos/)
    .click()
  await hub.head(CURATES_ARTIFACTS_TODO.subject).click()
  const card = hub.card(CURATES_ARTIFACTS_TODO.subject)
  await expect
    .poll(() => tilesOf(window, CURATES_ARTIFACTS_TODO.subject))
    .toEqual(['File: Old navigation', 'File: Search results on mobile', 'File: Landing page'])
  await expect(hub.tileThumbnail(hub.tile(card, 'File: Landing page'))).toHaveAttribute(
    'src',
    /^data:image\/png;base64,/,
  )

  // While the tab still shows it, the next turn points the landing page at the dark screenshot, renamed
  // (`update_artifact`), and takes the navigation off the list (`remove_artifact`): the tile list follows at once,
  // with no relaunch and no reselecting the task.
  await inputBar(window).field.fill('The landing page is retaken in the dark theme; drop the old navigation.')
  await inputBar(window).field.press('Enter')
  await expect(chat(window).agentReplies).toHaveCount(2)
  await expect
    .poll(() => tilesOf(window, CURATES_ARTIFACTS_TODO.subject))
    .toEqual(['File: Landing page, dark theme', 'File: Search results on mobile'])
  const dark = hub.tile(card, 'File: Landing page, dark theme')
  await expect(dark.getByText('PNG')).toHaveAttribute('title', 'screens/landing-dark.png')
  await expect(hub.tileThumbnail(dark)).toHaveAttribute('src', /^data:image\/png;base64,/)
  expect(await pillsOf(window, CURATES_ARTIFACTS_TODO.subject)).toEqual(['All 2', '2 files'])
  // The old navigation's file is only taken off the list; its file on disk stays.
  expect(existsSync(join(root, 'screens', 'nav-tree.png'))).toBe(true)
})

test('todo hub: a titled image’s title sits above its own left edge for small, wide and tall images, truncating when it’s long (#460)', async ({
  launch,
  tempFolder,
}) => {
  const folder = tempFolder()
  const root = join(folder, 'acme-gallery')
  mkdirSync(join(root, 'screens'), { recursive: true })
  writeFileSync(join(root, 'screens', 'small.png'), solidPng(160, 100))
  writeFileSync(join(root, 'screens', 'wide.png'), solidPng(2200, 300))
  writeFileSync(join(root, 'screens', 'tall.png'), solidPng(300, 1400))
  const longTitle =
    'This title is far longer than the small image is wide, so it must truncate with an ellipsis rather than ' +
    'spill past the image’s own edge or crowd the actions'
  const TODO = 'Review the new crops'
  const seed = join(folder, 'todo-hub-image-viewer.json')
  writeFileSync(
    seed,
    JSON.stringify({
      workspace: { name: 'Acme Gallery', rootPath: realpathSync(root) },
      panelTab: 'todos',
      tasks: [
        {
          title: TODO,
          objective: 'Check the small, wide and tall crops read well together.',
          status: 'All three are in Todos.',
          minutesAgo: 4,
          selected: true,
          messages: [{ role: 'user', body: 'Share the crops.', turn: 1, minutesAgo: 10 }],
          toolEvents: [todoCall('1', TODO)],
          artifacts: [
            { path: 'screens/tall.png', title: 'Tall portrait', minutesAgo: 6, todo: '1' },
            { path: 'screens/wide.png', title: 'Wide banner', minutesAgo: 7, todo: '1' },
            { path: 'screens/small.png', title: longTitle, minutesAgo: 8, todo: '1' },
          ],
          todoPanels: [{ todo: '1', open: true }],
        },
      ],
    }),
  )
  const glade = await launch({ seed })
  const { window } = glade
  const hub = todoHub(window)
  const card = hub.card(TODO)
  const viewer = imageViewer(window)

  // From here on, each time the page changes (#478): a title in the document is on a loaded image, at its left edge,
  // and an image that shows has its title. While an image loads there is nothing to place a title against, so there
  // must be no title either (not one waiting in the middle of the window for the image to arrive), and the two then
  // appear together, neither a frame ahead of the other.
  const misplaced = await window.evaluateHandle(() => {
    const found: string[] = []
    const check = (): void => {
      const title = document.querySelector('[data-testid="image-viewer-title"]')
      const named = title === null ? '' : `"${title.textContent.slice(0, 24)}"`
      const under = title?.parentElement?.querySelector('img') ?? null
      if (title !== null && under === null) {
        found.push(`${named} is in the document with no image`)
      } else if (title !== null && under !== null && (!under.complete || under.naturalWidth === 0)) {
        found.push(`${named} is in the document before its image has loaded`)
      } else if (title !== null && under !== null) {
        const offset = title.getBoundingClientRect().left - under.getBoundingClientRect().left
        if (Math.abs(offset) > 1) found.push(`${named} is ${String(offset)}px from its image's left edge`)
      }
      for (const image of document.querySelectorAll<HTMLImageElement>('[role="dialog"] img')) {
        const frame = image.parentElement
        // Not the one showing, or not shown yet.
        if (frame === null || frame.hidden || getComputedStyle(frame).visibility === 'hidden') continue
        if (frame.querySelector('[data-testid="image-viewer-title"]') === null) {
          found.push(`"${image.alt.slice(0, 24)}" is showing without its title`)
        }
      }
    }
    new MutationObserver(check).observe(document.body, { subtree: true, childList: true, attributes: true })
    return found
  })

  /**
   * The title sits just above the named image, sharing its left edge, and is never wider than it (#460). Gives back
   * what it measured: the title's box, the image's and the actions' (Open in Files, their left end).
   */
  const assertTitleAboveImage = async (name: string): Promise<ViewerBoxes> => {
    // Loaded and at its size (#478): only then is there an image to measure the title against.
    await expectImageLoaded(viewer.shown(name))
    await expect(viewer.title).toHaveText(name)
    // All three from the one layout, rather than read one by one with the page free to change in between.
    const measured = await viewer.viewer.evaluate((dialog, alt): ViewerBoxes => {
      const box = (element: Element | null | undefined): Box => {
        if (element === null || element === undefined) throw new Error('No box')
        const { x, y, width, height } = element.getBoundingClientRect()
        return { x, y, width, height }
      }
      const title = dialog.querySelector('[data-testid="image-viewer-title"]')
      return {
        title: box(title),
        image: box(Array.from(title?.parentElement?.querySelectorAll('img') ?? []).find((each) => each.alt === alt)),
        actions: box(dialog.querySelector('button[aria-label="Open in Files"]')),
      }
    }, name)
    const { title, image } = measured
    expect(Math.abs(title.x - image.x)).toBeLessThanOrEqual(1)
    expect(title.y + title.height).toBeLessThanOrEqual(image.y)
    expect(title.width).toBeLessThanOrEqual(image.width + 1)
    return measured
  }

  // Small, with a long title: it truncates with an ellipsis rather than spilling past the image's own edge.
  await hub.tile(card, `File: ${longTitle}`).click()
  await expect(viewer.viewer).toBeVisible()
  await expect(viewer.pager).toHaveText('3 of 3')
  const small = await assertTitleAboveImage(longTitle)
  // The image at its own size, with its border, and the title exactly as wide.
  expect(small.image).toMatchObject({ width: 162, height: 102 })
  expect(small.title.width).toBe(162)
  expect(await viewer.title.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true)
  // Never crowds the actions, over on the window's other side.
  expect(small.title.x + small.title.width).toBeLessThanOrEqual(small.actions.x)

  // Wide: the title still shares its left edge and sits above it, at its own (width-capped) size.
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('2 of 3')
  await assertTitleAboveImage('Wide banner')

  // Tall: same, at its own (height-capped) size.
  await window.keyboard.press('ArrowLeft')
  await expect(viewer.pager).toHaveText('1 of 3')
  await assertTitleAboveImage('Tall portrait')

  // At no point on the way was a title in the document off its image.
  expect(await misplaced.jsonValue()).toEqual([])
})
