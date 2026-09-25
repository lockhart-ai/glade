import type { Locator, Page } from '@playwright/test'
import { expect, seedPath, test } from './fixtures'
import { chooseMenuItem } from './menu'
import { panelToggles, regions, resizeHandles, taskPanel } from './selectors'
import { boxOf, drag, MIN_WINDOW, resize } from './window-layout'

/** The window the e2e app opens at (src/main/e2e.ts), the design's. */
const DESIGN_WINDOW = { width: 1920, height: 1200 } as const

/** The sidebar's and bottom bar's default sizes, and their limits (src/renderer/panels/panelSize.ts). */
const SIDEBAR = { initial: 300, min: 240, max: 520 } as const
const BOTTOM_BAR = { initial: 300, min: 120 } as const

/** The chat's minimum width, the right panel's, and the task card's minimum height. */
const MIN_CHAT_WIDTH = 380
const MIN_PANEL_WIDTH = 320
const MIN_TASK_HEIGHT = 460

/** The window's outer padding and the gaps between its cards (`--space-outer`), and the task card's (`--space-inset`). */
const OUTER = 8
const INSET = 8

/** The title bar row across the top of the window (`--title-bar-height`), in place of the outer padding there. */
const TITLE_BAR_HEIGHT = 32

/** The task card at its narrowest: its border and padding, the chat's minimum, the gap and the right panel's minimum. */
const MIN_TASK_WIDTH = 2 + 2 * INSET + MIN_CHAT_WIDTH + INSET + MIN_PANEL_WIDTH

/** The widest the sidebar can be in a window this wide: all but the task card's minimum and the gaps. */
function sidebarRoom(width: number): number {
  return Math.min(SIDEBAR.max, width - 3 * OUTER - MIN_TASK_WIDTH)
}

/** The tallest the bottom bar can be in a window this tall: all but the title bar row, the task card's minimum and the gaps. */
function bottomBarRoom(height: number): number {
  return height - TITLE_BAR_HEIGHT - 2 * OUTER - MIN_TASK_HEIGHT
}

const widthOf = async (locator: Locator): Promise<number> => (await boxOf(locator)).width
const heightOf = async (locator: Locator): Promise<number> => (await boxOf(locator)).height

/** Waits for the sidebar and the bottom bar to show at these sizes. */
async function expectSizes(window: Page, sidebar: number, bottomBar: number): Promise<void> {
  const slots = resizeHandles(window)
  await expect.poll(() => widthOf(slots.sidebarSlot)).toBe(sidebar)
  await expect.poll(() => heightOf(slots.bottomBarSlot)).toBe(bottomBar)
}

test('resizable panels: dragging the task list’s and bottom bar’s handles resizes them within limits; a relaunch and collapsing keep the sizes', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('tool-log.json') })
  const { window } = glade
  const handles = resizeHandles(window)
  const region = regions(window)
  await expect(taskPanel(window).tab('Tool calls')).toBeVisible()
  await expectSizes(window, SIDEBAR.initial, BOTTOM_BAR.initial)
  await expect(handles.taskList).toHaveAttribute('aria-orientation', 'vertical')
  await expect(handles.bottomBar).toHaveAttribute('aria-orientation', 'horizontal')

  // Dragging the task list's handle right widens it, and the chat gives up the room; the side panel keeps its width.
  const chatBefore = await boxOf(region.chat)
  const panelWidth = await widthOf(region.taskPanel)
  await drag(window, handles.taskList, 100, 0)
  await expectSizes(window, SIDEBAR.initial + 100, BOTTOM_BAR.initial)
  expect(await widthOf(region.sidebar)).toBe(SIDEBAR.initial + 100)
  expect(await widthOf(region.chat)).toBe(chatBefore.width - 100)
  expect(await widthOf(region.taskPanel)).toBe(panelWidth)

  // Dragging the bottom bar's handle up makes it taller, and the chat shorter by as much.
  await drag(window, handles.bottomBar, 0, -100)
  await expectSizes(window, SIDEBAR.initial + 100, BOTTOM_BAR.initial + 100)
  expect(await heightOf(region.terminal)).toBe(BOTTOM_BAR.initial + 100)
  expect(await heightOf(region.chat)).toBe(chatBefore.height - 100)

  // Neither goes past its limits: the task list its own maximum and minimum; the bottom bar its minimum, and up to
  // where the task card keeps its minimum height.
  await drag(window, handles.taskList, 1000, 0)
  await expectSizes(window, SIDEBAR.max, BOTTOM_BAR.initial + 100)
  await drag(window, handles.taskList, -1000, 0)
  await expectSizes(window, SIDEBAR.min, BOTTOM_BAR.initial + 100)
  await drag(window, handles.bottomBar, 0, -2000)
  await expectSizes(window, SIDEBAR.min, bottomBarRoom(DESIGN_WINDOW.height))
  expect(await heightOf(region.task)).toBe(MIN_TASK_HEIGHT)
  await drag(window, handles.bottomBar, 0, 2000)
  await expectSizes(window, SIDEBAR.min, BOTTOM_BAR.min)

  // Focused, the arrow keys along each handle's axis move it a step.
  await drag(window, handles.taskList, 400 - SIDEBAR.min, 0)
  await drag(window, handles.bottomBar, 0, BOTTOM_BAR.min - 400)
  await expectSizes(window, 400, 400)
  await handles.taskList.focus()
  await window.keyboard.press('ArrowRight')
  await handles.bottomBar.focus()
  await window.keyboard.press('ArrowDown')
  await expectSizes(window, 416, 384)

  // A relaunch keeps both sizes.
  await glade.close()
  const relaunched = await launch()
  await expectSizes(relaunched.window, 416, 384)

  // Collapsing each panel and showing it again brings it back at the size you left it; collapsed, the bottom bar has no
  // handle to drag.
  const toggles = panelToggles(relaunched.window)
  const again = resizeHandles(relaunched.window)
  await toggles.collapseTaskList.click()
  await toggles.collapseBottomBar.click()
  await expect(again.taskList).toBeHidden()
  await expect(again.bottomBar).toBeHidden()
  await toggles.showTaskList.click()
  await chooseMenuItem(relaunched, 'View', 'Toggle bottom bar')
  await expectSizes(relaunched.window, 416, 384)
  await expect(again.bottomBar).toBeVisible()
})

test('resizable panels: a smaller window holds the task list and bottom bar to the room there is, the chat keeping its minimum, and a bigger one gives their sizes back', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('tool-log.json') })
  const { window } = glade
  const handles = resizeHandles(window)
  const region = regions(window)
  await expect(taskPanel(window).tab('Tool calls')).toBeVisible()

  // Both as big as they go in the design's window.
  await drag(window, handles.taskList, 1000, 0)
  await drag(window, handles.bottomBar, 0, -2000)
  const tallest = bottomBarRoom(DESIGN_WINDOW.height)
  await expectSizes(window, SIDEBAR.max, tallest)

  // Shrunk to the smallest window, the chat and the side panel keep their minimum widths and the task card its minimum
  // height: the task list and the bottom bar give way.
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  await expectSizes(window, sidebarRoom(MIN_WINDOW.width), bottomBarRoom(MIN_WINDOW.height))
  expect(await widthOf(region.chat)).toBe(MIN_CHAT_WIDTH)
  expect(await widthOf(region.taskPanel)).toBe(MIN_PANEL_WIDTH)
  expect(await heightOf(region.task)).toBe(MIN_TASK_HEIGHT)
  const task = await boxOf(region.task)
  const sidebar = await boxOf(region.sidebar)
  const bottom = await boxOf(region.terminal)
  expect(task.x - (sidebar.x + sidebar.width)).toBe(OUTER)
  expect(task.x + task.width).toBe(MIN_WINDOW.width - OUTER)
  expect(bottom.y - (task.y + task.height)).toBe(OUTER)
  expect(bottom.y + bottom.height).toBe(MIN_WINDOW.height - OUTER)

  // Grown back, they return to the sizes you chose, which the smaller window didn't change.
  await resize(glade, DESIGN_WINDOW.width, DESIGN_WINDOW.height)
  await expectSizes(window, SIDEBAR.max, tallest)

  // In the smallest window, dragging can't take them past the room there is, and a drag starts from the size showing.
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  const narrowest = sidebarRoom(MIN_WINDOW.width)
  const shortest = bottomBarRoom(MIN_WINDOW.height)
  await expectSizes(window, narrowest, shortest)
  await drag(window, handles.taskList, 200, 0)
  await drag(window, handles.bottomBar, 0, -200)
  await expectSizes(window, narrowest, shortest)
  expect(await widthOf(region.chat)).toBe(MIN_CHAT_WIDTH)
  await drag(window, handles.taskList, -50, 0)
  await drag(window, handles.bottomBar, 0, 50)
  await expectSizes(window, narrowest - 50, shortest - 50)
  await drag(window, handles.taskList, -1000, 0)
  await drag(window, handles.bottomBar, 0, 1000)
  await expectSizes(window, SIDEBAR.min, BOTTOM_BAR.min)

  // With the side panel collapsed, the task list can take the room the panel gave up, up to its own maximum.
  await taskPanel(window).collapse.click()
  await drag(window, handles.taskList, 1000, 0)
  await expectSizes(window, SIDEBAR.max, BOTTOM_BAR.min)
  expect(await widthOf(region.chat)).toBeGreaterThanOrEqual(MIN_CHAT_WIDTH)
})
