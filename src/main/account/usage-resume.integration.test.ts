// Ending a usage limit's pauses before the limit resets (#519), end to end in main: the real bridge, runner and account
// over scripted agent sessions, saving to a database in a temporary folder. Resume now is the window's command; the rest
// is what main does by itself with each answer of the sessions' usage call.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { UsageLimitKind } from '../../shared/account'
import {
  CommandName,
  EVENT_BATCH,
  EventType,
  type GladeBridge,
  type GladeEvent,
  type WindowEvent,
} from '../../shared/bridge'
import {
  API_TOOL_NAME,
  PauseReason,
  TaskActivity,
  TaskState,
  ToolEventKind,
  type Task,
  type Workspace,
} from '../../shared/domain'
import { FakeAgentBackend, settle, type FakeAgentSession } from '../agent/fake-backend'
import { USAGE_RECHECK_MIN_GAP_MS, USAGE_RECHECK_MS } from '../agent/pauses'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge, type RegisteredBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { createWorkspace } from '../db/repositories/workspaces'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'

const NOW = 1_790_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** The call's `extra_usage` with extra usage on and nothing spent, as probed (`docs/sdk-notes.md`): made-up values. */
const EXTRA_ON = {
  is_enabled: true,
  monthly_limit: 5000,
  used_credits: 0,
  utilization: null,
  currency: 'USD',
  disabled_reason: null,
  spend_limit_reached: false,
}
const EXTRA_OFF = { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null }

/** The account every session's usage call tells of, as it stands when asked. */
interface SampleAccount {
  /** How much of the session limit is used, from 0 to 100. */
  session: number
  /** When the session limit's window resets: the same for every reading in the window, as a real one's is. */
  sessionResetsAt: number
  extraUsage: Record<string, unknown>
  /** Whether the call fails, as an SDK without it would. */
  fails: boolean
}

let database: TestDatabase
let acme: Workspace
let storefront: Workspace
let backend: FakeAgentBackend
let bridge: RegisteredBridge
let glade: GladeBridge
/** Each event the window's store heard on its own, in order. */
let events: GladeEvent[]
/** Each burst the window's store heard as one, in order. */
let batches: (readonly GladeEvent[])[]
/** Everything main sent the window on the event channel, as it sent it. */
let windowMessages: WindowEvent[]
let log: MemoryLog
let account: SampleAccount
let clock: number

function usageAnswer(): Promise<unknown> {
  if (account.fails) return Promise.reject(new Error('This SDK has no usage call.'))
  const at = (time: number): string => new Date(time).toISOString()
  return Promise.resolve({
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: account.session, resets_at: at(account.sessionResetsAt) },
      seven_day: { utilization: 22, resets_at: at(NOW + 4 * DAY) },
      extra_usage: account.extraUsage,
    },
    behaviors: null,
  })
}

/** Starts the app on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
  backend.onUsage = usageAnswer
  const ipc = fakeIpcPair()
  windowMessages = []
  const window = {
    send(channel: string, event: WindowEvent): void {
      windowMessages.push(event)
      ipc.window.send(channel, event)
    },
  }
  bridge = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    log: log.logger,
  })
  glade = createBridge(ipc.renderer)
  events = []
  batches = []
  glade.subscribe(
    (event) => events.push(event),
    (batch) => batches.push(batch),
  )
  bridge.runner.resumeInterrupted()
}

function quit(): void {
  bridge.runner.close()
  bridge.account.close()
  bridge.usageResume.close()
}

beforeEach(() => {
  // The pauses' timers and the usage reads' are the fake clock's; the runner's own turns go on real ticks (`settle`).
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  log = createMemoryLog()
  database = openTestDatabase()
  acme = createWorkspace(database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  storefront = createWorkspace(database.db, { name: 'Storefront', rootPath: '/code/storefront' }, 1_100)
  account = { session: 38, sessionResetsAt: NOW + HOUR, extraUsage: EXTRA_OFF, fails: false }
  clock = 2_000
  launch()
})

afterEach(() => {
  quit()
  database.close()
  vi.useRealTimers()
})

function current(id: string): Task {
  const found = getTask(database.db, id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** A task and its session, its first turn started. */
interface Running {
  readonly id: string
  readonly session: FakeAgentSession
}

/** Sends a new task in `workspace` its first message: its session starts, and its turn runs. */
async function start(workspace: Workspace = acme): Promise<Running> {
  clock += 1
  const { id } = sampleTask(database.db, workspace.id, clock)
  await glade.invoke(CommandName.TasksSend, { id, text: 'Copy the uploads to the bucket.' })
  const { session } = backend
  session.emit(sdk.init(`session-${id}`))
  await settle()
  return { id, session }
}

/** A rate limit event saying `window` refuses requests until `inMs` from now. */
function rejected(window: string, inMs = HOUR): unknown {
  return {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'rejected', resetsAt: Math.ceil((Date.now() + inMs) / 1000), rateLimitType: window },
    uuid: `rate-limit-${window}`,
    session_id: sdk.SESSION_ID,
  }
}

/** The running turn of `task` ends on the usage limit, and the usage call says the session limit is spent. */
async function hitLimit(task: Running, window = 'five_hour', inMs = HOUR): Promise<void> {
  account.session = 100
  await turnedAway(task, window, inMs)
}

/**
 * The running turn of `task` is turned away: `window` refuses requests until `inMs` from now, whatever the usage call
 * goes on saying.
 */
async function turnedAway({ session }: Running, window = 'five_hour', inMs = HOUR): Promise<void> {
  session.emit(
    rejected(window, inMs),
    sdk.apiErrorMessage('rate_limit', sdk.USAGE_LIMIT_ERROR),
    sdk.apiErrorResult(sdk.USAGE_LIMIT_ERROR, 429),
  )
  await settle()
}

/** A new task in `workspace`, paused on the session limit, which resets in an hour. */
async function limited(workspace: Workspace = acme): Promise<Running> {
  const running = await start(workspace)
  await hitLimit(running)
  expect(current(running.id)).toMatchObject({
    activity: TaskActivity.Paused,
    pause: { reason: PauseReason.UsageLimit },
  })
  return running
}

/** A new task paused because the API can't be reached. */
async function offline(): Promise<Running> {
  const running = await start()
  running.session.emit(...sdk.offlineTurnEnd())
  await settle()
  expect(current(running.id).pause?.reason).toBe(PauseReason.Offline)
  return running
}

/** The running turn of a task ends with a reply. */
async function reply({ session }: Running): Promise<void> {
  session.emit(sdk.text('Copied.'), sdk.result('Copied.'))
  await settle()
}

/** How many times the sessions have been asked for the account's usage, all told. */
function asked(): number {
  return backend.sessions.reduce((sum, session) => sum + session.usageCalls, 0)
}

/** How many times each task's turn has been handed to its session: once, plus once for each time it was resumed. */
function turns(...tasks: readonly Running[]): number[] {
  return tasks.map(({ session }) => session.sent.length)
}

function activities(...tasks: readonly Running[]): TaskActivity[] {
  return tasks.map(({ id }) => current(id).activity)
}

async function resumeNow(): Promise<readonly Task[]> {
  return (await glade.invoke(CommandName.TasksResumePaused, {})).tasks
}

/** Glade's window gets the focus, and whatever that asks for is answered. */
async function focus(): Promise<void> {
  bridge.usageResume.focused()
  await settle()
}

/** The usage reads' timer comes round `times` times, each read answered before the next. */
async function tick(times = 1): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    vi.advanceTimersByTime(USAGE_RECHECK_MS)
    await settle()
  }
}

/** Forgets what the window has heard so far. */
function listen(): void {
  windowMessages.length = 0
  events.length = 0
  batches.length = 0
}

describe('Resume now', () => {
  it('resumes every task a usage limit paused, in every workspace, each on its own model, as one batch', async () => {
    const first = await limited(acme)
    const second = await limited(storefront)
    const third = await limited(storefront)
    const away = await offline()
    const idle = await start()
    await reply(idle)
    await glade.invoke(CommandName.TasksUpdate, { id: second.id, patch: { model: 'claude-sample-2' } })
    listen()

    const resumed = await resumeNow()

    expect(resumed.map(({ id, activity }) => [id, activity])).toEqual(
      [first, second, third].map(({ id }) => [id, TaskActivity.Working]),
    )
    expect(activities(first, second, third)).toEqual(Array(3).fill(TaskActivity.Working))
    for (const { id } of [first, second, third]) expect(current(id)).toMatchObject({ pause: null, error: null })
    // Each turn went to its own session again, on the model its task has.
    expect(turns(first, second, third)).toEqual([2, 2, 2])
    expect(second.session.sent[1]?.settings.model).toBe('claude-sample-2')
    expect(first.session.sent[1]?.settings.model).toBe('claude-sample-1')
    // Offline, the network decides; an idle task has nothing to resume.
    expect(current(away.id)).toMatchObject({ activity: TaskActivity.Paused, pause: { reason: PauseReason.Offline } })
    expect(turns(away, idle)).toEqual([1, 1])
    // One message on the event channel for all three, applied by the window in one change.
    expect(windowMessages.map(({ type }) => type)).toEqual([EVENT_BATCH])
    expect(events).toEqual([])
    expect(batches[0]?.filter(({ type }) => type === EventType.TaskUpdated)).toHaveLength(3)
  })

  it('pauses a task still over the limit again, with the reset time it’s given, and no error', async () => {
    const task = await limited()
    const before = current(task.id).pause

    await resumeNow()
    vi.setSystemTime(NOW + MINUTE)
    await hitLimit(task, 'five_hour', 2 * HOUR)

    const again = current(task.id)
    expect(again).toMatchObject({ activity: TaskActivity.Paused, error: null })
    expect(again.pause).toMatchObject({ reason: PauseReason.UsageLimit, since: NOW + MINUTE })
    expect(again.pause?.resumesAt).toBeGreaterThan(before?.resumesAt ?? 0)
    // No failed API row in the tool log either: the task is paused, not stopped.
    const rows = listToolEvents(database.db, task.id)
    expect(rows.filter((row) => row.kind === ToolEventKind.ToolCall && row.name === API_TOOL_NAME)).toEqual([])
    // It resumes at the new reset time, and not at the old one.
    vi.advanceTimersByTime(HOUR)
    expect(turns(task)).toEqual([2])
    vi.advanceTimersByTime(HOUR + MINUTE)
    expect(turns(task)).toEqual([3])
  })

  it('does nothing with nothing paused on a usage limit, and can be pressed twice', async () => {
    const away = await offline()
    listen()

    expect(await resumeNow()).toEqual([])
    expect(windowMessages).toEqual([])

    const task = await limited()
    expect(await resumeNow()).toHaveLength(1)
    expect(await resumeNow()).toEqual([])
    expect(turns(task, away)).toEqual([2, 1])
  })

  it('resumes a task paused before a relaunch, whose session is gone, in a session started on its conversation', async () => {
    const task = await limited()
    quit()
    launch()
    expect(backend.sessions).toHaveLength(0)

    const [resumed] = await resumeNow()

    expect(resumed).toMatchObject({ id: task.id, activity: TaskActivity.Working, pause: null })
    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options.resumeSessionId).toBe(`session-${task.id}`)
    expect(backend.session.sent).toHaveLength(1)
  })
})

describe('a reading that says the account can run again', () => {
  it('resumes the paused tasks without a click, once extra usage is on, as one batch', async () => {
    const first = await limited(acme)
    const second = await limited(storefront)
    const away = await offline()
    // Each task's session read usage as its turn ended: the session limit spent, extra usage off.
    expect(activities(first, second)).toEqual([TaskActivity.Paused, TaskActivity.Paused])

    account.extraUsage = EXTRA_ON
    listen()
    await focus()

    expect(activities(first, second)).toEqual([TaskActivity.Working, TaskActivity.Working])
    expect(turns(first, second, away)).toEqual([2, 2, 1])
    expect(current(away.id).pause?.reason).toBe(PauseReason.Offline)
    // The meter got the reading, with its Extra usage row; then the tasks, in one batch.
    expect(windowMessages.map(({ type }) => type)).toEqual([EventType.AccountChanged, EVENT_BATCH])
    const [meter] = events
    expect(meter?.type === EventType.AccountChanged && meter.status.usage.map(({ limit }) => limit.kind)).toEqual([
      UsageLimitKind.Session,
      UsageLimitKind.Weekly,
      UsageLimitKind.ExtraUsage,
    ])
    expect(batches[0]?.filter(({ type }) => type === EventType.TaskUpdated)).toHaveLength(2)
    expect(log.withMessage('usage says the paused task can run again').map(({ fields }) => fields)).toEqual([
      { taskId: first.id, reason: 'extra_usage' },
      { taskId: second.id, reason: 'extra_usage' },
    ])
  })

  it('resumes a task once its own limit has room again, and not one whose limit Glade doesn’t know', async () => {
    const task = await limited()
    const unnamed = await start()
    await hitLimit(unnamed, 'seven_day_overage_included')
    expect(current(task.id).pause?.limit).toEqual({ kind: UsageLimitKind.Session })
    expect(current(unnamed.id).pause).not.toHaveProperty('limit')

    // A bigger plan: the session limit isn't spent any more.
    account.session = 20
    await focus()

    expect(activities(task, unnamed)).toEqual([TaskActivity.Working, TaskActivity.Paused])
    expect(turns(task, unnamed)).toEqual([2, 1])
    expect(log.withMessage('usage says the paused task can run again')[0]?.fields).toMatchObject({
      reason: 'limit_cleared',
    })

    // Extra usage takes whatever limit it was.
    account.extraUsage = EXTRA_ON
    await tick()
    expect(activities(unnamed)).toEqual([TaskActivity.Working])
  })

  it('resumes nothing on a reading that says what the last one said, however often it’s read', async () => {
    const first = await limited()
    const second = await limited(storefront)
    account.extraUsage = EXTRA_ON
    await focus()
    expect(turns(first, second)).toEqual([2, 2])

    // The reading was wrong: both are turned away again, and each session reads the same usage as its turn ends.
    await hitLimit(first)
    await hitLimit(second)
    expect(activities(first, second)).toEqual([TaskActivity.Paused, TaskActivity.Paused])
    const reads = asked()

    await tick(6)
    vi.advanceTimersByTime(USAGE_RECHECK_MIN_GAP_MS)
    await focus()

    expect(asked()).toBe(reads + 7)
    expect(turns(first, second)).toEqual([2, 2])
    expect(activities(first, second)).toEqual([TaskActivity.Paused, TaskActivity.Paused])
  })

  it('resumes a task paused again exactly once while extra usage stays available, however its spending rises', async () => {
    const task = await limited()
    account.extraUsage = EXTRA_ON
    await focus()
    expect(turns(task)).toEqual([2])

    // Turned away again, while other tasks spend extra usage: each reading says more of it is used, and the session
    // fills on, yet it's still "available", which is all the task was resumed on.
    await hitLimit(task)
    for (const [usedCredits, session] of [
      [250, 100],
      [900, 104],
      [2400, 109],
    ] as const) {
      account.extraUsage = { ...EXTRA_ON, used_credits: usedCredits }
      account.session = session
      await tick()
      expect(activities(task)).toEqual([TaskActivity.Paused])
    }
    vi.advanceTimersByTime(USAGE_RECHECK_MIN_GAP_MS)
    await focus()

    expect(turns(task)).toEqual([2])
    expect(log.withMessage('usage says the paused task can run again')).toHaveLength(1)
    // The meter followed every reading all the same.
    expect(bridge.account.status().usage.at(-1)).toMatchObject({
      limit: { kind: UsageLimitKind.ExtraUsage },
      utilization: 0.48,
    })
  })

  it('resumes it once more when extra usage stops being available and comes back, and only then', async () => {
    const task = await limited()
    account.extraUsage = EXTRA_ON
    await focus()
    await hitLimit(task)
    await tick(2)
    expect(turns(task)).toEqual([2])

    // Out of credits, then topped up: the reading in between said it couldn't run.
    account.extraUsage = { ...EXTRA_ON, used_credits: 5000, spend_limit_reached: true }
    await tick()
    expect(turns(task)).toEqual([2])
    account.extraUsage = { ...EXTRA_ON, monthly_limit: 10_000, used_credits: 5000 }
    await tick()
    expect(turns(task)).toEqual([3])

    await hitLimit(task)
    await tick(3)
    expect(turns(task)).toEqual([3])
  })

  it('resumes a task once a window on a limit that reads clear, however it fills, and again once it rolls over', async () => {
    const task = await limited()
    // The call says the session limit has room, and it's wrong: the task is turned away again.
    account.session = 20
    await focus()
    expect(turns(task)).toEqual([2])
    await turnedAway(task)

    for (const session of [35, 60, 85]) {
      account.session = session
      await tick()
    }
    expect(turns(task)).toEqual([2])
    expect(activities(task)).toEqual([TaskActivity.Paused])

    // The session's next window: one more go.
    account.sessionResetsAt = NOW + 6 * HOUR
    await tick()
    expect(turns(task)).toEqual([3])
    await turnedAway(task)
    await tick(2)
    expect(turns(task)).toEqual([3])
  })

  it('resumes nothing while extra usage is on but can’t be used', async () => {
    const task = await limited()

    for (const extraUsage of [
      { ...EXTRA_ON, disabled_reason: 'out_of_credits' },
      { ...EXTRA_ON, spend_limit_reached: true },
      { ...EXTRA_ON, used_credits: 5000 },
      { is_enabled: true, monthly_limit: 5000, used_credits: 0, utilization: null },
    ]) {
      account.extraUsage = extraUsage
      await tick()
      expect(activities(task)).toEqual([TaskActivity.Paused])
    }
    expect(turns(task)).toEqual([1])

    // Credits bought: nothing disables it any more.
    account.extraUsage = EXTRA_ON
    await tick()
    expect(turns(task)).toEqual([2])
  })

  it('reads what another task’s turn asks for too: a task paused later isn’t resumed on what was already wrong', async () => {
    account.extraUsage = EXTRA_ON
    const busy = await start()
    // Extra usage is on, yet the turn is turned away: its session's read, as the turn ends, resumes it once.
    await hitLimit(busy)
    expect(turns(busy)).toEqual([2])

    await hitLimit(busy)
    await tick(2)

    expect(turns(busy)).toEqual([2])
    expect(activities(busy)).toEqual([TaskActivity.Paused])
  })

  it('goes on with the pauses’ own timers when the usage call fails', async () => {
    const task = await limited()
    account.fails = true
    account.extraUsage = EXTRA_ON

    await tick(3)
    expect(activities(task)).toEqual([TaskActivity.Paused])

    vi.advanceTimersByTime(HOUR)
    expect(activities(task)).toEqual([TaskActivity.Working])
  })
})

describe('reading usage again', () => {
  it('asks nothing while nothing is paused on a usage limit: no timer, and no read on focus', async () => {
    const idle = await start()
    await reply(idle)
    await offline()
    const reads = asked()

    await tick(6)
    await focus()

    expect(asked()).toBe(reads)
    expect(log.withMessage('usage asked for again')).toEqual([])
  })

  it('has one timer from the first usage limit pause to the last, whatever ends each', async () => {
    const first = await limited()
    const reads = asked()
    await tick()
    expect(asked()).toBe(reads + 1)

    // A second pause adds no second timer.
    const second = await limited(storefront)
    const third = await limited(storefront)
    const withThree = asked()
    await tick(2)
    expect(asked()).toBe(withThree + 2)

    // One resumes at its reset, one is marked done, and still a task is paused.
    await glade.invoke(CommandName.TasksRetry, { id: first.id })
    await glade.invoke(CommandName.TasksMarkDone, { id: second.id })
    expect(current(second.id).state).toBe(TaskState.Done)
    const withOne = asked()
    await tick()
    expect(asked()).toBe(withOne + 1)

    // The last is deleted: nothing is asked any more.
    await glade.invoke(CommandName.TasksDelete, { id: third.id })
    const withNone = asked()
    await tick(4)
    await focus()
    expect(asked()).toBe(withNone)
    expect(log.withMessage('usage is read again every few minutes: a task is paused on a usage limit')).toHaveLength(1)
    expect(log.withMessage('usage is no longer read again: nothing is paused on a usage limit')).toHaveLength(1)

    // And it starts again with the next pause.
    await hitLimit(first)
    const paused = asked()
    await tick()
    expect(asked()).toBe(paused + 1)
  })

  it('reads when the window gets the focus, once however it flickers, through one live session', async () => {
    const first = await limited()
    const second = await limited(storefront)
    const reads = asked()

    await focus()
    await focus()
    vi.advanceTimersByTime(USAGE_RECHECK_MIN_GAP_MS - 1)
    await focus()
    expect(asked()).toBe(reads + 1)
    // One session answers for the account: the others aren't asked.
    expect([first.session.usageCalls, second.session.usageCalls]).toEqual([3, 2])

    vi.advanceTimersByTime(1)
    await focus()
    expect(asked()).toBe(reads + 2)
    expect(log.withMessage('usage asked for again').map(({ fields }) => fields)).toEqual([
      { why: 'focus', paused: 2 },
      { why: 'focus', paused: 2 },
    ])
  })

  it('stops with the app', async () => {
    await limited()
    const reads = asked()

    quit()
    await tick(3)

    expect(asked()).toBe(reads)
  })
})

describe('after a relaunch with tasks paused on a usage limit', () => {
  it('times the reads again, and has no session to ask until a task runs: it starts none to ask', async () => {
    const task = await limited()
    account.extraUsage = EXTRA_ON
    quit()
    launch()

    await tick(2)
    await focus()

    expect(backend.sessions).toHaveLength(0)
    expect(activities(task)).toEqual([TaskActivity.Paused])
    expect(log.withMessage('usage not asked for again: no session is live').map(({ fields }) => fields)).toEqual([
      { why: 'timer', paused: 1 },
      { why: 'timer', paused: 1 },
      { why: 'focus', paused: 1 },
    ])

    // Another task runs: its session's own read, as it starts, says the account can run again.
    const other = await start(storefront)

    expect(current(task.id)).toMatchObject({ activity: TaskActivity.Working, pause: null })
    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.options.resumeSessionId).toBe(`session-${task.id}`)
    expect(turns(other)).toEqual([1])
  })

  it('still resumes at the limit’s reset, read or not', async () => {
    const task = await limited()
    quit()
    launch()

    vi.advanceTimersByTime(HOUR + MINUTE)
    await settle()

    expect(current(task.id).activity).toBe(TaskActivity.Working)
    expect(backend.sessions).toHaveLength(1)
  })
})
