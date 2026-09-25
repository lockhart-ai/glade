// Motion (docs/design/tokens.md): panels slide open and shut, sections and rows open by height, toasts and the question
// card rise in, menus and popovers fade in, and with Reduce motion on nothing moves. These specs launch the app with
// motion on (every other spec runs with Reduce motion) and check what animated from inside the page (./motion.ts),
// never by timing it: each step waits for the change to land, then reads what ran on the way.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, seedPath, test, type Glade } from './fixtures'
import { durationsOf, runningAnimations, takeMotion, watchMotion, type MotionRecord } from './motion'
import {
  chat,
  contextMenu,
  contextPopover,
  firstRun,
  inputBar,
  panelToggles,
  regions,
  resizeHandles,
  taskHeader,
  taskList,
  taskPanel,
  toasts,
} from './selectors'
import { boxOf } from './window-layout'

/** The motion tokens (src/renderer/tokens.css), in milliseconds. */
const DURATION = 200
const FAST = 120

/** The sidebar's default width (src/renderer/panels/panelSize.ts). */
const SIDEBAR_WIDTH = 300

/** Launches the tool log sample with motion on, watching what animates. */
async function launchMoving(launch: (options: { seed: string; motion: boolean }) => Promise<Glade>): Promise<Page> {
  const { window } = await launch({ seed: seedPath('tool-log.json'), motion: true })
  await expect(taskPanel(window).tab(/^Tool calls/)).toHaveText('Tool calls 7')
  await watchMotion(window)
  return window
}

/** Checks that a change animated `name` once, over `duration`, and nothing else ran for longer. */
function expectAnimated(record: MotionRecord, name: string, duration = DURATION): void {
  expect(durationsOf(record, name)).toEqual([duration])
}

/** Clicks and waits for what the click should bring about, then hands back what animated on the way. */
async function afterClick(window: Page, target: Locator, landed: () => Promise<void>): Promise<MotionRecord> {
  await target.click()
  await landed()
  return takeMotion(window)
}

test('animations: the task list slides shut and open, keeping its width', async ({ launch }) => {
  const window = await launchMoving(launch)
  const { sidebar } = regions(window)
  const toggles = panelToggles(window)

  const shut = await afterClick(window, toggles.collapseTaskList, () => expect(sidebar).toBeHidden())
  expectAnimated(shut, 'panel-close')
  expect(shut.phases).toEqual(['leaving'])
  await expect(toggles.showTaskList).toBeVisible()

  const open = await afterClick(window, toggles.showTaskList, () => expect(sidebar).toBeVisible())
  expectAnimated(open, 'panel-open')
  expect(open.phases).toEqual(['entering'])
  // Once it's in, it's still: its handle is back and it's the width it was.
  await expect(resizeHandles(window).taskList).toBeVisible()
  await expect.poll(async () => (await boxOf(resizeHandles(window).sidebarSlot)).width).toBe(SIDEBAR_WIDTH)
  await expect.poll(async () => (await boxOf(sidebar)).width).toBe(SIDEBAR_WIDTH)
})

test('animations: the right panel slides shut and open', async ({ launch }) => {
  const window = await launchMoving(launch)
  const panel = taskPanel(window)
  const before = await boxOf(panel.panel)

  const shut = await afterClick(window, panel.collapse, () => expect(panel.panel).toBeHidden())
  expectAnimated(shut, 'panel-close')
  expect(shut.phases).toEqual(['leaving'])

  const open = await afterClick(window, taskHeader(window).showSidePanel, () => expect(panel.panel).toBeVisible())
  expectAnimated(open, 'panel-open')
  expect(open.phases).toEqual(['entering'])
  await expect(panel.resizeHandle).toBeVisible()
  await expect.poll(async () => boxOf(panel.panel)).toEqual(before)
})

test('animations: the bottom bar slides shut to its tabs and open again', async ({ launch }) => {
  const window = await launchMoving(launch)
  const toggles = panelToggles(window)
  const slot = resizeHandles(window).bottomBarSlot
  const before = await boxOf(slot)

  const shut = await afterClick(window, toggles.collapseBottomBar, () => expect(toggles.showBottomBar).toBeVisible())
  expectAnimated(shut, 'panel-close')
  expect(shut.phases).toEqual(['leaving'])
  await expect.poll(async () => (await boxOf(slot)).height).toBeLessThan(60)

  const open = await afterClick(window, toggles.showBottomBar, () => expect(toggles.collapseBottomBar).toBeVisible())
  expectAnimated(open, 'panel-open')
  expect(open.phases).toEqual(['entering'])
  await expect(resizeHandles(window).bottomBar).toBeVisible()
  await expect.poll(async () => boxOf(slot)).toEqual(before)
})

test('animations: dragging a handle never waits on an animation', async ({ launch }) => {
  const window = await launchMoving(launch)
  const handle = resizeHandles(window).taskList
  const slot = resizeHandles(window).sidebarSlot
  const box = await boxOf(handle)
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2

  // Mid-drag, the task list is already as wide as the pointer says, and nothing is animating towards it.
  await window.mouse.move(x, y)
  await window.mouse.down()
  await window.mouse.move(x + 40, y, { steps: 4 })
  expect((await boxOf(slot)).width).toBe(SIDEBAR_WIDTH + 40)
  expect(await runningAnimations(window)).toBe(0)
  await window.mouse.move(x + 80, y, { steps: 4 })
  expect((await boxOf(slot)).width).toBe(SIDEBAR_WIDTH + 80)
  await window.mouse.up()
  await expect(regions(window).sidebar).toBeVisible()
  expect((await takeMotion(window)).animations).toEqual([])

  // Collapsing and showing it again slides it back to the width it was dragged to.
  const toggles = panelToggles(window)
  await toggles.collapseTaskList.click()
  await toggles.showTaskList.click()
  await expect(resizeHandles(window).taskList).toBeVisible()
  expect((await boxOf(slot)).width).toBe(SIDEBAR_WIDTH + 80)
})

test('animations: task list sections and tool calls open and close by height', async ({ launch }) => {
  const window = await launchMoving(launch)
  const list = taskList(window)
  const header = list.sectionHeader('Active')
  const rows = list.rows('Active')

  const closed = await afterClick(window, header, () => expect(rows).toHaveCount(0))
  expectAnimated(closed, 'collapse-close')
  const opened = await afterClick(window, header, () => expect(rows).toHaveCount(1))
  expectAnimated(opened, 'collapse-open')

  const panel = taskPanel(window)
  const pytest = panel.call(/Bash pytest api\/tests -q/)
  const output = panel.log.getByLabel('Bash output')
  const expanded = await afterClick(window, pytest, () => expect(output).toContainText('[100%]'))
  expectAnimated(expanded, 'collapse-open')
  const collapsed = await afterClick(window, pytest, () => expect(output).toHaveCount(0))
  expectAnimated(collapsed, 'collapse-close')
})

test('animations: menus and popovers fade in', async ({ launch }) => {
  const window = await launchMoving(launch)
  const menu = contextMenu(window, 'Task actions')
  await taskList(window).rows('Active').first().click({ button: 'right' })
  await expect(menu.menu).toBeVisible()
  expectAnimated(await takeMotion(window), 'menu-in', FAST)
  await window.keyboard.press('Escape')
  await expect(menu.menu).toBeHidden()

  const popover = contextPopover(window)
  const shown = await afterClick(window, inputBar(window).contextButton, () => expect(popover.popover).toBeVisible())
  expectAnimated(shown, 'popover-in', FAST)
})

test('animations: the question card rises in and fades to its answers; the Undo toast rises in and fades out', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'asks-a-question', chosenFolder: root, motion: true })
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
  await watchMotion(window)
  const bar = inputBar(window)
  await bar.field.fill('Draft the release notes for 2.4.')
  await bar.field.press('Enter')

  // Asked while you're looking, the card rises in.
  const { questionCard, closedQuestions, agentReplies } = chat(window)
  await expect(questionCard).toContainText('0 of 4 answered')
  expectAnimated(await takeMotion(window), 'card-in')

  // Answered, it fades to the answers.
  await bar.field.fill('By type, and leave out the internal changes.')
  await bar.field.press('Enter')
  await expect(closedQuestions).toBeVisible()
  await expect(agentReplies).toHaveCount(1)
  expectAnimated(await takeMotion(window), 'card-fade')

  // Mark done's toast rises in; Undo fades it out.
  const toast = toasts(window)
  const done = await afterClick(window, taskHeader(window).markDone, () => expect(toast.undo).toBeVisible())
  expectAnimated(done, 'toast-in')
  const undone = await afterClick(window, toast.undo, () => expect(toast.region).toBeEmpty())
  expectAnimated(undone, 'toast-out')
})

test('animations: with Reduce motion on, nothing moves: every change lands at once', async ({ launch }) => {
  // The default for every spec: the app runs as with macOS's Reduce motion on.
  const { window } = await launch({ seed: seedPath('tool-log.json') })
  await expect(taskPanel(window).tab(/^Tool calls/)).toHaveText('Tool calls 7')
  await watchMotion(window)
  expect(
    await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--motion-duration')),
  ).toBe('0ms')

  const toggles = panelToggles(window)
  await toggles.collapseTaskList.click()
  await expect(regions(window).sidebar).toBeHidden()
  await taskPanel(window).collapse.click()
  await expect(taskPanel(window).panel).toBeHidden()
  await toggles.collapseBottomBar.click()
  await expect(toggles.showBottomBar).toBeVisible()
  await toggles.showTaskList.click()
  await taskHeader(window).showSidePanel.click()
  await toggles.showBottomBar.click()
  await expect(resizeHandles(window).taskList).toBeVisible()
  await expect(taskPanel(window).resizeHandle).toBeVisible()
  await expect(resizeHandles(window).bottomBar).toBeVisible()

  const header = taskList(window).sectionHeader('Active')
  await header.click()
  await expect(taskList(window).rows('Active')).toHaveCount(0)
  await header.click()
  await taskPanel(window)
    .call(/Bash pytest api\/tests -q/)
    .click()
  await expect(taskPanel(window).log.getByLabel('Bash output')).toContainText('[100%]')
  await taskList(window).rows('Active').first().click({ button: 'right' })
  await expect(contextMenu(window, 'Task actions').menu).toBeVisible()

  // No panel ever showed a moving phase, and whatever animation started took no time at all.
  const record = await takeMotion(window)
  expect(record.phases).toEqual([])
  for (const { duration } of record.animations) expect(duration).toBe(0)
  expect(await runningAnimations(window)).toBe(0)
})
