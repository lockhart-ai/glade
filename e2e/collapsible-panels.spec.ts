import type { Page } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { chat, panelToggles, regions, taskHeader, taskList, taskPanel } from './selectors'
import { boxOf, MIN_WINDOW, resize, type Box } from './window-layout'

/** Which of the three panels are open. */
interface Panels {
  readonly sidebar: boolean
  readonly rightPanel: boolean
  readonly bottomBar: boolean
}

type PanelName = keyof Panels

/** Every combination of open and collapsed, all open first. */
const COMBINATIONS: readonly Panels[] = [0, 1, 2, 3, 4, 5, 6, 7].map((bits) => ({
  sidebar: (bits & 1) === 0,
  rightPanel: (bits & 2) === 0,
  bottomBar: (bits & 4) === 0,
}))

const ALL_OPEN: Panels = { sidebar: true, rightPanel: true, bottomBar: true }

/** The design's window, and the smallest one the app allows. */
const SIZES = [{ width: 1920, height: 1200 }, MIN_WINDOW] as const

/** The View menu's item that toggles each panel (⌘B, ⌘⌥B and ⌘J, which the menu bar answers). */
const TOGGLES: Readonly<Record<PanelName, string>> = {
  sidebar: 'Toggle task list',
  rightPanel: 'Toggle right panel',
  bottomBar: 'Toggle bottom bar',
}

/** The chat keeps at least this much height, whatever is open, in the smallest window. */
const MIN_CHAT_HEIGHT = 80

/** The window's outer padding (`--space-outer`). */
const OUTER = 8

/** The title bar row across the top of the window (`--title-bar-height`), which holds the traffic lights. */
const TITLE_BAR_HEIGHT = 32

/** Layout rounding: boxes may sit this far past an edge and still count as inside it. */
const SLACK = 0.5

function describe(panels: Panels): string {
  const state = (name: PanelName): string => `${name} ${panels[name] ? 'open' : 'collapsed'}`
  return `${state('sidebar')}, ${state('rightPanel')}, ${state('bottomBar')}`
}

/** Whether one box lies within another. */
function within(inner: Box, outer: Box): boolean {
  return (
    inner.x >= outer.x - SLACK &&
    inner.y >= outer.y - SLACK &&
    inner.x + inner.width <= outer.x + outer.width + SLACK &&
    inner.y + inner.height <= outer.y + outer.height + SLACK
  )
}

/** Whether two boxes overlap by more than rounding. */
function overlaps(a: Box, b: Box): boolean {
  return (
    a.x < b.x + b.width - SLACK &&
    b.x < a.x + a.width - SLACK &&
    a.y < b.y + b.height - SLACK &&
    b.y < a.y + a.height - SLACK
  )
}

/** Waits until each panel shows as open or collapsed, and its toggle says so. */
async function expectPanels(window: Page, panels: Panels): Promise<void> {
  const region = regions(window)
  const toggles = panelToggles(window)
  await expect(region.sidebar).toBeVisible({ visible: panels.sidebar })
  await expect(toggles.showTaskList).toBeVisible({ visible: !panels.sidebar })
  await expect(region.taskPanel).toBeVisible({ visible: panels.rightPanel })
  await expect(taskHeader(window).showSidePanel).toBeVisible({ visible: !panels.rightPanel })
  await expect(toggles.collapseBottomBar).toBeVisible({ visible: panels.bottomBar })
  await expect(toggles.showBottomBar).toBeVisible({ visible: !panels.bottomBar })
}

/** Toggles each panel that differs from the View menu, to go from one combination to another. */
async function switchPanels(glade: Glade, from: Panels, to: Panels): Promise<void> {
  for (const name of Object.keys(TOGGLES) as PanelName[]) {
    if (from[name] !== to[name]) await chooseMenuItem(glade, 'View', TOGGLES[name])
  }
  await expectPanels(glade.window, to)
}

/** The chat's size in a combination, to compare how the combinations share the room. */
interface ChatSize {
  readonly width: number
  readonly height: number
}

/**
 * The layout holds in this combination: the regions sit inside the window without overlapping, the task card takes the
 * room the collapsed panels gave up, and the chat keeps room above the input bar, its latest message still in view
 * after the reflow.
 */
async function expectCleanLayout(window: Page, panels: Panels, size: { width: number; height: number }) {
  const region = regions(window)
  const viewport: Box = { x: 0, y: 0, ...size }
  const task = await boxOf(region.task)
  const bottom = await boxOf(region.terminal)
  const header = await boxOf(region.taskHeader)
  const chatBox = await boxOf(region.chat)
  const inputBar = await boxOf(region.inputBar)

  // The window's regions sit inside it, side by side or stacked, never over each other.
  const top = [task, bottom]
  if (panels.sidebar) top.push(await boxOf(region.sidebar))
  for (const box of top) expect(within(box, viewport)).toBe(true)
  for (const [index, box] of top.entries()) {
    for (const other of top.slice(index + 1)) expect(overlaps(box, other)).toBe(false)
  }
  // The task card spans the window without the sidebar, and runs down to the bottom bar, collapsed or not.
  if (!panels.sidebar) expect(task.x).toBeCloseTo(OUTER, 0)
  expect(task.x + task.width).toBeCloseTo(size.width - OUTER, 0)
  expect(bottom.y - (task.y + task.height)).toBeCloseTo(OUTER, 0)
  expect(bottom.y + bottom.height).toBeCloseTo(size.height - OUTER, 0)

  // The header, chat and input bar sit inside the task card, beside the right panel.
  const column = [header, chatBox, inputBar]
  for (const box of column) expect(within(box, task)).toBe(true)
  // The cards start below the title bar row; the button that shows the sidebar again leads the header.
  expect(task.y).toBeCloseTo(TITLE_BAR_HEIGHT, 0)
  if (!panels.sidebar) {
    const showTaskList = await boxOf(panelToggles(window).showTaskList)
    expect(within(showTaskList, header)).toBe(true)
  }
  // The header card floats over the top of the chat, which runs up under it (#252), and the input bar sits below both.
  expect(chatBox.y).toBeLessThanOrEqual(header.y + SLACK)
  expect(chatBox.y + chatBox.height).toBeGreaterThan(header.y + header.height)
  expect(inputBar.y).toBeGreaterThanOrEqual(chatBox.y + chatBox.height - SLACK)
  if (panels.rightPanel) {
    const panel = await boxOf(region.taskPanel)
    expect(within(panel, task)).toBe(true)
    for (const box of column) expect(overlaps(box, panel)).toBe(false)
  }

  // The chat keeps room below the header, and its latest message shows above the input bar.
  expect(chatBox.y + chatBox.height - (header.y + header.height)).toBeGreaterThanOrEqual(MIN_CHAT_HEIGHT)
  const last = chat(window).agentReplies.last()
  await expect(last).toBeInViewport({ ratio: 0.9 })
  const lastBox = await boxOf(last)
  expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(inputBar.y + SLACK)

  return { width: chatBox.width, height: chatBox.height } satisfies ChatSize
}

test('collapsible panels: every combination of the three reflows cleanly, in the design’s window and the smallest', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  await expect(taskHeader(window).title).toHaveText(/^Add per-key rate limiting/)

  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    let current = ALL_OPEN
    const chats = new Map<string, ChatSize>()
    for (const panels of COMBINATIONS) {
      await test.step(`${String(size.width)}×${String(size.height)}: ${describe(panels)}`, async () => {
        await switchPanels(glade, current, panels)
        current = panels
        chats.set(describe(panels), await expectCleanLayout(window, panels, size))
      })
    }

    // Collapsing a panel hands its room to the chat: the side panels their width, the bottom bar its height.
    for (const panels of COMBINATIONS) {
      const chatSize = chats.get(describe(panels))
      if (chatSize === undefined) throw new Error('unreachable')
      const without = (name: PanelName) => chats.get(describe({ ...panels, [name]: false }))
      if (panels.sidebar) expect(without('sidebar')?.width).toBeGreaterThan(chatSize.width)
      if (panels.rightPanel) expect(without('rightPanel')?.width).toBeGreaterThan(chatSize.width)
      if (panels.bottomBar) expect(without('bottomBar')?.height).toBeGreaterThan(chatSize.height)
    }
    await switchPanels(glade, current, ALL_OPEN)
  }
})

test('collapsible panels: the buttons collapse and show each panel, named with their shortcuts; a relaunch keeps them, and ⌘F shows the task list', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const toggles = panelToggles(window)
  await expectPanels(window, ALL_OPEN)

  // Each toggle names its shortcut in its tooltip, and the three share one icon family.
  await expect(toggles.collapseTaskList).toHaveAttribute('title', 'Collapse task list (⌘B)')
  await expect(taskPanel(window).collapse).toHaveAttribute('title', 'Collapse side panel (⌘⌥B)')
  await expect(toggles.collapseBottomBar).toHaveAttribute('title', 'Collapse bottom panel (⌘J)')
  for (const toggle of [toggles.collapseTaskList, taskPanel(window).collapse, toggles.collapseBottomBar]) {
    await expect(toggle.locator('svg')).toHaveAttribute('data-prefix', 'fak')
  }

  // The collapse buttons collapse them; the task card offers the task list back, the header the side panel, and
  // the bottom bar's tab row the rest of the bar.
  await toggles.collapseTaskList.click()
  await taskPanel(window).collapse.click()
  await toggles.collapseBottomBar.click()
  const collapsed: Panels = { sidebar: false, rightPanel: false, bottomBar: false }
  await expectPanels(window, collapsed)
  await expect(toggles.showTaskList).toHaveAttribute('title', 'Show task list (⌘B)')
  await expect(taskHeader(window).showSidePanel).toHaveAttribute('title', 'Show side panel (⌘⌥B)')
  await expect(toggles.showBottomBar).toHaveAttribute('title', 'Show bottom panel (⌘J)')

  // A relaunch keeps them collapsed; the buttons bring them back, and a relaunch keeps that too.
  await glade.close()
  const relaunched = await launch()
  await expectPanels(relaunched.window, collapsed)
  const again = panelToggles(relaunched.window)
  await again.showTaskList.click()
  await again.showBottomBar.click()
  const mixed: Panels = { sidebar: true, rightPanel: false, bottomBar: true }
  await expectPanels(relaunched.window, mixed)
  await relaunched.close()
  const third = await launch()
  await expectPanels(third.window, mixed)

  // ⌘F with the task list collapsed shows it again, with the search field focused.
  await chooseMenuItem(third, 'View', 'Toggle task list')
  await expectPanels(third.window, { ...mixed, sidebar: false })
  await third.window.keyboard.press('Meta+KeyF')
  await expectPanels(third.window, mixed)
  await expect(taskList(third.window).search).toBeFocused()
})
