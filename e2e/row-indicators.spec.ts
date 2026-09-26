// A task row's third line (#290): its todo progress, running subagents and live watchers, each an icon and a count with
// a tooltip, in that order, only while there's some of it; the title and status lines above keep the row's width. Rows
// in every state, from a seed (e2e/seeds/row-indicators.json): none, todos only, watchers only, all three, a long title
// and status, and the Done section's virtual rows, at the sidebar's default width and its narrowest.
import type { Locator, Page } from '@playwright/test'
import { expect, seedPath, test } from './fixtures'
import { resizeHandles, taskList } from './selectors'
import { boxOf, drag } from './window-layout'

/** Layout rounding. */
const SLACK = 0.5

const LONG_TITLE = 'Catch up on the release branch and every open pull request that touches the public API'

/** What each indicator on a row's third line is called, left to right, and its tooltip. */
async function indicatorsOf(row: Locator): Promise<{ name: string | null; title: string | null }[]> {
  return row
    .locator('[data-indicators] > [role="img"]')
    .evaluateAll((items) =>
      items.map((item) => ({ name: item.getAttribute('aria-label'), title: item.getAttribute('title') })),
    )
}

/** Checks a row's lines are laid out as the design has them, at whatever width the sidebar is. */
async function expectLaidOut(row: Locator): Promise<void> {
  const box = await boxOf(row)
  const [titleLine, status] = [row.locator(':scope > span').nth(0), row.locator(':scope > span').nth(1)]
  const title = titleLine.locator(':scope > span').nth(1)
  const time = titleLine.locator(':scope > span').last()
  // The title leaves room for its time, and nothing else sits beside it.
  expect((await boxOf(title)).x + (await boxOf(title)).width).toBeLessThanOrEqual((await boxOf(time)).x + SLACK)
  await expect(time).toHaveText(/^(now|\d+[mhdw])$/)
  // The status has the row's width to itself.
  expect((await boxOf(status)).x + (await boxOf(status)).width).toBeLessThanOrEqual(box.x + box.width + SLACK)
  const line = row.locator('[data-indicators]')
  if ((await line.count()) === 0) return
  // The third line starts where the title and the status's text do, and stays inside the row.
  const first = line.locator(':scope > [role="img"]').first()
  const statusText = await status.evaluate(
    (element) => element.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(element).paddingLeft),
  )
  expect(Math.abs((await boxOf(first)).x - (await boxOf(title)).x)).toBeLessThanOrEqual(SLACK)
  expect(Math.abs(statusText - (await boxOf(title)).x)).toBeLessThanOrEqual(SLACK)
  const last = line.locator(':scope > [role="img"]').last()
  expect((await boxOf(last)).x + (await boxOf(last)).width).toBeLessThanOrEqual(box.x + box.width + SLACK)
  expect((await boxOf(line)).y).toBeGreaterThanOrEqual((await boxOf(status)).y + (await boxOf(status)).height - SLACK)
}

/** Whether a line's text is cut short with an ellipsis. */
async function ellipsized(locator: Locator): Promise<boolean> {
  return locator.evaluate((element) => element.scrollWidth > element.clientWidth)
}

/** Every row of a section, top to bottom, sits below the one before it. */
async function expectStacked(rows: Locator): Promise<void> {
  const boxes = await rows.evaluateAll((items) =>
    items.map((item) => item.getBoundingClientRect()).sort((a, b) => a.top - b.top),
  )
  expect(boxes.length).toBeGreaterThan(1)
  for (const [index, box] of boxes.entries()) {
    const above = boxes[index - 1]
    if (above !== undefined) expect(box.top).toBeGreaterThanOrEqual(above.bottom - SLACK)
  }
}

async function heightOf(locator: Locator): Promise<number> {
  return (await boxOf(locator)).height
}

async function checkRows(window: Page): Promise<void> {
  const list = taskList(window)
  for (const title of [
    'Draft release notes for 2.4',
    'Add rate limiting to public API',
    'Move image uploads to S3',
    'Watch the CI run on PR #42',
    LONG_TITLE,
    'Fix flaky login test',
  ]) {
    await expectLaidOut(list.taskRow(title))
  }
  await expectStacked(list.rows('Active'))
}

test('task rows: todos, running subagents and live watchers on a third line of their own, only while there are some', async ({
  launch,
}) => {
  const { window } = await launch({ seed: seedPath('row-indicators.json') })
  const list = taskList(window)

  // No todo list, no subagents, no watchers: no third line.
  const plain = list.taskRow('Add rate limiting to public API')
  await expect(plain).toBeVisible()
  await expect(list.indicators(plain)).toHaveCount(0)
  await expect(list.indicators(list.taskRow('Fix flaky login test'))).toHaveCount(0)

  // Todos only: the ring and its count, named in full.
  const uploads = list.taskRow('Move image uploads to S3')
  expect(await indicatorsOf(uploads)).toEqual([
    {
      name: '3 of 7 todos done · Now: Copy the 3,900 existing files',
      title: '3 of 7 todos done · Now: Copy the 3,900 existing files',
    },
  ])
  await expect(list.indicators(uploads)).toHaveText('3/7')

  // Watchers only.
  expect(await indicatorsOf(list.taskRow('Watch the CI run on PR #42'))).toEqual([
    { name: '2 watchers running', title: '2 watchers running' },
  ])

  // All three, always todos, subagents, watchers.
  const notes = list.taskRow('Draft release notes for 2.4')
  expect(await indicatorsOf(notes)).toEqual([
    {
      name: '2 of 5 todos done · Now: Write the upgrade guide',
      title: '2 of 5 todos done · Now: Write the upgrade guide',
    },
    { name: '3 subagents running', title: '3 subagents running' },
    { name: '1 watcher running', title: '1 watcher running' },
  ])
  await expect(list.indicators(notes)).toHaveText('2/531')

  // Rows without the line keep the two-line height; those with it are a line taller.
  const twoLines = await heightOf(plain)
  expect(await heightOf(list.taskRow('Fix flaky login test'))).toBe(twoLines)
  const threeLines = await heightOf(uploads)
  expect(threeLines).toBeGreaterThan(twoLines + 10)
  expect(threeLines).toBeLessThan(twoLines + 24)
  expect(await heightOf(notes)).toBe(threeLines)

  // A long title and status stay one line each, cut short, above their own third line.
  const long = list.taskRow(LONG_TITLE)
  expect(await indicatorsOf(long)).toEqual([
    { name: '2 of 11 todos done · Now: Review PR #273', title: '2 of 11 todos done · Now: Review PR #273' },
    { name: '1 subagent running', title: '1 subagent running' },
    { name: '13 watchers running', title: '13 watchers running' },
  ])
  expect(await ellipsized(long.locator(':scope > span').nth(0).locator(':scope > span').nth(1))).toBe(true)
  expect(await ellipsized(long.locator(':scope > span').nth(1))).toBe(true)
  expect(await heightOf(long)).toBe(threeLines)
  await checkRows(window)

  // The Done section's virtual rows, tall and short, each below the last.
  const doneHeader = list.sectionHeader('Done')
  if ((await doneHeader.getAttribute('aria-expanded')) === 'false') await doneHeader.click()
  const django = list.row('Done', 'Upgrade Django to 5.2')
  await expect(list.todoProgress(django)).toHaveAttribute('data-done', 'true')
  expect(await indicatorsOf(list.row('Done', 'Set up nightly backups'))).toEqual([
    { name: '3 of 3 todos done', title: '3 of 3 todos done' },
    { name: '1 watcher running', title: '1 watcher running' },
  ])
  await expect(list.indicators(list.row('Done', 'Investigate slow dashboard query'))).toHaveCount(0)
  expect(await heightOf(list.row('Done', 'Investigate slow dashboard query'))).toBe(twoLines)
  expect(await heightOf(django)).toBe(threeLines)
  await expectStacked(list.rows('Done'))

  // At the sidebar's narrowest, every line still fits its row, and nothing overlaps.
  await drag(window, resizeHandles(window).taskList, -1000, 0)
  await expect.poll(async () => (await boxOf(resizeHandles(window).sidebarSlot)).width).toBe(240)
  await checkRows(window)
  await expectStacked(list.rows('Done'))
  for (const title of ['Upgrade Django to 5.2', 'Set up nightly backups', 'Investigate slow dashboard query']) {
    await expectLaidOut(list.row('Done', title))
  }
})
