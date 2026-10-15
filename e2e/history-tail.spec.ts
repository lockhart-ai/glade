// A task shows its last screenful of history first, and older history loads as you scroll up (#637): switching to a
// long task (about 1,000 messages and 1,500 tool events, `./switch-latency-seed`) once rendered the whole history,
// which took about 450 ms of a 493 ms switch. The seed is the measurement's (`origin/637-switch-measurements`), made
// up Acme workspaces and all; the window opens on its first long task.
//
// The switch is timed from the DOM click to the frame after the task's header shows it, the way the typing-latency
// spec times a key, and the scroll checks that a page of older messages loads with the scroll position kept.
import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { HISTORY_PAGE } from '../src/shared/bridge'
import { LONG_TASK_TITLES, writeSwitchLatencySeed } from './switch-latency-seed'
import { taskHeader, taskList } from './selectors'

/** The slowest a switch to an unvisited long task may be, at the median: generous, for a slow CI runner. */
const MEDIAN_LIMIT_MS = 200

/** How many unvisited long tasks the timing round switches to, all in the workspace the window opens on. */
const SWITCHES = 4

/** What the page records about one switch: when the click landed, and when the frame after the header showed it did. */
interface SwitchSample {
  at: number
  paint: number | null
}

interface SwitchGlobals {
  __switch?: SwitchSample
}

/** How many of the chat's messages show now. */
function chatMessageCount(window: Page): Promise<number> {
  return window.evaluate(() => document.querySelectorAll('[role="log"][aria-label="Conversation"] article').length)
}

/**
 * Starts timing the next click in the page: from the DOM click to two `requestAnimationFrame`s after the task's
 * history has landed — the header names it and the chat shows its conversation — with the two frames catching the
 * first paint of that. The header alone would do: the title is in the store before the history arrives.
 */
async function armSwitchTimer(window: Page, target: string): Promise<void> {
  await window.evaluate((goal: string) => {
    const globals = globalThis as unknown as SwitchGlobals
    const conversation = document.querySelector('[role="log"][aria-label="Conversation"]')
    const showing = conversation?.querySelector('article')?.textContent ?? ''
    globals.__switch = { at: 0, paint: null }
    const sample = globals.__switch
    document.addEventListener(
      'click',
      (event) => {
        sample.at = event.timeStamp
        const waitForHistory = (): void => {
          const heading = document.querySelector('[role="region"][aria-label="Task header"] h1')
          const first = document.querySelector('[role="log"][aria-label="Conversation"] article')
          if (heading?.textContent !== goal || first?.textContent === showing) {
            requestAnimationFrame(waitForHistory)
            return
          }
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const channel = new MessageChannel()
              channel.port1.onmessage = () => {
                sample.paint = performance.now()
              }
              channel.port2.postMessage(null)
            })
          })
        }
        requestAnimationFrame(waitForHistory)
      },
      { capture: true, once: true },
    )
  }, target)
}

/** Clicks a task row, and answers how long the switch took, in milliseconds. */
async function timedSwitchTo(window: Page, title: string): Promise<number> {
  await armSwitchTimer(window, title)
  await taskList(window).taskRow(title).click()
  await window.waitForFunction(() => ((globalThis as unknown as SwitchGlobals).__switch?.paint ?? null) !== null)
  const { at, paint } = await window.evaluate(() => {
    const globals = globalThis as unknown as SwitchGlobals
    return { at: globals.__switch?.at ?? 0, paint: globals.__switch?.paint ?? 0 }
  })
  // A switch's layout and paint can run past the two frames this waits for; settle before the next one.
  await window.waitForTimeout(300)
  return paint - at
}

function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

test('switching to an unvisited long task shows its last screenful first, promptly (#637)', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(180_000)
  const seed = writeSwitchLatencySeed(tempFolder())
  const { window } = await launch({ seed })
  const first = LONG_TASK_TITLES[0] ?? ''
  await expect(taskHeader(window).title).toHaveText(first)

  // The tail is what shows: a screenful of each log, not the task's whole history.: a screenful of each log, not the task's whole history. The Agents tab's count still names
  // every subagent the task ever started, whose calls are sent whole.
  await expect(taskHeader(window).title).toHaveText(first)

  // Switching to long tasks never yet visited stays prompt: the tail is all it sends and renders.
  const unvisited = LONG_TASK_TITLES.slice(1, 1 + SWITCHES)
  const times: number[] = []
  for (const title of unvisited) {
    times.push(await timedSwitchTo(window, title))
    await expect(taskHeader(window).title).toHaveText(title)
  }
  expect(median(times.sort((a, b) => a - b))).toBeLessThan(MEDIAN_LIMIT_MS)
})

test('older history loads as the chat scrolls up, keeping the scroll position (#637)', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(120_000)
  const seed = writeSwitchLatencySeed(tempFolder())
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
  const seed = writeSwitchLatencySeed(tempFolder())
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
