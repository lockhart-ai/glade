// A task shows its last screenful of history first, and older history loads as you scroll up (#637): switching to a
// long task (about 1,000 messages and 1,500 tool events) once rendered the whole history. The seed is long tasks at
// that scale (`./switch-latency-seed`), but only this spec's own: one workspace, enough long tasks for its switches
// and a couple of small ones (#654); the window opens on the first long task.
//
// How prompt a switch is is measured, not asserted here: the stress spec `./stress/switch-paint.spec.ts` (run with
// `GLADE_E2E_STRESS=1 npx playwright test e2e/stress/switch-paint.spec.ts`) prints the median and holds the budget
// (#746). This spec checks the behaviour: the switch shows the new task's last screenful first, and the scroll checks
// that a page of older messages loads with the scroll position kept.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { HISTORY_PAGE } from '../src/shared/bridge'
import { LONG_TASK_TITLES, writeSwitchLatencySeed } from './switch-latency-seed'
import { taskHeader, taskList } from './selectors'

/** How many unvisited long tasks this spec switches to, all in the workspace the window opens on. */
const SWITCHES = 4

/**
 * What this spec seeds: the workspace the window opens on only, one more long task than it switches to and two small
 * ones — nothing medium — so launching stays well inside `firstWindow`'s timeout on CI (#654).
 */
const TAIL_SEED = {
  workspaces: 1,
  longPerWorkspace: SWITCHES + 1,
  mediumPerWorkspace: 0,
  smallPerWorkspace: 2,
}

/** How many of the chat's messages show now. */
function chatMessageCount(window: Page): Promise<number> {
  return window.evaluate(() => document.querySelectorAll('[role="log"][aria-label="Conversation"] article').length)
}

/**
 * Switches to an unvisited long task and checks its last screenful shows first: the header names it and the chat
 * shows its conversation as a new element. The first message's element, not its text, tells the histories apart —
 * every seeded long task's messages read the same (#654), and the chat keys its rows by message id, so the new task's
 * history shows as a new element; the marker tells which article was first before the click.
 */
async function switchShowsTail(window: Page, title: string): Promise<void> {
  await window.evaluate(() => {
    document.querySelector('[role="log"][aria-label="Conversation"] article')?.setAttribute('data-stale', '')
  })
  await taskList(window).taskRow(title).click()
  await expect(taskHeader(window).title).toHaveText(title)
  await window.waitForFunction(
    () => !document.querySelector('[role="log"][aria-label="Conversation"] article')?.hasAttribute('data-stale'),
  )
}

test('switching to an unvisited long task shows its last screenful first (#637)', async ({ launch, tempFolder }) => {
  test.setTimeout(120_000)
  const seed = writeSwitchLatencySeed(tempFolder(), TAIL_SEED)
  const { window } = await launch({ seed })
  const first = LONG_TASK_TITLES[0] ?? ''
  await expect(taskHeader(window).title).toHaveText(first)

  // The tail is what shows: a screenful of each log, not the task's whole history. The Agents tab's count still names
  // every subagent the task ever started, whose calls are sent whole.

  // Switching to long tasks never yet visited shows the new task's tail, not the old task's conversation.
  const unvisited = LONG_TASK_TITLES.slice(1, 1 + SWITCHES)
  for (const title of unvisited) {
    await switchShowsTail(window, title)
  }
})

test('older history loads as the chat scrolls up, keeping the scroll position (#637)', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeSwitchLatencySeed(tempFolder(), TAIL_SEED)
  const { window } = await launch({ seed })
  const log = window.locator('[role="log"][aria-label="Conversation"]')
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLES[0] ?? '')
  const beforeCount = await chatMessageCount(window)
  expect(beforeCount).toBe(HISTORY_PAGE)

  // 100 px from the top is near enough to load: the scroll brings the first older page in.
  await log.evaluate((element) => {
    element.scrollTop = 100
  })
  await expect.poll(() => chatMessageCount(window)).toBe(beforeCount + HISTORY_PAGE)

  // A second scroll loads the page after that, and the scroll keeps its place: what the page added went in above the
  // viewport, and the scroll moved down by exactly that, so the messages that showed still show.
  const before = await log.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))
  await log.evaluate((element) => {
    element.scrollTop = 100
  })
  await expect.poll(() => chatMessageCount(window)).toBe(beforeCount + 2 * HISTORY_PAGE)
  const after = await log.evaluate((element) => ({ top: element.scrollTop, height: element.scrollHeight }))
  expect(after.height - before.height).toBeGreaterThan(0)
  // The page went in above the viewport's 100 px, and the scroll moved down by exactly what it added.
  expect(Math.abs(after.top - (100 + (after.height - before.height)))).toBeLessThanOrEqual(2)

  // And the chat keeps to the bottom as it was: back down, the newest message shows again.
  await log.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect
    .poll(() => log.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop), {
      timeout: 5_000,
    })
    .toBeLessThanOrEqual(24)
})

test('the tool log pages in the whole log as you scroll its top, with no hole at the carried entries (#637)', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeSwitchLatencySeed(tempFolder(), TAIL_SEED)
  const { window } = await launch({ seed })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLES[0] ?? '')

  // The log holds the tail first (the last screenful of about 1,600 events), with the seed's early Reopened divider
  // and subagent call sent whole however old, far older than it. Paging goes by the tail's own cursor: from the
  // oldest entry the window holds — one of those — would ask before seq 2 and never load what lies between, and the
  // log would stop growing a page into it. So: scroll to the top over and over, and watch the loaded rows grow by
  // about a page each time until the whole log is there, ending at the carried divider.
  const samples = await window.evaluate(async () => {
    const log = document.querySelector<HTMLElement>('[role="log"][aria-label="Tool log"]')
    if (log === null) return { counts: [] as number[], top: '' }
    const count = (): number => log.firstElementChild?.children.length ?? 0
    const counts = [count()]
    for (let round = 0; round < 20; round += 1) {
      const before = count()
      log.scrollTop = 0
      // One scroll loads at most one page; wait for it, or for the end of the log, before looking again.
      const deadline = performance.now() + 5_000
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve))
        if (count() !== before) break
      }
      const after = count()
      counts.push(after)
      if (after === before) break
    }
    const first = log.firstElementChild?.children[0]
    return { counts, top: first?.getAttribute('aria-label') ?? first?.textContent ?? '' }
  })

  // The tail only, then page after page: the count grew over several scrolls, each page about a page of rows — no
  // hole — and the log holds its whole length in the end. The last growth can be short: a partial page, or just the
  // carried entries joining as the cursor passes them.
  expect(samples.counts[0]).toBeLessThan(160)
  expect(samples.counts.length).toBeGreaterThan(5)
  const growths = samples.counts
    .slice(1)
    .map((count, index) => count - (samples.counts[index] ?? 0))
    .filter((growth) => growth > 0)
  for (const growth of growths.slice(0, -1)) {
    expect(growth).toBeGreaterThanOrEqual(50)
  }
  expect(samples.counts.at(-1)).toBeGreaterThan(1_000)
  expect(samples.top).toContain('reopened')
})
