import type { Locator } from '@playwright/test'
import { expect, seedPath, test } from './fixtures'
import { taskPanel } from './selectors'

/** How many steps of the resize handle's → narrow the panel from its 440px default to its 320px minimum. */
const STEPS_TO_NARROWEST = 8

/** How much of a tab must show to count as whole: scroll positions can be fractional. */
const WHOLE = 0.99

/** How far a tab may overlap a chevron or the strip's edge and still count as clear of it, for fractional layout. */
const SLACK_PX = 1

/** How far the tab row is scrolled, in CSS pixels. */
async function scrollLeftOf(row: Locator): Promise<number> {
  return row.evaluate((element) => element.scrollLeft)
}

/** Whether `tab` lies wholly inside the tab strip, clear of the chevrons at its ends. */
async function clearOfChevrons(strip: Locator, tab: Locator, chevrons: Locator): Promise<boolean> {
  const stripBox = await strip.boundingBox()
  const tabBox = await tab.boundingBox()
  if (stripBox === null || tabBox === null) return false
  for (const chevron of await chevrons.all()) {
    const box = await chevron.boundingBox()
    const overlap = box === null ? 0 : Math.min(tabBox.x + tabBox.width, box.x + box.width) - Math.max(tabBox.x, box.x)
    if (overlap > SLACK_PX) return false
  }
  return tabBox.x >= stripBox.x - SLACK_PX && tabBox.x + tabBox.width <= stripBox.x + stripBox.width + SLACK_PX
}

test('right panel tabs: a narrow panel scrolls its tabs by chevron and wheel, and brings the chosen tab into view', async ({
  launch,
}) => {
  const { window } = await launch({ seed: seedPath('tool-log.json') })
  const panel = taskPanel(window)
  const row = panel.panel.getByRole('tablist', { name: 'Task panels' })
  const strip = row.locator('..')
  const left = panel.panel.getByRole('button', { name: 'Scroll tabs left' })
  const right = panel.panel.getByRole('button', { name: 'Scroll tabs right' })
  const chevrons = panel.panel.getByRole('button', { name: /^Scroll tabs/ })

  // At its default width every tab fits: no chevrons.
  await expect(panel.tab('Subagents 1')).toBeInViewport({ ratio: WHOLE })
  await expect(chevrons).toHaveCount(0)

  // Narrowed to its minimum, the tabs overflow: a chevron at the right, where the rest are, and no scroll bar.
  await panel.resizeHandle.focus()
  for (let step = 0; step < STEPS_TO_NARROWEST; step++) await window.keyboard.press('ArrowRight')
  await expect.poll(async () => (await panel.panel.boundingBox())?.width).toBe(320)
  await expect(right).toBeVisible()
  await expect(left).toHaveCount(0)
  expect(await row.evaluate((element) => getComputedStyle(element).scrollbarWidth)).toBe('none')
  expect(await row.evaluate((element: HTMLElement) => element.offsetHeight - element.clientHeight)).toBe(0)

  // The right chevron scrolls towards the end, a tab at a time, until there's no more: then only the left one shows.
  const start = await scrollLeftOf(row)
  await right.click()
  await expect.poll(() => scrollLeftOf(row)).toBeGreaterThan(start)
  await expect(left).toBeVisible()
  // (Each click scrolls smoothly, and the chevron goes as the row reaches its end: click until it has.)
  await expect(async () => {
    if ((await right.count()) > 0) await right.click({ timeout: 1000 })
    await expect(right).toHaveCount(0, { timeout: 1000 })
  }).toPass()
  await expect(left).toBeVisible()
  await expect(panel.tab('Subagents 1')).toBeInViewport({ ratio: WHOLE })

  // The wheel turned up scrolls it back to the start, where only the right chevron shows.
  await row.hover()
  await window.mouse.wheel(0, -1000)
  await expect.poll(() => scrollLeftOf(row)).toBe(0)
  await expect(left).toHaveCount(0)
  await expect(right).toBeVisible()

  // Turned down it scrolls to the end; a sideways swipe scrolls it too.
  await window.mouse.wheel(0, 1000)
  await expect(right).toHaveCount(0)
  await window.mouse.wheel(-1000, 0)
  await expect.poll(() => scrollLeftOf(row)).toBe(0)

  // ⌘⌥5 picks Subagents, off past the right edge: the row scrolls it into view, clear of the chevrons.
  await window.keyboard.press('Meta+Alt+Digit5')
  await expect(panel.tab('Subagents 1')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.tab('Subagents 1')).toBeInViewport({ ratio: WHOLE })
  await expect.poll(() => clearOfChevrons(strip, panel.tab('Subagents 1'), chevrons)).toBe(true)

  // ⌘⌥1 picks Tool calls, back at the start: it scrolls back.
  await window.keyboard.press('Meta+Alt+Digit1')
  await expect(panel.tab('Tool calls 6')).toHaveAttribute('aria-selected', 'true')
  await expect(panel.tab('Tool calls 6')).toBeInViewport({ ratio: WHOLE })
  await expect.poll(() => scrollLeftOf(row)).toBe(0)

  // The arrow keys move along the row, each tab scrolling into view as it's picked.
  await panel.tab('Tool calls 6').focus()
  await window.keyboard.press('ArrowLeft')
  await expect(panel.tab('Subagents 1')).toBeFocused()
  await expect.poll(() => clearOfChevrons(strip, panel.tab('Subagents 1'), chevrons)).toBe(true)

  // Widened back past the tabs (the same steps from the minimum, 16px each), the chevrons go.
  await panel.resizeHandle.focus()
  for (let step = 0; step < STEPS_TO_NARROWEST; step++) await window.keyboard.press('ArrowLeft')
  await expect.poll(async () => (await panel.panel.boundingBox())?.width).toBe(448)
  await expect(chevrons).toHaveCount(0)
})
