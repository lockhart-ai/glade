import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, seedPath, test } from './fixtures'
import { chat, firstRun, inputBar, taskHeader, taskList } from './selectors'
import { boxOf, MIN_WINDOW, resize, type Box } from './window-layout'

test('task header: fills in from the agent, pins the task, and marks it done', async ({ launch, tempFolder }) => {
  const root = join(tempFolder(), 'acme-api')
  mkdirSync(root)
  const { window } = await launch({ agentScript: 'multi-tool-turn', chosenFolder: root })
  await firstRun(window).openFolder.click()
  const list = taskList(window)
  await list.newTask.click()

  // A new task's header shows stand-ins until the agent fills it in, and no Mark done yet.
  const header = taskHeader(window)
  await expect(header.title).toHaveText('New task')
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.header).toContainText('created just now')
  await expect(header.field('Objective')).toHaveText('Set by your first message.')
  await expect(header.field('Status')).toHaveText('Nothing yet.')
  await expect(header.markDone).toHaveCount(0)

  const bar = inputBar(window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')

  // The header follows what the agent sets with its Glade tools.
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.field('Objective')).toHaveText('Make the date formatting test pass in every timezone.')
  await expect(header.field('Status')).toHaveText('Fixed the timezone bug; the tests pass. · just now')
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.header).toContainText('started just now')
  // A short title leaves room for all of the title's line: nothing on it truncates.
  for (const item of [header.title, header.pill.locator('span').last(), header.timing]) {
    expect(await item.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false)
  }

  // Pinning moves the task into Pinned.
  await header.pin.click()
  await expect(header.unpin).toHaveAttribute('aria-pressed', 'true')
  await expect(list.rows('Pinned')).toHaveCount(1)
  await expect(list.rows('Pinned').first()).toContainText('Fix the flaky date test')
  await expect(list.rows('Active')).toHaveCount(0)

  // Mark done switches the header to its done presentation: the status is the outcome.
  await header.markDone.click()
  await expect(header.pill).toHaveText(/^Done · [A-Z][a-z]{2} \d{1,2}$/)
  await expect(header.field('Outcome')).toHaveText('Fixed the timezone bug; the tests pass.')
  await expect(header.markDone).toHaveCount(0)
})

/** How far apart two boxes' vertical centres may be and still count as one line. */
const SAME_LINE_TOLERANCE = 2

/** The tallest the title's line may be: the 34px Mark done button, which sets its height. */
const MAX_LINE_HEIGHT = 36

/**
 * The tallest the header may be with two lines each of objective and status: it was about 205px before it was made
 * compact.
 */
const MAX_HEADER_HEIGHT = 165

/** The tallest the header may be in a short window, where the objective and status get one line each. */
const MAX_SHORT_HEADER_HEIGHT = 120

/** The narrowest a truncated title may get in the smallest window, so it never disappears behind the pill. */
const MIN_TITLE_WIDTH = 40

/** One line of objective or status: 14px at a line-height of 1.5. */
const FIELD_LINE_HEIGHT = 21

function centreY(box: Box): number {
  return box.y + box.height / 2
}

/** Whether the element's text runs past its box, so it shows an ellipsis. */
function truncated(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth > element.clientWidth)
}

/** The title, pin, pill, timing and Mark done share one line above the divider; the objective and status are below. */
async function expectOneLineAboveTheFields(window: Page): Promise<void> {
  const header = taskHeader(window)
  const title = await boxOf(header.title)
  for (const item of [header.pin, header.pill, header.timing, header.markDone]) {
    const box = await boxOf(item)
    expect(Math.abs(centreY(box) - centreY(title))).toBeLessThanOrEqual(SAME_LINE_TOLERANCE)
  }
  const heights = await Promise.all([header.title, header.markDone].map(boxOf))
  expect(Math.max(...heights.map((box) => box.height))).toBeLessThanOrEqual(MAX_LINE_HEIGHT)

  // In order along the line: title, pin, pill, then Mark done at the end.
  const along = await Promise.all([header.title, header.pin, header.pill, header.markDone].map(boxOf))
  along.reduce((previous, box) => {
    expect(box.x).toBeGreaterThan(previous.x)
    return box
  })

  // The divider runs between the line and the fields, and the objective comes before the status.
  const fields = header.header.getByRole('group', { name: 'Objective' }).locator('..')
  expect(await fields.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('solid')
  const fieldsBox = await boxOf(fields)
  expect(fieldsBox.y).toBeGreaterThanOrEqual(title.y + title.height)
  const objective = await boxOf(header.field('Objective'))
  const status = await boxOf(header.field('Status'))
  expect(objective.y).toBeGreaterThan(fieldsBox.y)
  expect(status.y).toBeGreaterThan(objective.y)
}

test('task header: one compact line of title, pill and timing, with the objective and status under the divider', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const header = taskHeader(window)
  const pillLabel = header.pill.locator('span').last()
  await expect(header.title).toHaveText(/^Add per-key rate limiting/)

  // A large window: the pill shows whole; the title is too long even here, so it truncates, and the timing gives way
  // before it does. The long objective and status wrap to two lines at most.
  await resize(glade, 1920, 1200)
  await expect(header.pill).toHaveText('Active · waiting on you')
  await expect(header.timing).toHaveText('started 42m ago')
  await expectOneLineAboveTheFields(window)
  expect(await truncated(pillLabel)).toBe(false)
  expect(await truncated(header.title)).toBe(true)
  expect(await truncated(header.timing)).toBe(true)
  expect((await boxOf(header.title)).width).toBeGreaterThan((await boxOf(header.timing)).width)
  expect((await boxOf(header.field('Objective'))).height).toBeLessThanOrEqual(2 * FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.field('Status'))).height).toBeLessThanOrEqual(2 * FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)

  // A short, wide window: one line each of objective and status, so the header is shorter still.
  await resize(glade, 1920, MIN_WINDOW.height)
  await expectOneLineAboveTheFields(window)
  expect((await boxOf(header.field('Objective'))).height).toBeLessThanOrEqual(FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.field('Status'))).height).toBeLessThanOrEqual(FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_SHORT_HEADER_HEIGHT)
  await expect(header.field('Objective')).toHaveAttribute('title', /without a deploy\.$/)
  await expect(header.field('Status')).toHaveAttribute('title', /before finishing\.$/)

  // The smallest window: the line is short of room. The timing gives way first; the title and the pill both truncate
  // with their full text as tooltips, and neither disappears; Mark done stays whole at the end.
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  await expectOneLineAboveTheFields(window)
  expect(await truncated(header.title)).toBe(true)
  await expect(header.title).toHaveAttribute('title', /give the search endpoint its own tighter limit$/)
  expect((await boxOf(header.title)).width).toBeGreaterThanOrEqual(MIN_TITLE_WIDTH)
  await expect(header.pill).toBeVisible()
  await expect(header.pill).toHaveAttribute('title', 'Active · waiting on you')
  expect(await truncated(pillLabel)).toBe(true)
  await expect(header.timing).toHaveAttribute('title', 'started 42m ago')
  await expect(header.markDone).toBeInViewport({ ratio: 1 })
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_SHORT_HEADER_HEIGHT)

  // A narrow, tall window: still one line on top, and the fields get their two lines back.
  await resize(glade, MIN_WINDOW.width, 1200)
  await expectOneLineAboveTheFields(window)
  expect(await truncated(header.title)).toBe(true)
  await expect(header.markDone).toBeInViewport({ ratio: 1 })
  expect((await boxOf(header.field('Objective'))).height).toBeGreaterThan(FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.field('Objective'))).height).toBeLessThanOrEqual(2 * FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)
})

test('task header: a done task keeps the compact line, with its day on the pill and when it ran after it', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const header = taskHeader(window)
  await expect(header.title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, 1920, 1200)
  await header.markDone.click()

  await expect(header.pill).toHaveText(/^Done · [A-Z][a-z]{2} \d{1,2}$/)
  await expect(header.markDone).toHaveCount(0)
  await expect(header.timing).toBeVisible()
  const title = await boxOf(header.title)
  for (const item of [header.pin, header.pill, header.timing]) {
    expect(Math.abs(centreY(await boxOf(item)) - centreY(title))).toBeLessThanOrEqual(SAME_LINE_TOLERANCE)
  }
  expect((await boxOf(header.field('Outcome'))).y).toBeGreaterThan(title.y + title.height)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)
})
