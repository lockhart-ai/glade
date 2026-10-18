// #674: find the biggest waits between a user's action and the first paint of what they asked for, across every
// view, on a heavy installation (several workspaces, ~190 tasks, 20+ with a thousand-message history, subagents,
// artifacts, todos, commits and files — `e2e/switch-latency-seed.ts`'s `SPIKE_SIZE`), judged against the owner's
// rubric: 100 ms feels snappy, 500 ms is too slow.
//
// Each action is timed twice: `firstPaintMs` (the click or key to the frame after the result's own content showed)
// and `fullyLoadedMs` (to the frame after nothing more loads on its own) — `e2e/paint-timing.ts`'s generic version of
// `e2e/history-tail.spec.ts`'s `__switch` timer. The whole pass runs `RUNS` times, each its own fresh seed and a
// real cold boot against it (the seed's own launch is never timed as "Launch": it includes writing ~190 tasks' worth
// of history into SQLite, which no real launch ever does), and every sample from every run pools into one results
// file, so a shell loop (or several `npx playwright test` invocations) can run this spec several times and still
// end with one combined report to take medians from.
//
// Not a fix: nothing here changes what ships. `src/main/perf/history-timing.ts` adds one piece of main-side timing,
// guarded to `GLADE_E2E`, to see what `TasksHistory` itself spends listing a long task's whole log before slicing it
// down to the page it sends — the part of a task switch a renderer-side timer can't see.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test, type Glade } from './fixtures'
import { inMain } from './in-main'
import { chooseMenuItem } from './menu'
import { timeClick, timeKeyPress, timeMenuAction, type PaintSample } from './paint-timing'
import {
  agentsTab,
  broadcastDialog,
  filesTab,
  regions,
  settings,
  taskHeader,
  taskList,
  taskPanel,
  workspaceSwitcher,
} from './selectors'
import { LONG_TASK_TITLES, SPIKE_SIZE, WORKSPACES, writeSwitchLatencySeed } from './switch-latency-seed'

/** How many full passes to pool samples from. Each is a fresh seed, a real cold boot, and every other action once
 * or a few times; three keeps a run of this spec itself well under its own timeout while still giving a real
 * median rather than one sample per action. */
const RUNS = 3

const RESULTS_DIR = '/tmp/674-paint-timings'
const RESULTS_FILE = join(RESULTS_DIR, 'results.json')

type ResultsMap = Record<string, PaintSample[]>

function loadResults(): ResultsMap {
  if (!existsSync(RESULTS_FILE)) return {}
  return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as ResultsMap
}

function saveResults(results: ResultsMap): void {
  mkdirSync(RESULTS_DIR, { recursive: true })
  writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2))
}

function record(results: ResultsMap, key: string, sample: PaintSample): void {
  ;(results[key] ??= []).push(sample)

  console.log(`[674] ${key}: paint ${sample.firstPaintMs.toFixed(0)}ms, loaded ${sample.fullyLoadedMs.toFixed(0)}ms`)
}

const HEADER_H1 = '[role="region"][aria-label="Task header"] h1'
const CONVERSATION_ARTICLE = '[role="log"][aria-label="Conversation"] article'

/** The header's title is the new task's own; sufficient on its own (every seeded task's title is distinct, #654). */
function headerIs(title: string): string {
  return `document.querySelector(${JSON.stringify(HEADER_H1)})?.textContent === ${JSON.stringify(title)}`
}

/** Writes the seed, then a real file at `docs/reports/billing-1.md` under its rootPath (the selected long task's
 * own first artifact: `withExtras`' `area(0)` is `billing`), so "opening a file" is a genuine disk read, not a miss
 * on a made-up Acme path nothing on this Mac ever created (as every other spec that opens a real file does,
 * `e2e/files.spec.ts`'s own `workspace` helper). */
function writeSeedWithARealFile(folder: string): { seed: string; openablePath: string } {
  const root = join(folder, 'acme-api-674')
  // The Files tab's "All files" menu lists files a tool *call* touched (`Read`/`Bash`, `historyTask`'s plain and
  // subagent loops), never a plain artifact's own path — `billing/client.py` is one every long task's subagent
  // loop reads (#674's own gotcha: the two are easy to mix up, since both are made-up Acme paths).
  mkdirSync(join(root, 'billing'), { recursive: true })
  const openablePath = 'billing/client.py'
  writeFileSync(join(root, openablePath), 'import requests\n\n\ndef retry(request, attempts=3):\n    pass\n')
  const seed = writeSwitchLatencySeed(folder, SPIKE_SIZE)
  const raw = JSON.parse(readFileSync(seed, 'utf8')) as { workspace: { rootPath: string } }
  raw.workspace.rootPath = root
  writeFileSync(seed, JSON.stringify(raw))
  return { seed, openablePath }
}

/** `src/main/perf/history-timing.ts`'s own record shape, duplicated here rather than imported so this spec stays
 * inside `tsconfig.e2e.json`'s own file set (which lists main's files individually, `src/main/perf` not among
 * them) instead of reaching across it for a type only `inMain`'s untyped `globalThis.eval` ever needs. */
interface HistoryTimingRecord {
  readonly taskId: string
  readonly messageCount: number
  readonly eventCount: number
  readonly listMessagesMs: number
  readonly listToolEventsMs: number
  readonly totalMs: number
}

/** `TasksHistory`'s own main-side timing for the task just switched to (`recordHistoryTiming`), if any landed. */
async function lastHistoryTiming(app: ElectronApplication): Promise<HistoryTimingRecord | null> {
  const timings = await inMain(
    app,
    () => (globalThis as unknown as { __historyTimings?: HistoryTimingRecord[] }).__historyTimings ?? [],
  )
  return timings.at(-1) ?? null
}

// One `test()` per run, not a loop inside one: the `launch` fixture's `userData` is fixed for a whole test (so a
// spec can close the app and relaunch it on the *same* data, `fixtures.ts`), so a loop in one test would reseed the
// previous run's own database instead of starting fresh — which crashed main outright once seeding ran twice
// (`electronApplication.firstWindow: Target page, context or browser has been closed` on the very next launch).
// Separate tests give each run its own fixture instance, and so its own fresh database, for free.
for (let run = 0; run < RUNS; run += 1) {
  test(`paint timing across every view, on a heavy installation (#674) [run ${String(run + 1)}/${String(RUNS)}]`, async ({
    launch,
    tempFolder,
  }) => {
    test.setTimeout(10 * 60_000)
    const results = loadResults()
    const folder = tempFolder()
    const { seed, openablePath } = writeSeedWithARealFile(folder)

    // Builds the seed's database, closed again at once: never timed as "Launch" (a real launch never writes ~190
    // tasks' history into a fresh database the way a spec's seed does).
    const seeding = await launch({ seed })
    await seeding.close()

    // Launch: a real cold boot against the already-seeded, heavy database. First paint is the opened task's header
    // and chat tail; fully loaded is the same in this app (the whole response lands in one round trip — #637).
    const launchStart = Date.now()
    const glade = await launch()
    const { app, window } = glade
    const firstTitle = LONG_TASK_TITLES[0] ?? ''
    await window.waitForFunction(headerIs(firstTitle))
    await window.waitForFunction(`document.querySelector(${JSON.stringify(CONVERSATION_ARTICLE)}) !== null`)
    const launchPaintAt = Date.now()
    record(results, 'Launch (cold boot, heavy database)', {
      firstPaintMs: launchPaintAt - launchStart,
      fullyLoadedMs: launchPaintAt - launchStart,
    })

    await measureTaskAndWorkspaceSwitches(window, app, results)
    await measurePanelTabs(window, results)
    await measureFile(window, openablePath, results)
    await measureDoneList(window, results)
    await measureSearch(window, results)
    await measureSettingsAndBroadcast(glade, window, results)

    await glade.close()
    saveResults(results)

    // The report is read from RESULTS_FILE by hand; this just keeps the spec from being "no assertions".
    expect(Object.keys(results).length).toBeGreaterThan(0)
  })
}

/** Task switch, cold (never visited this session) and warm (already loaded), then the workspace switcher's own
 * menu and a workspace switch. */
async function measureTaskAndWorkspaceSwitches(
  window: Page,
  app: ElectronApplication,
  results: ResultsMap,
): Promise<void> {
  const list = taskList(window)
  const cold = LONG_TASK_TITLES.slice(1, 4)
  for (const title of cold) {
    const sample = await timeClick(window, () => list.taskRow(title).click(), headerIs(title))
    record(results, 'Task switch (cold, unvisited long task)', sample)
    const timing = await lastHistoryTiming(app)
    if (timing !== null) {
      console.log(
        `[674]   TasksHistory: listMessages ${timing.listMessagesMs.toFixed(1)}ms (${String(timing.messageCount)} rows), ` +
          `listToolEvents ${timing.listToolEventsMs.toFixed(1)}ms (${String(timing.eventCount)} rows), total ${timing.totalMs.toFixed(1)}ms`,
      )
    }
  }

  // Warm: A and B, each visited once already (discarded above as the switch *to* them), alternated a few times.
  const [a, b] = [LONG_TASK_TITLES[4] ?? '', LONG_TASK_TITLES[5] ?? '']
  await list.taskRow(a).click()
  await expect(taskHeader(window).title).toHaveText(a)
  for (let round = 0; round < 3; round += 1) {
    await timeClick(window, () => list.taskRow(b).click(), headerIs(b))
    const sample = await timeClick(window, () => list.taskRow(a).click(), headerIs(a))
    record(results, 'Task switch (warm, already loaded)', sample)
  }

  // The workspace switcher's own menu, then picking a workspace in it.
  const switcher = workspaceSwitcher(window)
  const menuSample = await timeClick(
    window,
    () => switcher.trigger.click(),
    `document.querySelector('[role="menu"][aria-label="Workspaces"] [role="menuitemradio"]') !== null`,
  )
  record(results, 'Workspace switcher: open the menu', menuSample)
  const target = WORKSPACES[1]?.name ?? ''
  // A row's own selection closes the menu (unmounting the row) as part of handling it, before the browser would ever
  // dispatch the native `click` a disconnected target cancels (#674's own gotcha, the mirror of #654's): timed with
  // `timeMenuAction`'s Node-side wall clock instead, the way a native menu item already has to be.
  const switchSample = await timeMenuAction(
    window,
    () => switcher.row(target).click(),
    // The region's `<section>` takes its role implicitly from having an accessible name, with no literal `role`
    // attribute to match (unlike the task header's, an explicit `role="region"` — #674's own selector gotcha).
    `document.querySelector('[aria-label="Workspace"]')?.textContent.includes(${JSON.stringify(target)}) ?? false`,
  )
  record(results, 'Workspace switch', switchSample)
  // Back to the first workspace, for the measurements after this one.
  await switcher.trigger.click()
  await switcher.row(WORKSPACES[0]?.name ?? '').click()
  await expect(regions(window).workspace).toContainText(WORKSPACES[0]?.name ?? '', { timeout: 30_000 })
}

/** The right panel's own tabs (Agents, Files, Todos) and a subagent's tab inside Agents. */
async function measurePanelTabs(window: Page, results: ResultsMap): Promise<void> {
  const panel = taskPanel(window)
  const selected = LONG_TASK_TITLES[0] ?? ''
  await taskList(window).taskRow(selected).click()
  await expect(taskHeader(window).title).toHaveText(selected)

  // Files: switching tabs is instant (the data's already loaded), but the tree's rows come from a real `readdir`,
  // so first paint (the tab itself) and fully loaded (its rows) can genuinely differ.
  const filesSample = await timeClick(
    window,
    () => panel.tab('Files').click(),
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith('Files') ?? false`,
    `document.querySelectorAll('[role="tree"][aria-label="Workspace files"] [role="treeitem"]').length > 0`,
  )
  record(results, 'Right panel: Files tab', filesSample)

  const todosSample = await timeClick(
    window,
    () => panel.tab('Todos').click(),
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith('Todos') ?? false`,
  )
  record(results, 'Right panel: Todos tab', todosSample)

  const agentsSample = await timeClick(
    window,
    () => panel.tab(/^Agents/).click(),
    `document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith('Agents') ?? false`,
  )
  record(results, 'Right panel: Agents tab', agentsSample)

  // A subagent's tab: a seeded task's subagents are all finished (there's no live process behind a seed, #674's
  // own finding), so the strip is just Main, and picking one from the caret's dropdown is the only way to its tab
  // (#617) — its own tool log needs its own round trip (`tasks.historyAgent`), where Main's and the panel's own
  // tabs never do.
  const agents = agentsTab(window)
  await agents.caret.click()
  await expect(agents.finishedMenu).toBeVisible()
  const subagentSample = await timeClick(
    window,
    () => agents.finishedMenu.getByRole('menuitem').first().click(),
    `document.querySelectorAll('[role="tablist"][aria-label="Agents"] [role="tab"]').length === 2 && document.querySelectorAll('[role="tablist"][aria-label="Agents"] [role="tab"]')[1]?.getAttribute('aria-selected') === 'true'`,
    `(document.querySelector('#agent-panel [role="log"][aria-label="Tool log"]')?.children[0]?.children.length ?? 0) > 0`,
  )
  record(results, "A subagent's tab", subagentSample)
  // Back to Main, for the measurements after this one.
  await agents.tabs.first().click()
}

/** Opening a real workspace file from the Files tab's "All files" menu. */
async function measureFile(window: Page, path: string, results: ResultsMap): Promise<void> {
  const files = filesTab(window)
  const name = path.split('/').at(-1) ?? path
  // measurePanelTabs leaves the right panel on Agents; the Files tab's own content (and "All files" button) only
  // renders while it's the one showing.
  await taskPanel(window).tab('Files').click()
  await files.list.click()
  const sample = await timeClick(
    window,
    () => files.listed(path).click(),
    `document.querySelector('[role="group"][aria-label="Open files"] button[aria-pressed="true"]')?.textContent?.includes(${JSON.stringify(name)}) ?? false`,
  )
  record(results, 'Opening a file', sample)
  await files.close(name).click()
}

/** The Done list: expanding it (first page) and paging all the way to the 600th done task. */
async function measureDoneList(window: Page, results: ResultsMap): Promise<void> {
  const list = taskList(window)
  const openSample = await timeClick(
    window,
    () => list.sectionHeader('Done').click(),
    // The section is a labelled `<section>`, taking its "region" role implicitly (no literal `role` attribute to
    // match — the same gotcha as the workspace header's, #674).
    `document.querySelector('[aria-label="Done"] li')?.textContent?.includes('Ship the Acme API fix 1') ?? false`,
  )
  record(results, 'Done list: open (first page)', openSample)

  const pagingStart = Date.now()
  const scroller = list.section('Done').locator('..')
  const last = list.row('Done', 'Ship the Acme API fix 600')
  await expect(async () => {
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight
    })
    await expect(last).toBeVisible({ timeout: 250 })
  }).toPass({ timeout: 60_000 })
  const pagingEnd = Date.now()
  record(results, 'Done list: page through all 600', {
    firstPaintMs: pagingEnd - pagingStart,
    fullyLoadedMs: pagingEnd - pagingStart,
  })
  await list.sectionHeader('Done').click()
}

/** Search: typed a key at a time, timed on the last keystroke, as `e2e/typing-latency.spec.ts` times a key. */
async function measureSearch(window: Page, results: ResultsMap): Promise<void> {
  const list = taskList(window)
  await list.search.click()
  const target = LONG_TASK_TITLES[0] ?? ''
  const term = target.slice(0, -1)
  const last = target.slice(-1)
  await window.keyboard.type(term)
  // The results region is a labelled `<section>` too (implicit role, same gotcha as Done's above).
  const readySrc = `document.querySelectorAll('[aria-label="Search results"] li button').length > 0`
  const sample = await timeKeyPress(window, () => window.keyboard.press(last === ' ' ? 'Space' : last), readySrc)
  record(results, 'Search (typed, last keystroke)', sample)
  await list.search.fill('')
}

/** Settings and Broadcast open through the native menu bar, never a DOM click Playwright can see (`e2e/menu.ts`), so
 * these use `timeMenuAction`'s Node-side wall clock instead of `timeClick`'s frame-precise one. */
async function measureSettingsAndBroadcast(glade: Glade, window: Page, results: ResultsMap): Promise<void> {
  const settingsSample = await timeMenuAction(
    window,
    () => chooseMenuItem(glade, 'Glade', 'Settings…'),
    `document.querySelector('[role="dialog"][aria-label="Settings"] h2')?.textContent === 'Agent'`,
  )
  record(results, 'Settings opens', settingsSample)
  await settings(window).close.click()

  const broadcastSample = await timeMenuAction(
    window,
    () => chooseMenuItem(glade, 'File', 'Broadcast…'),
    // The dialog takes its name from `aria-labelledby` (a heading inside it), not a literal `aria-label` (#674's
    // own gotcha, as above): checked by its own heading text instead.
    `document.querySelector('[role="dialog"] h2')?.textContent === 'Broadcast' && (document.querySelector('[role="dialog"] p')?.textContent?.length ?? 0) > 0`,
  )
  record(results, 'Broadcast modal opens', broadcastSample)
  await window.keyboard.press('Escape')
  await expect(broadcastDialog(window).dialog).toHaveCount(0)
}
