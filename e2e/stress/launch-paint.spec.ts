// Launching on a heavy installation paints the shell promptly (#674): the window's first paint of the workspace,
// task list and opened task's header — and then the conversation filling in — against the owner's rubric of 100 ms
// feeling snappy and 500 ms too slow. A cold boot is timed from the process spawn to the frame the header shows the
// opened task (the shell), and again to the frame the conversation's first article shows (fully loaded), the way the
// #674 paint-timing spike timed it. The medians of three runs pool into one assertion, each run its own fresh seed
// and a real cold boot against it.
//
// What the measurement showed on this Mac (M1 Max): most of a launch is main's own boot (about 0.9 s between the
// database opening and the window being created) and the page load (about 0.2 s); the store's snapshot IPCs are
// about 30 ms and the selected task's history about 50 ms, all inside the first render. The budget is set from
// those numbers with headroom for CI's runners, and catches a launch falling back to waiting on work that doesn't
// belong before the first paint.
//
// A measurement, not a CI check: seeding ~800 tasks blocks main past Playwright's 30 s wait for the window on CI's
// runners, so it lives with the stress specs. Run it with `GLADE_E2E_STRESS=1 npx playwright test e2e/stress/launch-paint.spec.ts`;
// it prints the two medians.
import { expect, test } from '../fixtures'
import { LONG_TASK_TITLES, SPIKE_SIZE, writeSwitchLatencySeed } from '../switch-latency-seed'

/**
 * The slowest a launch may take to paint the shell, or to be fully loaded, at the median over three runs. Measured
 * 1554 ms at the median on this Mac with the window opening before main's boot tail (and 1562 ms on main — the
 * launch total is main's boot, which the reorder doesn't change); about three times that leaves room for CI's
 * runners while still catching a real regression.
 */
const LAUNCH_MEDIAN_LIMIT_MS = 5000

/** How many full passes to pool samples from. Each is a fresh seed and a real cold boot against it. */
const RUNS = 3

/** The header's title is the opened task's own; the shell is painted when it shows. Both the predicate's selector
 * and the title go over as values: a spec constant isn't in the page's scope. */
const HEADER_H1 = '[role="region"][aria-label="Task header"] h1'
/** The conversation's first article; the window is fully loaded when it shows. */
const CONVERSATION_ARTICLE = '[role="log"][aria-label="Conversation"] article'

/** One run's two measurements, from the process spawn. */
interface LaunchSample {
  readonly shellMs: number
  readonly loadedMs: number
}

const samples: LaunchSample[] = []

/** The middle of `sorted` (ascending): three runs' medians land here. */
function median(sorted: readonly number[]): number {
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

test.afterAll(() => {
  const shellMs = median(samples.map(({ shellMs }) => shellMs).sort((a, b) => a - b))
  const loadedMs = median(samples.map(({ loadedMs }) => loadedMs).sort((a, b) => a - b))
  console.log(`[674] launch: shell median ${String(shellMs)} ms, fully loaded median ${String(loadedMs)} ms`)
  expect(shellMs).toBeLessThanOrEqual(LAUNCH_MEDIAN_LIMIT_MS)
  expect(loadedMs).toBeLessThanOrEqual(LAUNCH_MEDIAN_LIMIT_MS)
})

for (let run = 0; run < RUNS; run += 1) {
  test(`launching on a heavy installation paints the shell promptly (#674) [run ${String(run + 1)}/${String(RUNS)}]`, async ({
    launch,
    tempFolder,
  }) => {
    test.setTimeout(300_000)
    const seed = writeSwitchLatencySeed(tempFolder(), SPIKE_SIZE)

    // Builds the seed's database, closed again at once: never timed as "Launch" (a real launch never writes ~190
    // tasks' worth of history into a fresh database the way a spec's seed does).
    const seeding = await launch({ seed })
    await seeding.close()

    // A real cold boot against the already-seeded, heavy database.
    const launchStart = Date.now()
    const { window } = await launch()
    const firstTitle = LONG_TASK_TITLES[0] ?? ''
    await window.waitForFunction(
      ({ selector, title }: { selector: string; title: string }) =>
        document.querySelector(selector)?.textContent === title,
      { selector: HEADER_H1, title: firstTitle },
    )
    const shellMs = Date.now() - launchStart
    await window.locator(CONVERSATION_ARTICLE).first().waitFor()
    samples.push({ shellMs, loadedMs: Date.now() - launchStart })
  })
}
