import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Locator, Page } from '@playwright/test'
import { expect, seedPath, test } from './fixtures'
import { chat, firstRun, inputBar, panelToggles, taskHeader, taskList, type TaskHeaderField } from './selectors'
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
  await expect(header.stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(header.age).toHaveText('· now')
  await expect(header.age).toHaveAttribute('title', /^Created [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/)
  await expect(header.field('Goal')).toHaveText('Set by your first message.')
  await expect(header.field('Now')).toHaveText('Nothing yet.')
  await expect(header.statusAge).toHaveCount(0)
  await expect(header.markDone).toHaveCount(0)

  const bar = inputBar(window)
  await bar.field.fill('The date test is flaky. Can you fix it?')
  await bar.field.press('Enter')

  // The header follows what the agent sets with its Glade tools.
  await expect(chat(window).agentReplies).toHaveCount(1)
  await expect(header.title).toHaveText('Fix the flaky date test')
  await expect(header.field('Goal')).toHaveText('Make the date formatting test pass in every timezone.')
  await expect(header.field('Now')).toHaveText('Fixed the timezone bug; the tests pass.')
  await expect(header.statusAge).toHaveText('now')
  await expect(header.stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(header.age).toHaveText('· now')
  await expect(header.age).toHaveAttribute('title', /^Started /)
  // A short title leaves room for all of the title's line: nothing on it truncates.
  for (const item of [header.title, header.age]) {
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
  await expect(header.stateDot).toHaveAccessibleName(/^Done · [A-Z][a-z]{2} \d{1,2}$/)
  await expect(header.stateDot).toHaveAttribute('data-state', 'done')
  await expect(header.field('Outcome')).toHaveText('Fixed the timezone bug; the tests pass.')
  await expect(header.markDone).toHaveCount(0)
})

/** A task in `header-states.json`: its title, the indicator its dot shows, and the state the dot is named by. */
interface StateCase {
  readonly title: string
  readonly indicator: string
  readonly label: string | RegExp
}

const STATES: readonly StateCase[] = [
  { title: 'Move image uploads to S3', indicator: 'working', label: 'Active · working' },
  { title: 'Add rate limiting to public API', indicator: 'waiting', label: 'Active · waiting on you' },
  { title: 'Fix flaky login test', indicator: 'error', label: 'Active · stopped by an error' },
  { title: 'Sync the billing webhooks', indicator: 'working', label: 'Active · paused' },
  { title: 'Investigate slow dashboard query', indicator: 'done', label: /^Done · [A-Z][a-z]{2} \d{1,2}$/ },
]

/** A dot's size and fill as the page draws it. */
function dotLook(locator: Locator): Promise<{ background: string; width: number; height: number }> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
    }
  })
}

test('task header: the state dot matches the sidebar row’s for every state, and is named by it', async ({ launch }) => {
  const { window } = await launch({ seed: seedPath('header-states.json') })
  const header = taskHeader(window)
  const list = taskList(window)
  await expect(header.title).toHaveText('Add rate limiting to public API')
  await list.sectionHeader('Done').click()

  const colours = new Set<string>()
  for (const { title, indicator, label } of STATES) {
    const row = list.taskRow(title)
    await row.click()
    await expect(header.title).toHaveText(title)

    // The same indicator, and so the same colour, as the task's row in the sidebar.
    await expect(header.stateDot).toHaveAttribute('data-state', indicator)
    await expect(list.dot(row)).toHaveAttribute('data-state', indicator)
    const [dot, rowDot] = await Promise.all([dotLook(header.stateDot), dotLook(list.dot(row))])
    expect(dot.background).toBe(rowDot.background)
    colours.add(dot.background)
    expect(dot.width).toBe(10)
    expect(dot.height).toBe(10)

    // No pill: the dot carries the state, as its accessible name and its tooltip.
    await expect(header.stateDot).toHaveRole('img')
    await expect(header.stateDot).toHaveAccessibleName(label)
    const name = await header.stateDot.getAttribute('aria-label')
    await expect(header.stateDot).toHaveAttribute('title', name ?? '')
    await expect(header.header.getByRole('status')).toHaveCount(0)
    await expect(header.header).not.toContainText(name ?? '')

    // The title's line: the dot, the title, then the age.
    const [dotBox, titleBox, ageBox] = await Promise.all([
      boxOf(header.stateDot),
      boxOf(header.title),
      boxOf(header.age),
    ])
    expect(titleBox.x).toBeGreaterThan(dotBox.x + dotBox.width)
    expect(ageBox.x).toBeGreaterThan(titleBox.x + titleBox.width)
  }
  // Working (and paused), waiting, error and done: four colours.
  expect(colours.size).toBe(4)
})

test('task header: the icon buttons are named, have tooltips, and work from the keyboard', async ({ launch }) => {
  const { window } = await launch({ seed: seedPath('header-states.json') })
  const header = taskHeader(window)
  const list = taskList(window)
  await expect(header.title).toHaveText('Add rate limiting to public API')

  // Icon-only, each named by its label with the label as its tooltip.
  await expect(header.pin).toHaveAttribute('title', 'Pin task')
  await expect(header.markDone).toHaveAttribute('title', 'Mark done')
  await expect(header.markDone).toHaveText('')
  const markDoneBox = await boxOf(header.markDone)
  expect(markDoneBox.width).toBe(30)
  expect(markDoneBox.height).toBe(30)
  expect(await header.markDone.evaluate((button) => getComputedStyle(button).borderTopStyle)).toBe('solid')

  // Tab moves from the pin to Mark done; Enter and Space press them.
  await header.pin.focus()
  await window.keyboard.press('Enter')
  await expect(header.unpin).toHaveAttribute('aria-pressed', 'true')
  await expect(header.unpin).toHaveAttribute('title', 'Unpin task')
  await expect(header.unpin).toBeFocused()
  await expect(list.rows('Pinned')).toHaveCount(1)
  await window.keyboard.press('Space')
  await expect(header.pin).toHaveAttribute('aria-pressed', 'false')
  await expect(list.rows('Pinned')).toHaveCount(0)
  await window.keyboard.press('Tab')
  await expect(header.markDone).toBeFocused()
  await window.keyboard.press('Enter')
  await expect(header.stateDot).toHaveAccessibleName(/^Done · /)
  await expect(header.markDone).toHaveCount(0)

  // A working task's Mark done is there but disabled, so it can't be pressed.
  await list.taskRow('Move image uploads to S3').click()
  await expect(header.title).toHaveText('Move image uploads to S3')
  await expect(header.markDone).toBeDisabled()
})

/** How far apart two boxes' vertical centres may be and still count as one line. */
const SAME_LINE_TOLERANCE = 2

/** The tallest the title's line may be: the 30px icon buttons, which set its height. */
const MAX_LINE_HEIGHT = 30

/**
 * The tallest the header may be with two lines each of goal and status: it was about 205px before P9-10 made it
 * compact, and 157px before this layout.
 */
const MAX_HEADER_HEIGHT = 142

/** The tallest the header may be in a short window, where the goal and status get one line each. */
const MAX_SHORT_HEADER_HEIGHT = 100

/** The narrowest a truncated title may get in the smallest window, so it never disappears. */
const MIN_TITLE_WIDTH = 40

/** One line of goal or status: 14px at a line-height of 1.5. */
const FIELD_LINE_HEIGHT = 21

function centreY(box: Box): number {
  return box.y + box.height / 2
}

/** Whether the element's text runs past its box, so it shows an ellipsis. */
function truncated(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth > element.clientWidth)
}

/** How far the rows' labels are set in from the title's left edge, as in Jared's mockup. */
const LABEL_INSET = 8

/** How far the rows' values start from the title's left edge. */
const VALUE_INSET = 68

/**
 * Checks a row's label is set in a little from the title's left edge (not the dot's), and its value starts at the
 * value column.
 */
async function expectRowUnderTitle(window: Page, name: TaskHeaderField, title: Box): Promise<void> {
  const row = taskHeader(window).header.getByRole('group', { name })
  const label = await boxOf(row.locator(':scope > div'))
  const value = await boxOf(row.getByRole('paragraph'))
  expect(Math.abs(label.x - (title.x + LABEL_INSET))).toBeLessThanOrEqual(1)
  expect(Math.abs(value.x - (title.x + VALUE_INSET))).toBeLessThanOrEqual(1)
}

/**
 * The dot, title, age, pin and Mark done share one line; the goal and now rows are below it with no divider, their
 * labels set in from the title (not the dot), and the status's age sits at the right end of the Now row.
 */
async function expectCompactLayout(window: Page): Promise<void> {
  const header = taskHeader(window)
  const title = await boxOf(header.title)
  for (const item of [header.stateDot, header.age, header.pin, header.markDone]) {
    const box = await boxOf(item)
    expect(Math.abs(centreY(box) - centreY(title))).toBeLessThanOrEqual(SAME_LINE_TOLERANCE)
  }
  const heights = await Promise.all([header.title, header.pin, header.markDone].map(boxOf))
  expect(Math.max(...heights.map((box) => box.height))).toBeLessThanOrEqual(MAX_LINE_HEIGHT)

  // In order along the line: dot, title, age, then the pin and Mark done at the end.
  const along = await Promise.all([header.stateDot, header.title, header.age, header.pin, header.markDone].map(boxOf))
  along.reduce((previous, box) => {
    expect(box.x).toBeGreaterThanOrEqual(previous.x + previous.width)
    return box
  })
  const headerBox = await boxOf(header.header)
  const markDone = await boxOf(header.markDone)
  expect(headerBox.x + headerBox.width - (markDone.x + markDone.width)).toBeLessThanOrEqual(18)

  // No divider: the rows come straight after the line, the goal before the status, set in from the title.
  const fields = header.header.getByRole('group', { name: 'Goal' }).locator('..')
  expect(await fields.evaluate((element) => getComputedStyle(element).borderTopStyle)).toBe('none')
  const fieldsBox = await boxOf(fields)
  expect(fieldsBox.y).toBeGreaterThanOrEqual(title.y + title.height)
  const nowRow = await boxOf(header.header.getByRole('group', { name: 'Now' }))
  await expectRowUnderTitle(window, 'Goal', title)
  await expectRowUnderTitle(window, 'Now', title)
  const goal = await boxOf(header.field('Goal'))
  const status = await boxOf(header.field('Now'))
  expect(goal.y).toBeGreaterThanOrEqual(fieldsBox.y)
  expect(status.y).toBeGreaterThan(goal.y)
  expect(goal.x).toBe(status.x)

  // The status's age is right-aligned at the end of the Now row, after the status, on its first line.
  const statusAge = await boxOf(header.statusAge)
  expect(statusAge.x).toBeGreaterThanOrEqual(status.x + status.width)
  expect(Math.abs(nowRow.x + nowRow.width - (statusAge.x + statusAge.width))).toBeLessThanOrEqual(1)
  expect(statusAge.y).toBeLessThan(status.y + FIELD_LINE_HEIGHT)
}

test('task header: one compact line of dot, title and age, with the goal and status below', async ({ launch }) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const header = taskHeader(window)
  await expect(header.title).toHaveText(/^Add per-key rate limiting/)

  // A large window: the long goal and status wrap to two lines at most.
  await resize(glade, 1920, 1200)
  await expect(header.stateDot).toHaveAccessibleName('Active · waiting on you')
  await expect(header.age).toHaveText('· 42m')
  await expect(header.statusAge).toHaveText('4m')
  await expectCompactLayout(window)
  // Without the pill, the long title fits whole here, and so does its age.
  expect(await truncated(header.title)).toBe(false)
  expect(await truncated(header.age)).toBe(false)
  expect((await boxOf(header.field('Goal'))).height).toBeLessThanOrEqual(2 * FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.field('Now'))).height).toBeLessThanOrEqual(2 * FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)

  // A short, wide window: one line each of goal and status, so the header is shorter still.
  await resize(glade, 1920, MIN_WINDOW.height)
  await expectCompactLayout(window)
  expect((await boxOf(header.field('Goal'))).height).toBeLessThanOrEqual(FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.field('Now'))).height).toBeLessThanOrEqual(FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_SHORT_HEADER_HEIGHT)
  await expect(header.field('Goal')).toHaveAttribute('title', /without a deploy\.$/)
  await expect(header.field('Now')).toHaveAttribute('title', /before finishing\.$/)

  // The smallest window: the line is short of room. The age gives way first, keeping its full date as a tooltip; the
  // title truncates with its full text as a tooltip and never disappears; the dot, pin and Mark done stay whole.
  await resize(glade, MIN_WINDOW.width, MIN_WINDOW.height)
  await expectCompactLayout(window)
  expect(await truncated(header.title)).toBe(true)
  expect(await truncated(header.age)).toBe(true)
  expect((await boxOf(header.title)).width).toBeGreaterThan((await boxOf(header.age)).width)
  await expect(header.title).toHaveAttribute('title', /give the search endpoint its own tighter limit$/)
  expect((await boxOf(header.title)).width).toBeGreaterThanOrEqual(MIN_TITLE_WIDTH)
  await expect(header.stateDot).toBeInViewport({ ratio: 1 })
  expect((await boxOf(header.stateDot)).width).toBe(10)
  await expect(header.stateDot).toHaveAttribute('title', 'Active · waiting on you')
  await expect(header.age).toHaveAttribute('title', /^Started [A-Z][a-z]{2} \d{1,2}, \d{4}, \d{1,2}:\d{2} [AP]M$/)
  await expect(header.pin).toBeInViewport({ ratio: 1 })
  await expect(header.markDone).toBeInViewport({ ratio: 1 })
  await expect(header.statusAge).toBeInViewport({ ratio: 1 })
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_SHORT_HEADER_HEIGHT)

  // A narrow, tall window: still one line on top, and the fields get their two lines back.
  await resize(glade, MIN_WINDOW.width, 1200)
  await expectCompactLayout(window)
  expect(await truncated(header.title)).toBe(true)
  await expect(header.markDone).toBeInViewport({ ratio: 1 })
  expect((await boxOf(header.field('Goal'))).height).toBeGreaterThan(FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.field('Goal'))).height).toBeLessThanOrEqual(2 * FIELD_LINE_HEIGHT + 1)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)
})

test('task header: a done task keeps the compact line, with when it ran after the title and its outcome below', async ({
  launch,
}) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const header = taskHeader(window)
  await expect(header.title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, 1920, 1200)
  await header.markDone.click()

  await expect(header.stateDot).toHaveAccessibleName(/^Done · [A-Z][a-z]{2} \d{1,2}$/)
  await expect(header.markDone).toHaveCount(0)
  await expect(header.age).toHaveText(/^· \d{1,2}:\d{2} – \d{1,2}:\d{2}$/)
  await expect(header.age).toHaveAttribute('title', /^Started .* · done /)
  const title = await boxOf(header.title)
  for (const item of [header.stateDot, header.pin, header.age]) {
    expect(Math.abs(centreY(await boxOf(item)) - centreY(title))).toBeLessThanOrEqual(SAME_LINE_TOLERANCE)
  }
  // The pin takes Mark done's place at the end of the line.
  const headerBox = await boxOf(header.header)
  const pin = await boxOf(header.pin)
  expect(headerBox.x + headerBox.width - (pin.x + pin.width)).toBeLessThanOrEqual(18)
  const outcome = header.header.getByRole('group', { name: 'Outcome' })
  expect((await boxOf(header.field('Outcome'))).y).toBeGreaterThan(title.y + title.height)
  await expectRowUnderTitle(window, 'Outcome', title)
  await expect(outcome.locator(':scope > span')).toHaveCount(0)
  expect((await boxOf(header.header)).height).toBeLessThanOrEqual(MAX_HEADER_HEIGHT)
})

test('task header: with the task list collapsed, the rows stay set in from the title', async ({ launch }) => {
  const glade = await launch({ seed: seedPath('long-header.json') })
  const { window } = glade
  const header = taskHeader(window)
  await expect(header.title).toHaveText(/^Add per-key rate limiting/)
  await resize(glade, 1920, 1200)
  await panelToggles(window).collapseTaskList.click()
  await expect(panelToggles(window).showTaskList).toBeVisible()

  const title = await boxOf(header.title)
  await expectRowUnderTitle(window, 'Goal', title)
  await expectRowUnderTitle(window, 'Now', title)
})
