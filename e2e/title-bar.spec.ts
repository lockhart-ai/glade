import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { firstRun, panelToggles, regions, resizeHandles, taskList } from './selectors'
import { boxOf, MIN_WINDOW, resize, type Box } from './window-layout'

/** The design's sample workspace (scripts/fixtures/task-workspace.json): pinned, active and done tasks, one selected. */
const TASK_WORKSPACE = resolve(__dirname, '../scripts/fixtures/task-workspace.json')

/** The title bar row's height (`--title-bar-height`). */
const TITLE_BAR_HEIGHT = 32

/**
 * The room the three traffic lights take from their position: three buttons 14px wide, 20px apart, 16px tall. The
 * window only knows where they start (`getWindowButtonPosition`), so this rounds their size up a little.
 */
const TRAFFIC_LIGHTS_SIZE = { width: 60, height: 16 } as const

/** The design's window, and the smallest one the app allows. */
const SIZES = [{ width: 1920, height: 1200 }, MIN_WINDOW] as const

/** Layout rounding. */
const SLACK = 0.5

/** Where the window's traffic lights are, in CSS pixels from the page's top-left (the window has no title bar). */
async function trafficLights({ app }: Glade): Promise<Box> {
  const position = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getWindowButtonPosition(),
  )
  if (position === null || position === undefined) throw new Error('The window does not place its traffic lights')
  return { ...position, ...TRAFFIC_LIGHTS_SIZE }
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

/** Points on a grid over a box, `step` apart, edges included. */
function gridOver(box: Box, step: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  for (let x = box.x; x <= box.x + box.width; x += step) {
    for (let y = box.y; y <= box.y + box.height; y += step) points.push({ x: Math.min(x, box.x + box.width - 1), y })
  }
  return points
}

/**
 * The points at which the title bar row isn't the topmost element, or is but doesn't drag the window: something sits
 * over the traffic lights or takes the row's drag there.
 */
async function pointsNotOnTheTitleBar(window: Page, points: { x: number; y: number }[]): Promise<string[]> {
  return window.evaluate((at) => {
    const titleBar = document.querySelector('[data-testid="window-title-bar"]')
    if (titleBar === null) throw new Error('No title bar row')
    return at.flatMap(({ x, y }) => {
      const hit = document.elementFromPoint(x, y)
      if (hit === titleBar && getComputedStyle(hit).getPropertyValue('app-region') === 'drag') return []
      return [`${String(x)},${String(y)}: ${hit === null ? 'nothing' : hit.outerHTML.slice(0, 80)}`]
    })
  }, points)
}

/**
 * The title bar row runs across the top of the window above everything else: the traffic lights sit inside it and
 * nothing overlaps them, the whole row drags the window, and the panels (and the button that shows the task list, while
 * it's collapsed) start below it.
 */
async function expectTitleBarClear(glade: Glade, size: { width: number; height: number }): Promise<void> {
  const { window } = glade
  const area = regions(window)
  const titleBar = await boxOf(area.titleBar)
  expect(titleBar).toEqual({ x: 0, y: 0, width: size.width, height: TITLE_BAR_HEIGHT })

  const lights = await trafficLights(glade)
  expect(lights.x).toBeGreaterThanOrEqual(0)
  expect(lights.y).toBeGreaterThanOrEqual(0)
  expect(lights.y + lights.height).toBeLessThanOrEqual(TITLE_BAR_HEIGHT)
  // Centred in the row, top to bottom.
  expect(lights.y + lights.height / 2).toBeCloseTo(TITLE_BAR_HEIGHT / 2, 0)

  // Nothing sits over the traffic lights, and the row drags the window everywhere across it.
  expect(await pointsNotOnTheTitleBar(window, gridOver(lights, 2))).toEqual([])
  const row = { x: 0, y: 0, width: size.width, height: TITLE_BAR_HEIGHT - 1 }
  expect(await pointsNotOnTheTitleBar(window, gridOver(row, 16))).toEqual([])

  // Every panel, whatever of the task list's controls shows, and the handles that resize the task list and the bottom
  // bar start below the row.
  const handles = resizeHandles(window)
  const below = [area.task, area.terminal, handles.bottomBar]
  if (await area.sidebar.isVisible()) below.push(area.sidebar, panelToggles(window).collapseTaskList, handles.taskList)
  else below.push(panelToggles(window).showTaskList)
  for (const locator of below) {
    const box = await boxOf(locator)
    expect(overlaps(box, lights)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(TITLE_BAR_HEIGHT - SLACK)
  }
}

test('title bar: the traffic lights sit in their own row, clear of everything, with the task list open and collapsed', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await expect(taskList(window).rows('Active')).not.toHaveCount(0)
  const toggles = panelToggles(window)

  for (const size of SIZES) {
    await test.step(`${String(size.width)}×${String(size.height)}`, async () => {
      await resize(glade, size.width, size.height)
      await expect(regions(window).sidebar).toBeVisible()
      await expectTitleBarClear(glade, size)

      // Collapsed from its button, the task list's show button leads the task header, below the row.
      await toggles.collapseTaskList.click()
      await expect(toggles.showTaskList).toBeVisible()
      await expectTitleBarClear(glade, size)

      // And back from the View menu, which toggles it the same way.
      await chooseMenuItem(glade, 'View', 'Toggle task list')
      await expect(regions(window).sidebar).toBeVisible()
      await expectTitleBarClear(glade, size)
      await toggles.collapseTaskList.click()
      await toggles.showTaskList.click()
      await expect(regions(window).sidebar).toBeVisible()
    })
  }

  // The row keeps its place across a relaunch with the task list collapsed.
  await toggles.collapseTaskList.click()
  await glade.close()
  const relaunched = await launch()
  await expect(panelToggles(relaunched.window).showTaskList).toBeVisible()
  await resize(relaunched, MIN_WINDOW.width, MIN_WINDOW.height)
  await expectTitleBarClear(relaunched, MIN_WINDOW)
})

test('title bar: with no task open and the task list collapsed, its show button sits below the row', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  // Before there's a workspace, the welcome screen starts below the row too.
  await expect(firstRun(window).openFolder).toBeVisible()
  await expectWelcomeBelowTitleBar(glade)

  await firstRun(window).openFolder.click()
  const toggles = panelToggles(window)
  await toggles.collapseTaskList.click()
  // With no task, there's no header to hold it: it has a row of its own at the top of the task card.
  const showTaskList = window.getByTestId('task-title-bar').getByRole('button', { name: 'Show task list' })
  await expect(showTaskList).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    await expectTitleBarClear(glade, size)
  }
  await showTaskList.click()
  await expect(regions(window).sidebar).toBeVisible()
  await expectTitleBarClear(glade, MIN_WINDOW)
})

/** On the first-run screen, nothing covers the traffic lights, and the sidebar and welcome start below the row. */
async function expectWelcomeBelowTitleBar(glade: Glade): Promise<void> {
  const { window } = glade
  const lights = await trafficLights(glade)
  expect(await pointsNotOnTheTitleBar(window, gridOver(lights, 2))).toEqual([])
  for (const locator of [regions(window).sidebar, regions(window).welcome, regions(window).terminal]) {
    const box = await boxOf(locator)
    expect(overlaps(box, lights)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(TITLE_BAR_HEIGHT - SLACK)
  }
}
