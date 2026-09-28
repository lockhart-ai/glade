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

/** The strip at the top of the sidebar card (`--title-bar-height`), which holds the lights while it's shown. */
const STRIP_HEIGHT = 28

/**
 * The window's outer inset (`--space-outer`), a top-level card's border, and the lights' inset in the sidebar's strip:
 * on current macOS each light is a 14px circle filling its button, so 7px in from the strip's top and left edges
 * centres them in it.
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

/** The task card's own padding before its content (the header card, or the title row) begins: `--space-inset`. */
const TASK_PADDING = 8

/** The header card's own border, and its padding before its first row begins (`--space-xl`, `--space-md`). */
const HEADER_BORDER = 1
const HEADER_PADDING_X = 16
const HEADER_PADDING_TOP = 8

/** The header's first row's height, set by its icon buttons (Button.module.css's `.icon`). */
const ROW_HEIGHT = 30

/**
 * Where the lights sit once the sidebar is collapsed: in the task header's first row (or the row that shows the task
 * list again, with no task open), rather than a strip (#357). Derived the same way as the open position: the task
 * card's own inset, then the header card's own border and padding, then half the row less half a light, to centre one
 * on it (TRAFFIC_LIGHT_POSITION_COLLAPSED in src/main/app.ts).
 */
const HEADER_LIGHTS = {
  x: CARD_INSIDE + TASK_PADDING + HEADER_BORDER + HEADER_PADDING_X,
  y: CARD_INSIDE + TASK_PADDING + HEADER_BORDER + HEADER_PADDING_TOP + (ROW_HEIGHT - LIGHT_SIZE) / 2,
}

/** The gap between the lights' cluster and whatever follows it (`--space-md`), once a row reserves room for them. */
const LIGHTS_GAP = 8

/** Where the Show task list toggle (or the header's own) starts once it's clear of the lights, in either row. */
const TOGGLE_X = HEADER_LIGHTS.x + 60 + LIGHTS_GAP

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

/** The one strip for the traffic lights on screen (the sidebar's own), and the card it's in. */
async function theStrip(window: Page): Promise<{ strip: Box; card: Box }> {
  const strip = regions(window).lightsStrip
  await expect(strip).toHaveCount(1)
  await expect(strip).toBeVisible()
  const card = strip.locator('xpath=ancestor::*[@role="navigation"][1]')
  return { strip: await boxOf(strip), card: await boxOf(card) }
}

/**
 * The traffic lights sit in the strip at the top of the sidebar card, 8px inside its top and left edges; nothing
 * covers them; the strip and the window's top edge drag the window; and everything else starts clear of them. Unchanged
 * from before #357.
 */
async function expectLightsInSidebarStrip(glade: Glade, size: { width: number; height: number }): Promise<void> {
  const { window } = glade
  const area = regions(window)
  const lights = await trafficLights(glade)
  expect({ x: lights.x, y: lights.y }).toEqual({ x: CARD_INSIDE + LIGHTS_INSET, y: CARD_INSIDE + LIGHTS_INSET })

  const { strip, card } = await theStrip(window)
  expect(card.x).toBeCloseTo(OUTER, 0)
  expect(card.y).toBeCloseTo(OUTER, 0)
  expect(strip).toEqual({ x: CARD_INSIDE, y: CARD_INSIDE, width: strip.width, height: STRIP_HEIGHT })
  // Centred in the strip, top to bottom, as far in from its left edge as from its top.
  expect(lights.y + LIGHT_SIZE / 2).toBe(strip.y + strip.height / 2)
  expect(lights.x - strip.x).toBe(lights.y - strip.y)
  expect(strip.x + strip.width).toBeCloseTo(card.x + card.width - BORDER, 0)
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

  // Every panel but the sidebar itself, the task list's controls and the resize handles keep clear of the lights, and
  // the sidebar's content starts below the strip.
  const handles = resizeHandles(window)
  const clear: Locator[] = [
    area.terminal,
    handles.bottomBar,
    (await area.task.count()) > 0 ? area.task : area.welcome,
    handles.taskList,
  ]
  for (const locator of clear) expect(overlaps(await boxOf(locator), lights)).toBe(false)
  // The workspace's box (the switcher, or before there's a workspace, the note in its place). The header around it
  // keeps its top padding, which reaches up under the strip.
  const below: Locator[] = [area.workspace.locator(':scope > :first-child')]
  if (await panelToggles(window).collapseTaskList.isVisible()) below.push(panelToggles(window).collapseTaskList)
  for (const locator of below) {
    const box = await boxOf(locator)
    expect(overlaps(box, lights)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(strip.y + strip.height - SLACK)
  }
}

/**
 * With the sidebar collapsed and a task open, the lights sit in the header's first row: vertically centred on it,
 * clear of the Show task list toggle, which starts after them with the header's usual padding, then the dot and the
 * title. The header starts at the task card's own inset, like the right panel: no strip above it (#357).
 */
async function expectLightsInHeaderRow(glade: Glade): Promise<void> {
  const { window } = glade
  const area = regions(window)
  const lights = await trafficLights(glade)
  expect({ x: lights.x, y: lights.y }).toEqual(HEADER_LIGHTS)

  const header = await boxOf(area.taskHeader)
  const task = await boxOf(area.task)
  expect(header.x).toBeCloseTo(task.x + BORDER + TASK_PADDING, 0)
  expect(header.y).toBeCloseTo(task.y + BORDER + TASK_PADDING, 0)

  const toggle = panelToggles(window).showTaskList
  await expect(toggle).toBeVisible()
  const toggleBox = await boxOf(toggle)
  expect(toggleBox.x).toBeGreaterThanOrEqual(TOGGLE_X - SLACK)
  // Centred with the lights themselves (14px circles), not the defensive box `trafficLights` reports for older macOS.
  expect(toggleBox.y + toggleBox.height / 2).toBeCloseTo(lights.y + LIGHT_SIZE / 2, 0)
  expect(overlaps(toggleBox, lights)).toBe(false)
  expect(overlaps(await boxOf(area.taskHeader.getByRole('heading', { level: 1 })), lights)).toBe(false)

  // Nothing else sits over them either.
  const handles = resizeHandles(window)
  const clear: Locator[] = [area.terminal, handles.bottomBar, area.chat, area.inputBar]
  if (await area.taskPanel.isVisible()) clear.push(area.taskPanel)
  for (const locator of clear) expect(overlaps(await boxOf(locator), lights)).toBe(false)
}

/**
 * With the sidebar collapsed and no task open, the lights lead the row that shows the task list again: its button
 * starts where the header's would, clear of them; the row still drags the window everywhere but the button.
 */
async function expectLightsInTitleRow(glade: Glade): Promise<void> {
  const { window } = glade
  const lights = await trafficLights(glade)
  expect({ x: lights.x, y: lights.y }).toEqual(HEADER_LIGHTS)

  const toggle = panelToggles(window).showTaskList
  await expect(toggle).toBeVisible()
  const toggleBox = await boxOf(toggle)
  expect(toggleBox.x).toBeGreaterThanOrEqual(TOGGLE_X - SLACK)
  expect(overlaps(toggleBox, lights)).toBe(false)
  // The row is only as tall as its button (30px), so it doesn't quite reach the very bottom rim of the lights'
  // defensive box the way the header's row does: check it drags across their vertical centre, where a light actually
  // is (and where a pointer would land).
  const dragPoints = Array.from({ length: 7 }, (_, i) => ({ x: lights.x + i * 10, y: lights.y + LIGHT_SIZE / 2 }))
  expect(await pointsNotDragging(window, ['task-title-bar'], dragPoints)).toEqual([])
}

test('traffic lights: they sit in the sidebar’s strip while it’s shown, at both sizes', async ({ launch }) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await expect(taskList(window).rows('Active')).not.toHaveCount(0)
  const area = regions(window)

  for (const size of SIZES) {
    await test.step(`${String(size.width)}×${String(size.height)}`, async () => {
      await resize(glade, size.width, size.height)
      await expect(area.sidebar).toBeVisible()
      await expectLightsInSidebarStrip(glade, size)
    })
  }
})

test('traffic lights: collapsed with a task open, they sit in the header’s row, at both sizes, and toggle back the same from the View menu', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  const area = regions(window)
  const panel = await boxOf(area.taskPanel)

  for (const size of SIZES) {
    await test.step(`${String(size.width)}×${String(size.height)}`, async () => {
      await resize(glade, size.width, size.height)
      await panelToggles(window).collapseTaskList.click()
      await expect(area.sidebar).toBeHidden()
      await expect(area.lightsStrip).toHaveCount(0)
      await expectLightsInHeaderRow(glade)
      // Collapsing and expanding the task list doesn't move the right panel.
      expect((await boxOf(area.taskPanel)).y).toBeCloseTo(panel.y, 0)

      await panelToggles(window).showTaskList.click()
      await expect(area.sidebar).toBeVisible()
      await expectLightsInSidebarStrip(glade, size)
    })
  }

  await chooseMenuItem(glade, 'View', 'Toggle task list')
  await expect(area.sidebar).toBeHidden()
  await expectLightsInHeaderRow(glade)
})

test('traffic lights: collapsing moves them once the sidebar has finished leaving; expanding moves them from the start', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE, motion: true })
  const { window } = glade
  const area = regions(window)
  const toggles = panelToggles(window)
  const sidebarLights = { x: CARD_INSIDE + LIGHTS_INSET, y: CARD_INSIDE + LIGHTS_INSET }

  await toggles.collapseTaskList.click()
  // Still sliding shut: the sidebar (and its strip) are still on screen, so the lights haven't moved, or they'd cross
  // the header's content mid-slide. `--motion-duration` (200ms) gates this deterministically: whatever `trafficLights`
  // itself takes to answer, it can't have run yet.
  expect(await trafficLights(glade)).toMatchObject(sidebarLights)
  await expect(area.sidebar).toBeHidden()
  expect(await trafficLights(glade)).toMatchObject(HEADER_LIGHTS)

  await toggles.showTaskList.click()
  // Sliding open: the lights move at once, to where the strip is growing in, before the sidebar is fully back.
  expect(await trafficLights(glade)).toMatchObject(sidebarLights)
  await expect(area.sidebar).toBeVisible()
})

test('traffic lights: relaunching with the task list collapsed starts them in the header’s row', async ({ launch }) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await panelToggles(window).collapseTaskList.click()
  await expect(panelToggles(window).showTaskList).toBeVisible()
  await glade.close()

  const relaunched = await launch()
  await expect(panelToggles(relaunched.window).showTaskList).toBeVisible()
  await expectLightsInHeaderRow(relaunched)
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

test('traffic lights: first-run’s sidebar holds the strip; with no task and the task list collapsed, they lead the row with its show button', async ({
  launch,
  tempFolder,
}) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  // Before there's a workspace, the first-run sidebar holds the strip, as it does with a workspace.
  await expect(firstRun(window).openFolder).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    await expectLightsInSidebarStrip(glade, size)
    expect(overlaps(await boxOf(regions(window).welcome), await trafficLights(glade))).toBe(false)
  }

  await firstRun(window).openFolder.click()
  const toggles = panelToggles(window)
  await toggles.collapseTaskList.click()
  // With no task, there's no header to hold them: they lead a row of their own, above the show button.
  const row = window.getByTestId('task-title-bar')
  const showTaskList = row.getByRole('button', { name: 'Show task list' })
  await expect(showTaskList).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    await expectLightsInTitleRow(glade)
  }
  await showTaskList.click()
  await expect(regions(window).sidebar).toBeVisible()
  await expectLightsInSidebarStrip(glade, MIN_WINDOW)
})

test('traffic lights: Settings keeps clear of them in both states, deeper while the task list is collapsed', async ({
  launch,
}) => {
  const glade = await launch({ seed: TASK_WORKSPACE })
  const { window } = glade
  await expect(taskList(window).rows('Active')).not.toHaveCount(0)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  const { dialog } = settings(window)
  await expect(dialog).toBeVisible()
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    const lights = await trafficLights(glade)
    const box = await boxOf(dialog)
    expect(overlaps(box, lights)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(OUTER + STRIP_HEIGHT - SLACK)
    expect(await pointsWithNoDragUnder(window, gridOver(lights, 2))).toEqual([])
  }

  // Collapse the task list under Settings from the View menu: deeper now, the dialog keeps clear all the same.
  await chooseMenuItem(glade, 'View', 'Toggle task list')
  for (const size of SIZES) {
    await resize(glade, size.width, size.height)
    const lights = await trafficLights(glade)
    expect({ x: lights.x, y: lights.y }).toEqual(HEADER_LIGHTS)
    const box = await boxOf(dialog)
    expect(overlaps(box, lights)).toBe(false)
    expect(box.y).toBeGreaterThanOrEqual(HEADER_LIGHTS.y + TRAFFIC_LIGHTS_SIZE.height - SLACK)
  }
})

test('traffic lights: the app-wide banner starts below them however deep they reach, and the sidebar’s strip folds away', async ({
  launch,
}) => {
  const glade = await launch({ seed: USAGE_LIMIT })
  const { window } = glade
  const { banner } = pauseBanner(window)
  await expect(banner).toBeVisible()
  const area = regions(window)
  for (const collapsed of [false, true]) {
    const expectedPosition = collapsed
      ? HEADER_LIGHTS
      : { x: CARD_INSIDE + LIGHTS_INSET, y: CARD_INSIDE + LIGHTS_INSET }
    const clearHeight = collapsed ? HEADER_LIGHTS.y + TRAFFIC_LIGHTS_SIZE.height : OUTER + STRIP_HEIGHT
    for (const size of SIZES) {
      await resize(glade, size.width, size.height)
      const lights = await trafficLights(glade)
      expect({ x: lights.x, y: lights.y }).toEqual(expectedPosition)
      // The top edge is as deep as the lights currently reach; the banner, and the cards, start below it.
      const edge = await boxOf(area.topEdge)
      expect(edge).toEqual({ x: 0, y: 0, width: size.width, height: clearHeight })
      const bannerBox = await boxOf(banner)
      expect(bannerBox.y).toBeCloseTo(edge.height, 0)
      expect(overlaps(bannerBox, lights)).toBe(false)
      if (!collapsed) {
        expect(await pointsNotDragging(window, ['window-top-edge'], gridOver(lights, 2))).toEqual([])
        await expect(area.lightsStrip).toBeHidden()
      }
      const task = await boxOf(area.task)
      expect(task.y).toBeGreaterThan(bannerBox.y + bannerBox.height)
      // The header still starts right at the task card's own inset, whether the sidebar is collapsed or not: no strip
      // above it (#357).
      expect(task.y + BORDER + TASK_PADDING).toBeCloseTo((await boxOf(area.taskHeader)).y, 0)
    }
    if (!collapsed) {
      await panelToggles(window).collapseTaskList.click()
      await expect(panelToggles(window).showTaskList).toBeVisible()
    }
  }
})

test('traffic lights: the relaunch notice sits below them, deeper while the task list is collapsed', async ({
  launch,
}) => {
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

  await panelToggles(window).collapseTaskList.click()
  await expect(panelToggles(window).showTaskList).toBeVisible()
  const box = await boxOf(notice)
  expect(box.y).toBeCloseTo(HEADER_LIGHTS.y + TRAFFIC_LIGHTS_SIZE.height + 16, 0)
  expect(overlaps(box, await trafficLights(glade))).toBe(false)
})
