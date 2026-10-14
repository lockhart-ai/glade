// #637 (measurement spike): where the time goes when switching task or workspace in a large installation. Seeds about
// 4 workspaces and 100 tasks (20 with a long history, `./switch-latency-seed`), then switches among them, reading the
// renderer's and main's temporary instrumentation (`src/renderer/perf/*`, `src/main/perf/switch-timing.ts`) after each
// click. Writes the raw numbers and a write-up to /tmp/637-switch-latency/. Not a fix, and no behaviour changes kept;
// `docs/kitten-sop.md`'s stop rule for a spike (measure, don't change) applies throughout.
import { mkdirSync, writeFileSync } from 'node:fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './fixtures'
import { inMain } from './in-main'
import { LONG_TASK_TITLES, writeSwitchLatencySeed } from './switch-latency-seed'
import { taskHeader, taskList, workspaceSwitcher } from './selectors'
import type { SwitchMark } from '../src/renderer/perf/switch-timing'
import type { SwitchRenderRecord } from '../src/renderer/perf/profiler-mark'
import type { CommandTimingRecord, SwitchTimingRecord } from '../src/main/perf/switch-timing'

const OUT_DIR = '/tmp/637-switch-latency'

/**
 * `window` is shadowed in this spec by the Playwright `Page` (`const { window } = glade`, as every spec names it), so
 * a reference to `window` inside an `evaluate` callback would resolve, for the type checker, to that outer closure
 * variable rather than the browser's global — `typing-latency.spec.ts` hits the same thing and casts `globalThis`
 * instead; this does the same.
 */
interface SwitchGlobals {
  __switchMarks?: SwitchMark[]
  __switchRenders?: SwitchRenderRecord[]
  __rowRenders?: Record<string, number>
  /** #637 spike: the "skip an already-cached task's reload" experiment's flag (`src/renderer/perf/switch-timing.ts`). */
  __skipReloadIfCached?: boolean
}

interface MeasuredSwitch {
  readonly kind: 'unvisited' | 'visited' | 'workspace'
  readonly target: string
  /** `dom:click` to `paint:afterClick`, in ms: the brief's "first paint after the click". */
  readonly totalMs: number
  readonly marks: readonly SwitchMark[]
  readonly renders: readonly SwitchRenderRecord[]
  readonly rowRenders: Readonly<Record<string, number>>
  readonly main: SwitchTimingRecord | undefined
  /** `UiStateSet` and `WorkspacesOpen`'s own time in main, if either ran during this click. */
  readonly commands: readonly CommandTimingRecord[]
}

/**
 * The marks that say the store actually applied the switch's new history (`loadHistory` in `src/renderer/store/store.ts`):
 * once one of these shows up, the chat, tool log and todos have the new task's data, and the next two painted frames
 * are its first paint. Unlike typing a key (synchronous, so two `requestAnimationFrame`s right after the keydown catch
 * the one paint that matters, `typing-latency.spec.ts`), a switch's content lands only after an IPC round trip, so
 * scheduling the two frames straight off the click would catch an earlier, unrelated paint instead (confirmed by a
 * first run of this spec: the "paint" mark landed before `loadHistory:invokeEnd`). This polls a frame at a time until
 * one of these marks appears, then schedules the two frames from there.
 */
const UPDATE_MARKS = ['loadHistory:reducerApplied', 'loadHistory:skippedAlreadyCached']

/** Resets both sides' instrumentation, then times one click from the DOM event to two `requestAnimationFrame`s after
 * the store actually applied the switch (see `UPDATE_MARKS`). */
async function measureClick(
  window: Page,
  app: ElectronApplication,
  kind: MeasuredSwitch['kind'],
  target: string,
  click: () => Promise<void>,
): Promise<MeasuredSwitch> {
  await inMain(app, () => {
    globalThis.__switchTimings = []
    globalThis.__commandTimings = []
  })
  await window.evaluate((updateMarks: string[]) => {
    const globals = globalThis as unknown as SwitchGlobals
    globals.__switchMarks = []
    globals.__switchRenders = []
    globals.__rowRenders = {}
    document.addEventListener(
      'click',
      (event) => {
        globals.__switchMarks?.push({ name: 'dom:click', at: event.timeStamp, wallClock: Date.now() })
        const waitForUpdate = (): void => {
          const updated = (globals.__switchMarks ?? []).some(({ name }) => updateMarks.includes(name))
          if (!updated) {
            requestAnimationFrame(waitForUpdate)
            return
          }
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const channel = new MessageChannel()
              channel.port1.onmessage = () => {
                globals.__switchMarks?.push({ name: 'paint:afterClick', at: performance.now(), wallClock: Date.now() })
              }
              channel.port2.postMessage(null)
            })
          })
        }
        requestAnimationFrame(waitForUpdate)
      },
      { capture: true, once: true },
    )
  }, UPDATE_MARKS)
  await click()
  await window.waitForFunction(() =>
    ((globalThis as unknown as SwitchGlobals).__switchMarks ?? []).some(({ name }) => name === 'paint:afterClick'),
  )
  const marks = await window.evaluate(() => (globalThis as unknown as SwitchGlobals).__switchMarks ?? [])
  const renders = await window.evaluate(() => (globalThis as unknown as SwitchGlobals).__switchRenders ?? [])
  const rowRenders = await window.evaluate(() => (globalThis as unknown as SwitchGlobals).__rowRenders ?? {})
  const main = await inMain(app, () => globalThis.__switchTimings ?? [])
  const commands = await inMain(app, () => globalThis.__commandTimings ?? [])
  const clickAt = marks.find(({ name }) => name === 'dom:click')?.at ?? 0
  const paintAt = marks.find(({ name }) => name === 'paint:afterClick')?.at ?? 0
  // A large switch's layout and paint work can run past the two `requestAnimationFrame`s this waits for (a first run
  // of this spec showed a switch's cost bleeding into the next one's marks otherwise): a short settle before the next
  // switch's reset keeps each measurement's steps its own.
  await window.waitForTimeout(300)
  return { kind, target, totalMs: paintAt - clickAt, marks, renders, rowRenders, main: main[0], commands }
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

function worst(values: readonly number[]): number {
  return Math.max(...values)
}

test('switching task or workspace in a large installation (#637 measurement spike)', async ({ launch, tempFolder }) => {
  test.setTimeout(300_000)
  mkdirSync(OUT_DIR, { recursive: true })
  const seed = writeSwitchLatencySeed(tempFolder())
  const { window, app } = await launch({ seed })
  await expect(taskHeader(window).title).toHaveText(LONG_TASK_TITLES[0] ?? '')

  const list = taskList(window)
  const switcher = workspaceSwitcher(window)

  // The pool: 10 distinct long tasks never yet selected, 4 from the opened workspace (Acme API) and 2, 2, 1 from
  // the other three, so the "unvisited" round crosses workspaces while the "visited" and "workspace" rounds don't
  // have to (both tasks they alternate between are in the same two workspaces throughout).
  const pool = [1, 2, 3, 4, 5, 6, 7, 10, 11, 15].map((index) => LONG_TASK_TITLES[index] ?? '')
  const workspaceOf = (title: string): string =>
    pool.indexOf(title) < 4
      ? 'Acme API'
      : pool.indexOf(title) < 7
        ? 'Acme Web'
        : pool.indexOf(title) < 9
          ? 'Acme Mobile'
          : 'Acme Data'

  const toWorkspace = async (name: string): Promise<void> => {
    await switcher.trigger.click()
    if ((await switcher.row(name).getAttribute('aria-checked')) === 'true') {
      await window.keyboard.press('Escape')
      return
    }
    await switcher.row(name).click()
  }

  const switches: MeasuredSwitch[] = []

  // 1. Unvisited: each of the 10 pool tasks, clicked for the first time. A workspace switch to get there (when
  // needed) happens first and isn't timed, so this measures the task switch alone.
  for (const title of pool) {
    await toWorkspace(workspaceOf(title))
    const measured = await measureClick(window, app, 'unvisited', title, () => list.taskRow(title).click())
    await expect(taskHeader(window).title).toHaveText(title)
    switches.push(measured)
  }

  // 2. Visited: alternate between the first two pool tasks, both in Acme API. The unvisited round above ended in
  // Acme Data, so this switches back first, untimed.
  const [a, b] = pool
  if (a === undefined || b === undefined) throw new Error('the pool needs at least two tasks')
  await toWorkspace(workspaceOf(a))
  for (let round = 0; round < 14; round += 1) {
    const title = round % 2 === 0 ? b : a
    const measured = await measureClick(window, app, 'visited', title, () => list.taskRow(title).click())
    await expect(taskHeader(window).title).toHaveText(title)
    // The first 2 rounds are the warm-up: not counted (`docs/kitten-sop.md`'s "measure, don't change" spike still
    // wants a steady state, as the typing-latency spec's own pace does).
    if (round >= 2) switches.push(measured)
  }

  // 3. Workspace: alternate between Acme API and Acme Web, past a warm-up.
  for (let round = 0; round < 14; round += 1) {
    const name = round % 2 === 0 ? 'Acme Web' : 'Acme API'
    const measured = await measureClick(window, app, 'workspace', name, async () => {
      await switcher.trigger.click()
      await switcher.row(name).click()
    })
    if (round >= 2) switches.push(measured)
  }

  // 4. Experiment: skip the reload for a task already in the store (`__skipReloadIfCached`, off by default; see
  // `loadHistory` in `src/renderer/store/store.ts`). Same two tasks as the visited round, same alternation, so it's a
  // fair paired comparison against `switches` filtered to `kind: 'visited'`.
  await window.evaluate(() => {
    ;(globalThis as unknown as SwitchGlobals).__skipReloadIfCached = true
  })
  const skipReloadExperiment: MeasuredSwitch[] = []
  for (let round = 0; round < 10; round += 1) {
    const title = round % 2 === 0 ? b : a
    const measured = await measureClick(window, app, 'visited', title, () => list.taskRow(title).click())
    await expect(taskHeader(window).title).toHaveText(title)
    if (round >= 2) skipReloadExperiment.push(measured)
  }
  await window.evaluate(() => {
    ;(globalThis as unknown as SwitchGlobals).__skipReloadIfCached = false
  })

  // 5. Experiment: cap what `TasksHistory` sends to the last 150 messages and tool events (`__capHistoryMessages`,
  // off by default; see the handler in `src/main/bridge/handlers.ts`). 6 more long tasks, never visited, so this
  // measures a first visit's cost with a far smaller payload, against `switches` filtered to `kind: 'unvisited'`.
  await inMain(app, () => {
    globalThis.__capHistoryMessages = 150
  })
  const capPool = [12, 13, 16, 17, 18, 19].map((index) => LONG_TASK_TITLES[index] ?? '')
  const capWorkspaceOf = (title: string): string => (capPool.indexOf(title) < 2 ? 'Acme Mobile' : 'Acme Data')
  const capExperiment: MeasuredSwitch[] = []
  for (const title of capPool) {
    await toWorkspace(capWorkspaceOf(title))
    const measured = await measureClick(window, app, 'unvisited', title, () => list.taskRow(title).click())
    await expect(taskHeader(window).title).toHaveText(title)
    capExperiment.push(measured)
  }
  await inMain(app, () => {
    globalThis.__capHistoryMessages = undefined
  })

  writeFileSync(`${OUT_DIR}/raw.json`, JSON.stringify(switches, null, 2))
  writeFileSync(`${OUT_DIR}/experiment-skip-reload.json`, JSON.stringify(skipReloadExperiment, null, 2))
  writeFileSync(`${OUT_DIR}/experiment-cap-messages.json`, JSON.stringify(capExperiment, null, 2))

  interface SummaryRow {
    readonly kind: string
    readonly count: number
    readonly medianMs: number
    readonly worstMs: number
  }
  const byKind = (kind: MeasuredSwitch['kind'], from = switches): MeasuredSwitch[] =>
    from.filter((s) => s.kind === kind)
  const summary: SummaryRow[] = (['unvisited', 'visited', 'workspace'] as const).map((kind) => {
    const totals = byKind(kind).map((s) => s.totalMs)
    return { kind, count: totals.length, medianMs: median(totals), worstMs: worst(totals) }
  })
  summary.push({
    kind: 'experiment: skip reload if cached (vs visited)',
    count: skipReloadExperiment.length,
    medianMs: median(skipReloadExperiment.map((s) => s.totalMs)),
    worstMs: worst(skipReloadExperiment.map((s) => s.totalMs)),
  })
  summary.push({
    kind: 'experiment: cap to last 150 (vs unvisited)',
    count: capExperiment.length,
    medianMs: median(capExperiment.map((s) => s.totalMs)),
    worstMs: worst(capExperiment.map((s) => s.totalMs)),
  })
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(summary, null, 2))

  // A loose sanity check, not a budget (the budget is for a later PR, once there's a fix to hold to one): every
  // switch finishes, and main answered `TasksHistory` for every task switch (except the "skip reload" experiment,
  // which deliberately never calls it for an already-cached task).
  for (const s of [...switches, ...capExperiment]) {
    expect(Number.isFinite(s.totalMs)).toBe(true)
    if (s.kind !== 'workspace') expect(s.main).toBeDefined()
  }
  for (const s of skipReloadExperiment) expect(Number.isFinite(s.totalMs)).toBe(true)
})
