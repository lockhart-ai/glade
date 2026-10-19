// Switching to an unvisited long task stays prompt (#637): the tail is all the switch sends and renders. The switch
// is timed from the DOM click to two `requestAnimationFrame`s after the task's header shows it and its history has
// landed — the way the typing specs time a key — with the two frames catching the first paint of that. The seed is
// the measurement's scale (`../switch-latency-seed`): one workspace, one more long task than the switches and two
// small ones (#654); the window opens on the first long task.
//
// A measurement, not a CI check (Jared, Oct 19, #746: no wall-clock budgets asserted in tests CI runs): CI's
// `../history-tail.spec.ts` keeps the behaviour — the new task's last screenful shows first — without a duration.
// Run it with `GLADE_E2E_STRESS=1 npx playwright test e2e/stress/switch-paint.spec.ts`; it prints the switches'
// median.
import type { Page } from '@playwright/test'
import { expect, test } from '../fixtures'
import { LONG_TASK_TITLES, writeSwitchLatencySeed } from '../switch-latency-seed'
import { taskHeader, taskList } from '../selectors'

/**
 * The slowest a switch to an unvisited long task may be, at the median. CI's runners measured 212 ms once the timer
 * waited for the new task's own rows (#654); the measurement's whole-history switch was 493 ms on a fast Mac, so twice
 * CI's figure still catches a return to rendering everything.
 */
const MEDIAN_LIMIT_MS = 450

/** How many unvisited long tasks the timing round switches to, all in the workspace the window opens on. */
const SWITCHES = 4

/**
 * What this spec seeds: the workspace the window opens on only, one more long task than it switches to and two small
 * ones — nothing medium — so launching stays well inside `firstWindow`'s timeout.
 */
const TAIL_SEED = {
  workspaces: 1,
  longPerWorkspace: SWITCHES + 1,
  mediumPerWorkspace: 0,
  smallPerWorkspace: 2,
}

/** What the page records about one switch: when the click landed, and when the frame after the header showed it did. */
interface SwitchSample {
  at: number
  paint: number | null
}

interface SwitchGlobals {
  __switch?: SwitchSample
}

/** Every switch's time to the screen, in milliseconds, one round's four. */
const times: number[] = []

/**
 * Starts timing the next click in the page: from the DOM click to two `requestAnimationFrame`s after the task's
 * history has landed — the header names it and the chat shows its conversation — with the two frames catching the
 * first paint of that. The header alone would do: the title is in the store before the history arrives.
 */
async function armSwitchTimer(window: Page, target: string): Promise<void> {
  await window.evaluate((goal: string) => {
    const globals = globalThis as unknown as SwitchGlobals
    const conversation = document.querySelector('[role="log"][aria-label="Conversation"]')
    // The first message's element, not its text: every seeded long task's messages read the same (#654), and the chat
    // keys its rows by message id, so the new task's history shows as a new element.
    const showing = conversation?.querySelector('article') ?? null
    globals.__switch = { at: 0, paint: null }
    const sample = globals.__switch
    document.addEventListener(
      'click',
      (event) => {
        sample.at = event.timeStamp
        const waitForHistory = (): void => {
          const heading = document.querySelector('[role="region"][aria-label="Task header"] h1')
          const first = document.querySelector('[role="log"][aria-label="Conversation"] article')
          if (heading?.textContent !== goal || first === null || first === showing) {
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

/** The middle of `sorted` (ascending). */
function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

test.afterAll(() => {
  const medianMs = median(times.slice().sort((a, b) => a - b))
  console.log(
    `[746] switch to an unvisited long task: median ${String(medianMs)} ms over ${String(times.length)} switches ` +
      `[${times.map((ms) => String(Math.round(ms))).join(', ')}]`,
  )
  expect(medianMs).toBeLessThan(MEDIAN_LIMIT_MS)
})

test('switching to an unvisited long task shows its last screenful first, promptly (#637)', async ({
  launch,
  tempFolder,
}) => {
  test.setTimeout(180_000)
  const seed = writeSwitchLatencySeed(tempFolder(), TAIL_SEED)
  const { window } = await launch({ seed })
  const first = LONG_TASK_TITLES[0] ?? ''
  await expect(taskHeader(window).title).toHaveText(first)

  // The tail is what shows: a screenful of each log, not the task's whole history. The Agents tab's count still names
  // every subagent the task ever started, whose calls are sent whole.

  // Switching to long tasks never yet visited stays prompt: the tail is all it sends and renders.
  const unvisited = LONG_TASK_TITLES.slice(1, 1 + SWITCHES)
  for (const title of unvisited) {
    times.push(await timedSwitchTo(window, title))
    await expect(taskHeader(window).title).toHaveText(title)
  }
})
