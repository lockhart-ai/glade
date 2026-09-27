import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import {
  firstRun,
  panelToggles,
  pauseBanner,
  regions,
  relaunchNotice,
  resizeHandles,
  settings,
  taskList,
} from './selectors'
import { boxOf, MIN_WINDOW, resize, type Box } from './window-layout'

/** The design's sample workspace (scripts/fixtures/task-workspace.json): pinned, active and done tasks, one selected. */
const TASK_WORKSPACE = resolve(__dirname, '../scripts/fixtures/task-workspace.json')

/** The same workspace with a task paused by a usage limit, so the app-wide banner shows. */
const USAGE_LIMIT = resolve(__dirname, '../scripts/fixtures/usage-limit.json')

/** The same workspace just after a crash, so the relaunch notice shows. */
const RELAUNCH = resolve(__dirname, '../scripts/fixtures/relaunch.json')

/** The strip at the top of the card in the window's top-left corner (`--title-bar-height`). */
const STRIP_HEIGHT = 28

/**
 * The window's outer inset (`--space-outer`), a top-level card's border, and the lights' inset in the card: on current
 * macOS each light is a 14px circle filling its button, so 7px in from the card's top and left edges centres them in
 * the 28px strip.
 */
const OUTER = 8
const BORDER = 1
const LIGHTS_INSET = 7

/** How big a light is, as current macOS draws it: a circle filling its 14px button. */
const LIGHT_SIZE = 14

/** The corner of a card's inside, in the window's top-left corner: its outer inset and its border. */
const CARD_INSIDE = OUTER + BORDER

/** The radius of a top-level card's inside corners: its 16px, less its border. */
const CARD_CORNER = 16 - BORDER

/**
 * The room the three traffic lights take from their position. On current macOS they're 14px circles, 23px apart, each
 * filling its button; on older ones, 12px circles in 14×16 buttons, 20px apart. The window only knows where they start
 * (`getWindowButtonPosition`), so this covers either.
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

/** Points on a grid over a box, `step` apart, edges included (the far edges a pixel in). */
function gridOver(box: Box, step: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = []
  for (let x = box.x; x <= box.x + box.width; x += step) {
    for (let y = box.y; y <= box.y + box.height; y += step) {
      points.push({ x: Math.min(x, box.x + box.width - 1), y: Math.min(y, box.y + box.height - 1) })
    }
  }
  return points
}

/**
 * The points at which the topmost element isn't one of `testIds` or doesn't drag the window: something sits over the
 * traffic lights, or takes the strip's drag there.
 */
async function pointsNotDragging(
  window: Page,
  testIds: string[],
  points: { x: number; y: number }[],
): Promise<string[]> {
  return window.evaluate(
    ({ ids, at }) =>
      at.flatMap(({ x, y }) => {
        const hit = document.elementFromPoint(x, y)
        const id = hit?.getAttribute('data-testid') ?? ''
        if (hit !== null && ids.includes(id) && getComputedStyle(hit).getPropertyValue('app-region') === 'drag')
          return []
        return [`${String(x)},${String(y)}: ${hit === null ? 'nothing' : hit.outerHTML.slice(0, 80)}`]
      }),
    { ids: testIds, at: points },
  )
}

/**
 * The points at which no element under the pointer drags the window, whatever floats over it (a dialog's backdrop, say,
 * which doesn't take the window's drag regions away: Electron works them out from the page's layout, not what's on
 * top).
 */
async function pointsWithNoDragUnder(window: Page, points: { x: number; y: number }[]): Promise<string[]> {
  return window.evaluate(
    (at) =>
      at.flatMap(({ x, y }) =>
        document
          .elementsFromPoint(x, y)
          .some((element) => getComputedStyle(element).getPropertyValue('app-region') === 'drag')
          ? []
          : [`${String(x)},${String(y)}`],
      ),
    points,
  )
}

/** The one strip for the traffic lights on screen, and the card it's in. */
async function theStrip(window: Page): Promise<{ strip: Box; card: Box }> {
  const strip = regions(window).lightsStrip
  await expect(strip).toHaveCount(1)
  await expect(strip).toBeVisible()
  const card = strip.locator('xpath=ancestor::*[@role="navigation" or @role="main"][1]')
  return { strip: await boxOf(strip), card: await boxOf(card) }
}

/**
 * The traffic lights sit in the strip at the top of the card in the window's top-left corner, 8px inside the card's top
 * and left edges; nothing covers them; the strip and the window's top edge drag the window; and everything else starts
 * clear of them.
 */
async function expectLightsInTheStrip(glade: Glade, size: { width: number; height: number }): Promise<void> {
  const { window } = glade
  const area = regions(window)
  const lights = await trafficLights(glade)
  // Always the same pixels, whichever card holds them.
  expect({ x: lights.x, y: lights.y }).toEqual({ x: CARD_INSIDE + LIGHTS_INSET, y: CARD_INSIDE + LIGHTS_INSET })

  const { strip, card } = await theStrip(window)
  expect(card.x).toBeCloseTo(OUTER, 0)
  expect(card.y).toBeCloseTo(OUTER, 0)
  expect(strip).toEqual({ x: CARD_INSIDE, y: CARD_INSIDE, width: strip.width, height: STRIP_HEIGHT })
  // Centred in the strip, top to bottom, as far in from its left edge as from its top.
  expect(lights.y + LIGHT_SIZE / 2).toBe(strip.y + strip.height / 2)
  expect(lights.x - strip.x).toBe(lights.y - strip.y)
  // Across the sidebar; across the chat column and the gap beside it in the task card, short of the right panel.
  const panelShows = !(await area.sidebar.isVisible()) && (await area.taskPanel.isVisible())
  const right = panelShows ? (await boxOf(area.taskPanel)).x : card.x + card.width - BORDER
  expect(strip.x + strip.width).toBeCloseTo(right, 0)
  expect(lights.y + lights.height).toBeLessThanOrEqual(strip.y + strip.height)

  // Nothing sits over the traffic lights, and the strip drags the window everywhere across it, as the window's top edge
  // above the cards does. (Clear of the card's rounded top corners, which clip the strip: the card's 16px, less its
  // border.)
  expect(await pointsNotDragging(window, ['lights-strip'], gridOver(lights, 2))).toEqual([])
  const inner = { ...strip, x: strip.x + CARD_CORNER, width: strip.width - 2 * CARD_CORNER, height: strip.height - 1 }
  expect(await pointsNotDragging(window, ['lights-strip'], gridOver(inner, 8))).toEqual([])
  const edge = await boxOf(area.topEdge)
  expect(edge).toEqual({ x: 0, y: 0, width: size.width, height: OUTER })
  expect(await pointsNotDragging(window, ['window-top-edge'], gridOver({ ...edge, height: OUTER - 1 }, 16))).toEqual([])

  // Every panel but the strip's own card, the task list's controls and the resize handles keep clear of the lights,
  // and the card's content starts below the strip.
  const handles = resizeHandles(window)
  const clear: Locator[] = [area.terminal, handles.bottomBar]
  const below: Locator[] = []
  if (await area.sidebar.isVisible()) {
    // The task card, or before there's a workspace, the welcome in its place.
    clear.push((await area.task.count()) > 0 ? area.task : area.welcome, handles.taskList)
    // The workspace's box (the switcher, or before there's a workspace, the note in its place). The header around it
    // keeps its top padding, which reaches up under the strip.
    below.push(area.workspace.locator(':scope > :first-child'))
    if (await panelToggles(window).collapseTaskList.isVisible()) below.push(panelToggles(window).collapseTaskList)
  } else {
    below.push(panelToggles(window).showTaskList)
    if (await area.taskHeader.isVisible()) below.push(area.taskHeader)
  }
  for (const locator of clear) expect(overlaps(await boxOf(locator), lights)).toBe(false)
  for (const locator of below) {
    const box = await boxOf(locator)
    expect(overlaps(box, lights)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(strip.y + strip.height - SLACK)
  }
}

test('traffic lights: they sit in the sidebar’s strip, and in the chat column’s with the sidebar collapsed, on the same pixels', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await expect(taskList(window).rows('Active')).not.toHaveCount(0)
  const toggles = panelToggles(window)
  const area = regions(window)

  for (const size of SIZES) {
    await test.step(`${String(size.width)}×${String(size.height)}`, async () => {
      await resize(glade, size.width, size.height)
      await expect(area.sidebar).toBeVisible()
      await expectLightsInTheStrip(glade, size)
      await expect(area.sidebar.getByTestId('lights-strip')).toBeVisible()
      const panel = await boxOf(area.taskPanel)

      // Collapsed from its button, the task card's chat column takes the strip over; its header starts under it, led
      // by Show task list; the right panel stays where it was.
      await toggles.collapseTaskList.click()
      await expect(toggles.showTaskList).toBeVisible()
      await expect(area.task.getByTestId('lights-strip')).toBeVisible()
      await expectLightsInTheStrip(glade, size)
      const header = await boxOf(area.taskHeader)
      const { strip } = await theStrip(window)
      expect(header.y).toBeCloseTo(strip.y + strip.height, 0)
      expect(header.x).toBeCloseTo(strip.x + 8, 0)
      expect((await boxOf(toggles.showTaskList)).y).toBeGreaterThan(header.y)
      expect((await boxOf(area.taskPanel)).y).toBeCloseTo(panel.y, 0)
      expect(overlaps(await boxOf(area.taskPanel), strip)).toBe(false)

      // And back from the View menu, which toggles it the same way.
      await chooseMenuItem(glade, 'View', 'Toggle task list')
      await expect(area.sidebar).toBeVisible()
      await expectLightsInTheStrip(glade, size)
      expect((await boxOf(area.taskPanel)).y).toBeCloseTo(panel.y, 0)
    })
  }

  // The strip keeps its place across a relaunch with the task list collapsed.
  await toggles.collapseTaskList.click()
  await glade.close()
  const relaunched = await launch()
  await expect(panelToggles(relaunched.window).showTaskList).toBeVisible()
  await resize(relaunched, MIN_WINDOW.width, MIN_WINDOW.height)
  await expectLightsInTheStrip(relaunched, MIN_WINDOW)
})

test('traffic lights: the workspace switcher sits under the strip, its box 3px inside the card with a concentric corner', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await resize(glade, 1920, 1200)
  const area = regions(window)
  const switcher = area.workspace.getByRole('button', { name: 'Switch workspace' })
  await switcher.hover()

  const { strip, card } = await theStrip(window)
  const box = await boxOf(switcher)
  // Right under the strip, 3px in from the card's inside on the left, with the nested cards' 12px corner: the card's
  // 16px less its border and those 3px, so the curves share a centre.
  expect(box.y).toBeCloseTo(strip.y + strip.height, 0)
  expect(box.x - (card.x + BORDER)).toBeCloseTo(3, 0)
  const corner = await switcher.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)
  const cardCorner = await area.sidebar.evaluate((element) => getComputedStyle(element).borderTopLeftRadius)
  expect(corner).toBe('12px')
  expect(Number.parseFloat(cardCorner) - BORDER - (box.x - (card.x + BORDER))).toBe(Number.parseFloat(corner))
  // Hovered, it draws its box.
  await expect(switcher).not.toHaveCSS('border-top-color', 'rgba(0, 0, 0, 0)')

  // The collapse button is still beside it, on its row, and still clicks.
  const collapse = await boxOf(panelToggles(window).collapseTaskList)
  expect(collapse.x).toBeGreaterThan(box.x + box.width)
  expect(collapse.y + collapse.height / 2).toBeCloseTo(box.y + box.height / 2, 0)
  // (Its badge still starts on the search field's left edge: alignment.spec.ts checks the sidebar's edges.)
  await panelToggles(window).collapseTaskList.click()
  await expect(panelToggles(window).showTaskList).toBeVisible()
})

test('traffic lights: with no task open and the task list collapsed, the strip leads the row with its show button', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  // Before there's a workspace, the first-run sidebar holds the strip.
  await expect(firstRun(window).openFolder).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    await expectLightsInTheStrip(glade, size)
    expect(overlaps(await boxOf(regions(window).welcome), await trafficLights(glade))).toBe(false)
  }

  await firstRun(window).openFolder.click()
  const toggles = panelToggles(window)
  await toggles.collapseTaskList.click()
  // With no task, there's no header to hold it: it has a row of its own, under the strip.
  const row = window.getByTestId('task-title-bar')
  const showTaskList = row.getByRole('button', { name: 'Show task list' })
  await expect(showTaskList).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    await expectLightsInTheStrip(glade, size)
    const { strip } = await theStrip(window)
    expect((await boxOf(row)).y).toBeCloseTo(strip.y + strip.height, 0)
  }
  await showTaskList.click()
  await expect(regions(window).sidebar).toBeVisible()
  await expectLightsInTheStrip(glade, MIN_WINDOW)
})

test('traffic lights: Settings keeps clear of them, and the strip under it still drags the window', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await expect(taskList(window).rows('Active')).not.toHaveCount(0)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const { dialog } = settings(window)
  await expect(dialog).toBeVisible()
  for (const collapsed of [false, true]) {
    for (const size of SIZES) {
      await resize(glade, size.width, size.height)
      const lights = await trafficLights(glade)
      const box = await boxOf(dialog)
      expect(overlaps(box, lights)).toBe(false)
      expect(box.y).toBeGreaterThanOrEqual(OUTER + STRIP_HEIGHT - SLACK)
      expect(await pointsWithNoDragUnder(window, gridOver(lights, 2))).toEqual([])
    }
    if (!collapsed) {
      // Collapse the task list under Settings from the View menu, and check again with the task card's strip.
      await chooseMenuItem(glade, 'View', 'Toggle task list')
      await expect(regions(window).task.getByTestId('lights-strip')).toHaveCount(1)
    }
  }
})

test('traffic lights: the app-wide banner starts below them, in the window’s draggable top edge, and the strips fold away', async ({
  launch,
}) => {
  const glade = await launch({ seed: USAGE_LIMIT })
  const { window } = glade
  const { banner } = pauseBanner(window)
  await expect(banner).toBeVisible()
  const area = regions(window)
  for (const collapsed of [false, true]) {
    for (const size of SIZES) {
      await resize(glade, size.width, size.height)
      const lights = await trafficLights(glade)
      expect({ x: lights.x, y: lights.y }).toEqual({ x: CARD_INSIDE + LIGHTS_INSET, y: CARD_INSIDE + LIGHTS_INSET })
      // The top edge is as tall as the strip, and the outer inset above it; the banner, and the cards, start below it.
      const edge = await boxOf(area.topEdge)
      expect(edge).toEqual({ x: 0, y: 0, width: size.width, height: OUTER + STRIP_HEIGHT })
      expect(await pointsNotDragging(window, ['window-top-edge'], gridOver(lights, 2))).toEqual([])
      const bannerBox = await boxOf(banner)
      expect(bannerBox.y).toBeCloseTo(edge.height, 0)
      expect(overlaps(bannerBox, lights)).toBe(false)
      await expect(area.lightsStrip).toBeHidden()
      expect((await boxOf(area.task)).y).toBeGreaterThan(bannerBox.y + bannerBox.height)
    }
    if (!collapsed) {
      await panelToggles(window).collapseTaskList.click()
      await expect(panelToggles(window).showTaskList).toBeVisible()
      // The header starts at the top of the task card, as it did with the sidebar open.
      const task = await boxOf(area.task)
      expect((await boxOf(area.taskHeader)).y).toBeCloseTo(task.y + BORDER + 8, 0)
    }
  }
})

test('traffic lights: the relaunch notice sits below the strip', async ({ launch }) => {
  const glade = await launch({ seed: RELAUNCH })
  const { window } = glade
  const { notice } = relaunchNotice(window)
  await expect(notice).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    const box = await boxOf(notice)
    expect(box.y).toBeCloseTo(OUTER + STRIP_HEIGHT + 16, 0)
    expect(overlaps(box, await trafficLights(glade))).toBe(false)
  }
})
