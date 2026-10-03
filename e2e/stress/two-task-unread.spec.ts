// #483: a stress run, not a test of the suite. Once in 300 runs, on a busy Mac, `workspace-switcher-pill.spec.ts`
// stopped and messaged two tasks in two workspaces back to back, and the second one (B1, in the workspace not shown)
// never counted in the pill: its reply wasn't flagged unread, or the flag never reached the window. The run left
// nothing to tell which. That spec now waits between the two tasks (#482); this one does what it did then, and writes
// down what happened on every run, pass or fail, so a failure says which step broke.
//
// It's left out of `npm run test:e2e` and CI: `playwright.config.ts` ignores `e2e/stress/` unless `GLADE_E2E_STRESS`
// is set. Run it the way it failed, among the specs it failed among, on a loaded machine:
//
//   GLADE_E2E_STRESS=1 GLADE_E2E_STRESS_COPIES=8 npx playwright test e2e/stress/two-task-unread.spec.ts \
//     e2e/workspaces.spec.ts e2e/menu-bar.spec.ts e2e/menu-bar-icon.spec.ts e2e/needs-you.spec.ts \
//     --repeat-each 50 --global-timeout 2700000
//
// `GLADE_E2E_STRESS_COPIES` is how many times it runs in each repeat, between the other specs (1 by default). Each run
// writes `run-<repeat>-<copy>.json` (a `StressRecord`) and `run-<repeat>-<copy>.main.log` (the app's log, as
// `logToKeep` keeps it) to `GLADE_E2E_STRESS_OUT`, or `out/e2e-stress/` without it. A run that fails also keeps the
// `launch` fixture's evidence, like any failed test (`../evidence.ts`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Page } from '@playwright/test'
import { z } from 'zod'
import {
  BRIDGE_KEY,
  CommandName,
  EventType,
  type GladeBridge,
  type TasksHistoryResponse,
} from '../../src/shared/bridge'
import { needsYou } from '../../src/shared/attention'
import { MessageRole, UiStateKey, type Task } from '../../src/shared/domain'
import { logToKeep } from '../evidence'
import { chooseFolder, expect, test } from '../fixtures'
import { chooseMenuItem } from '../menu'
import { firstRun, inputBar, regions, taskList, workspaceSwitcher } from '../selectors'
import { invoke } from '../task-view'

/** Each workspace's long-running task's first message: it plays `long-running`, which works until it's stopped. */
const RUN_SUITE = 'Run the e2e suite.'
/** What its agent is told once stopped: its reply makes the task need you. */
const UNIT_ONLY = 'Only run the unit tests.'
/** The title `long-running`'s first turn sets with `set_title` (`describeTask` in `scripts.ts`). */
const SUITE_TITLE = 'Run the e2e suite'
/** The turn the message sent after the stop starts: the one whose reply should flag the task. */
const REPLY_TURN = 2

/** How many times the run is repeated in each repeat of the specs it's run among. */
const COPIES = Number(process.env.GLADE_E2E_STRESS_COPIES ?? '1')

/** Where each run's record and log go. */
const OUT = resolve(process.env.GLADE_E2E_STRESS_OUT ?? join(__dirname, '..', '..', 'out', 'e2e-stress'))

/** Where the window keeps the events it was sent, for the record (`recordWindowEvents`). */
const WINDOW_EVENTS_GLOBAL = '__gladeStressEvents'

/** The two tasks stopped and messaged: A1 in the workspace shown, B1 in the other. */
type TaskName = 'A1' | 'B1'

/** One command's round trip, from the spec to main and back. */
interface CommandTiming {
  readonly task: TaskName
  readonly command: CommandName
  /** When the spec sent it, in UTC, as the log's lines are timed. */
  readonly sentAt: string
  readonly roundTripMs: number
  /** What main refused it with, as JSON; null when it went through. */
  readonly refusal: string | null
}

/** An event main sent that the window received: every task update and every change of what's selected and shown. */
interface WindowEvent {
  /** When the window got it, in UTC. */
  readonly at: string
  readonly type: EventType
  readonly taskId?: string
  readonly unread?: boolean
  readonly activity?: string
  readonly uiState?: string
  readonly value?: string
}

/** How far a task's reply got, each step read from where it shows: the app's log, main's tasks, or the window. */
interface ReplySteps {
  /** Main got the Stop (the log's `ipc` line for `tasks.stop`, and whether it went through). */
  readonly stopReceived: boolean
  /** Main got the message (`tasks.send`). */
  readonly sendReceived: boolean
  /** The runner started the message's turn (`turn started`). */
  readonly turnStarted: boolean
  /** The runner ended it, and not as a stopped turn (`turn ended`). */
  readonly turnEnded: boolean
  /** The agent's reply is in the chat log, as main's history has it. */
  readonly replyAppended: boolean
  /** Main has the task unread (`tasks.list`). */
  readonly unreadInMain: boolean
  /** Main has it as needing you: unread, and its turn over (`needsYou`). */
  readonly needsYouInMain: boolean
  /** Main sent the windows the task as unread (the log's `task updated` line naming `unread`). */
  readonly unreadSent: boolean
  /** The window was sent the task as unread and needing you (`WindowEvent`s). */
  readonly unreadReceived: boolean
}

/** A task as the run left it. */
interface TaskRecord {
  readonly id: string
  /** The task as main has it; null if main no longer lists it. */
  readonly task: Task | null
  readonly history: TasksHistoryResponse
  readonly steps: ReplySteps
}

/** What a run writes down. */
interface StressRecord {
  readonly repeat: number
  readonly copy: number
  readonly startedAt: string
  /** Whether the pill came to read 2: both tasks flagged, in the window. */
  readonly passed: boolean
  /** Why it didn't, as the wait reported it; null when it passed. */
  readonly failure: string | null
  /** The four commands, in the order they were sent. */
  readonly commands: readonly CommandTiming[]
  /** How long the one wait for the pill took. */
  readonly waitMs: number
  /** The pill and the switcher's tooltip as the window showed them after the wait; null for no pill. */
  readonly pill: string | null
  readonly tooltip: string | null
  /** What main has as shown and viewed, after the wait: a reply is judged against the task viewed. */
  readonly activeWorkspaceId: string | null
  readonly selectedTaskId: string | null
  readonly workspaceA: string
  readonly workspaceB: string
  readonly a1: TaskRecord
  readonly b1: TaskRecord
  readonly windowEvents: readonly WindowEvent[]
}

/** A line of the app's log, as far as the steps read it. */
const logLineSchema = z.looseObject({
  scope: z.string(),
  msg: z.string(),
  taskId: z.string().optional(),
  command: z.string().optional(),
  ok: z.boolean().optional(),
  turn: z.number().optional(),
  stopped: z.boolean().optional(),
  changed: z.array(z.string()).optional(),
})

type LogLine = z.infer<typeof logLineSchema>

/** The log's lines, each parsed: a line that isn't a record (there should be none) is left out. */
function logLines(log: string): LogLine[] {
  const lines: LogLine[] = []
  for (const line of log.split('\n')) {
    if (line === '') continue
    let record: unknown
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    const parsed = logLineSchema.safeParse(record)
    if (parsed.success) lines.push(parsed.data)
  }
  return lines
}

/** Has the window keep the task updates and UI state changes main sends it, from now on. */
async function recordWindowEvents(window: Page): Promise<void> {
  await window.evaluate(
    ({ key, global, taskUpdated, uiStateChanged }) => {
      const bridge = (globalThis as unknown as Record<string, GladeBridge>)[key]
      if (bridge === undefined) throw new Error('No bridge on the page')
      const seen: WindowEvent[] = []
      Reflect.set(globalThis, global, seen)
      bridge.subscribe((event) => {
        const at = new Date().toISOString()
        if (event.type === taskUpdated) {
          const { id, unread, activity } = event.task
          seen.push({ at, type: event.type, taskId: id, unread, activity })
        } else if (event.type === uiStateChanged) {
          seen.push({ at, type: event.type, uiState: event.entry.key, value: event.entry.value })
        }
      })
    },
    {
      key: BRIDGE_KEY,
      global: WINDOW_EVENTS_GLOBAL,
      taskUpdated: EventType.TaskUpdated as const,
      uiStateChanged: EventType.UiStateChanged as const,
    },
  )
}

/** The events the window has kept (`recordWindowEvents`). */
function windowEvents(window: Page): Promise<WindowEvent[]> {
  return window.evaluate((global) => [...(Reflect.get(globalThis, global) as WindowEvent[])], WINDOW_EVENTS_GLOBAL)
}

/** Sends a command as the old test did, one round trip, and times it. A refusal is written down, not thrown. */
async function timed(
  window: Page,
  task: TaskName,
  command: CommandName.TasksStop | CommandName.TasksSend,
  id: string,
): Promise<CommandTiming> {
  const sentAt = new Date()
  let refusal: string | null = null
  try {
    if (command === CommandName.TasksStop) await invoke(window, command, { id })
    else await invoke(window, command, { id, text: UNIT_ONLY })
  } catch (error) {
    refusal = error instanceof Error ? error.message : JSON.stringify(error)
  }
  return { task, command, sentAt: sentAt.toISOString(), roundTripMs: Date.now() - sentAt.getTime(), refusal }
}

/** How far a task's reply got (`ReplySteps`). */
function replySteps(
  id: string,
  task: Task | null,
  history: TasksHistoryResponse,
  lines: readonly LogLine[],
  events: readonly WindowEvent[],
): ReplySteps {
  const mine = lines.filter((line) => line.taskId === id)
  const got = (command: CommandName): boolean =>
    mine.some((line) => line.scope === 'ipc' && line.command === command && line.ok === true)
  const runner = (msg: string): LogLine | undefined =>
    mine.find((line) => line.scope === 'runner' && line.msg === msg && line.turn === REPLY_TURN)
  return {
    stopReceived: got(CommandName.TasksStop),
    sendReceived: got(CommandName.TasksSend),
    turnStarted: runner('turn started') !== undefined,
    turnEnded: runner('turn ended')?.stopped === false,
    replyAppended: history.messages.some(({ role, turn }) => role === MessageRole.Agent && turn === REPLY_TURN),
    unreadInMain: task?.unread === true,
    needsYouInMain: task !== null && needsYou(task),
    unreadSent: mine.some((line) => line.msg === 'task updated' && line.changed?.includes('unread') === true),
    unreadReceived: events.some(
      (event) => event.taskId === id && event.unread === true && event.activity === 'waiting',
    ),
  }
}

for (let copy = 1; copy <= COPIES; copy += 1) {
  test(`two tasks in two workspaces, stopped and messaged back to back, both come up as needing you (${String(copy)} of ${String(COPIES)})`, async ({
    launch,
    tempFolder,
  }, testInfo) => {
    const startedAt = new Date().toISOString()
    const parent = tempFolder()
    const rootA = join(parent, 'acme-api')
    const rootB = join(parent, 'acme-web')
    mkdirSync(rootA)
    mkdirSync(rootB)
    const glade = await launch({ agentScriptsByFirstMessage: { [RUN_SUITE]: 'long-running' }, chosenFolder: rootA })
    const { window } = glade
    const switcher = workspaceSwitcher(window)
    const list = taskList(window)
    const bar = inputBar(window)
    const workspace = regions(window).workspace
    await recordWindowEvents(window)

    // From here to the wait, the old test's own steps, in its order and with its waits.
    await firstRun(window).openFolder.click()
    await expect(workspace).toContainText('acme-api')
    await expect(switcher.pill).toHaveCount(0)
    await expect(switcher.trigger).toHaveAttribute('title', 'Switch workspace')

    // Task A1: started, then left running in the background once A2 (below) is the one shown instead.
    await list.newTask.click()
    await bar.field.fill(RUN_SUITE)
    await bar.field.press('Enter')
    await expect(bar.stop).toBeVisible()

    // Task A2: created after it, so from here on A2 (not A1) is the one shown in A.
    await list.newTask.click()
    await expect(switcher.pill).toHaveCount(0)

    // Add B and start a task there the same way.
    await chooseFolder(glade, rootB)
    await chooseMenuItem(glade, 'Workspace', 'New workspace…')
    await expect(workspace).toContainText('acme-web')
    await list.newTask.click()
    await bar.field.fill(RUN_SUITE)
    await bar.field.press('Enter')
    await expect(bar.stop).toBeVisible()

    // Back to A: switching restores A2 as the one shown there.
    await chooseMenuItem(glade, 'Workspace', 'Switch workspace', 'acme-api')
    await expect(workspace).toContainText('acme-api')
    await expect(switcher.pill).toHaveCount(0)

    const { workspaces } = await invoke(window, CommandName.WorkspacesList, {})
    const workspaceA = workspaces.find((each) => each.rootPath === rootA)?.id ?? ''
    const workspaceB = workspaces.find((each) => each.rootPath === rootB)?.id ?? ''
    const { tasks: tasksA } = await invoke(window, CommandName.TasksList, { workspaceId: workspaceA })
    const { tasks: tasksB } = await invoke(window, CommandName.TasksList, { workspaceId: workspaceB })
    const taskA1 = tasksA.find((task) => task.title === SUITE_TITLE)?.id ?? ''
    const taskB1 = tasksB[0]?.id ?? ''

    // A1 replies while A2 is the one shown, and B1 replies too, in the workspace that isn't: stopped and messaged back
    // to back, with nothing waited for in between.
    const commands = [
      await timed(window, 'A1', CommandName.TasksStop, taskA1),
      await timed(window, 'A1', CommandName.TasksSend, taskA1),
      await timed(window, 'B1', CommandName.TasksStop, taskB1),
      await timed(window, 'B1', CommandName.TasksSend, taskB1),
    ]

    // The one wait: both need you, so the pill reads 2.
    const waitStarted = Date.now()
    let failure: string | null = null
    try {
      await expect(switcher.pill).toHaveText('2')
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
    const waitMs = Date.now() - waitStarted

    // What happened, as main, its log and the window each have it.
    const pill = (await switcher.pill.count()) === 0 ? null : await switcher.pill.textContent()
    const tooltip = await switcher.trigger.getAttribute('title')
    const { entries } = await invoke(window, CommandName.UiStateGetAll, {})
    const stored = (key: UiStateKey): string | null => entries.find((entry) => entry.key === key)?.value ?? null
    const after = [
      ...(await invoke(window, CommandName.TasksList, { workspaceId: workspaceA })).tasks,
      ...(await invoke(window, CommandName.TasksList, { workspaceId: workspaceB })).tasks,
    ]
    const events = await windowEvents(window)
    const log = logToKeep(readFileSync(glade.logFile, 'utf8'))
    const lines = logLines(log)
    const taskRecord = async (id: string): Promise<TaskRecord> => {
      const task = after.find((each) => each.id === id) ?? null
      const history = await invoke(window, CommandName.TasksHistory, { id })
      return { id, task, history, steps: replySteps(id, task, history, lines, events) }
    }
    const record: StressRecord = {
      repeat: testInfo.repeatEachIndex,
      copy,
      startedAt,
      passed: failure === null,
      failure,
      commands,
      waitMs,
      pill,
      tooltip,
      activeWorkspaceId: stored(UiStateKey.ActiveWorkspaceId),
      selectedTaskId: stored(UiStateKey.SelectedTaskId),
      workspaceA,
      workspaceB,
      a1: await taskRecord(taskA1),
      b1: await taskRecord(taskB1),
      windowEvents: events,
    }
    mkdirSync(OUT, { recursive: true })
    const name = `run-${String(testInfo.repeatEachIndex).padStart(3, '0')}-${String(copy).padStart(2, '0')}`
    writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(record, null, 2)}\n`)
    writeFileSync(join(OUT, `${name}.main.log`), log)

    expect(failure, `the pill never read 2: see ${name}.json for which step broke`).toBeNull()
  })
}
