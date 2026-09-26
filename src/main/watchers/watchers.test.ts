// The watchers (`./watchers`), fed what the runner hands them in the shapes the SDK was probed to send
// (`docs/sdk-notes.md` §13), saving to a real database.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  ToolCallState,
  WatcherKind,
  WatcherState,
  type Task,
  type ToolCallEvent,
  type ToolInput,
  type Watcher,
} from '../../shared/domain'
import { PromptVerdict, type SessionJob } from '../agent/backend'
import { AgentEventKind, TaskOutcome, type SubagentStartedEvent, type ToolResultEvent } from '../agent/events'
import { endNotice, eventNotice } from '../agent/scripted-session'
import { createTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, getToolCall, updateToolCall } from '../db/repositories/tool-events'
import { getWatcher, listWatchers, updateWatcher } from '../db/repositories/watchers'
import { markTaskDone } from '../tasks/service'
import {
  CANCELLED_BY_AGENT,
  createWatcherTracker,
  ENDED_WITH_SUBAGENT,
  FIRED,
  NO_LONGER_SCHEDULED,
  StopAction,
  STOPPED_BY_AGENT,
  STOPPED_BY_RELAUNCH,
  STOPPED_BY_YOU,
  TIMED_OUT,
  type WatcherTracker,
} from './watchers'
import { Effort } from '../../shared/domain'

/** 25 September 2026, 13:07:30 local time. */
const START = new Date(2026, 8, 25, 13, 7, 30).getTime()

let database: TestDatabase
let task: Task
let events: GladeEvent[]
let clock: number
let tracker: WatcherTracker

beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  events = []
  clock = START
  tracker = createWatcherTracker({ db: database.db, emit: (event) => events.push(event), now: () => clock })
})

afterEach(() => {
  database.close()
})

/** The task's watchers, as the tab gets them: the latest `watchers.changed`. */
function broadcast(taskId = task.id): readonly Watcher[] | undefined {
  const changed = events.filter(
    (event): event is Extract<GladeEvent, { type: EventType.WatchersChanged }> =>
      event.type === EventType.WatchersChanged && event.taskId === taskId,
  )
  return changed.at(-1)?.watchers
}

function only(taskId = task.id): Watcher {
  const [watcher, ...rest] = listWatchers(database.db, taskId)
  if (watcher === undefined || rest.length > 0) throw new Error(`expected one watcher, got ${String(rest.length + 1)}`)
  return watcher
}

/** A tool call the agent made, as the runner logged it, with its result when it has one. */
function call(toolUseId: string, name: string, input: ToolInput, taskId = task.id): ToolCallEvent {
  appendToolCall(database.db, { taskId, turn: 1, name, input, toolUseId, parentToolUseId: null })
  return updateToolCall(database.db, { taskId, toolUseId, state: ToolCallState.Done, output: 'ok' })
}

function started(
  toolUseId: string,
  sdkTaskId: string,
  description = '',
  taskType = 'local_bash',
  isBackgrounded = true,
): SubagentStartedEvent {
  return {
    kind: AgentEventKind.SubagentStarted,
    sdkTaskId,
    toolUseId,
    background: false,
    taskType,
    isBackgrounded,
    description,
  }
}

function resultOf(toolUseId: string, details: unknown, isError = false): ToolResultEvent {
  return { kind: AgentEventKind.ToolResult, toolUseId, output: 'ok', isError, launched: false, details }
}

function finished(toolUseId: string, sdkTaskId: string, outcome: TaskOutcome, summary: string) {
  return { kind: AgentEventKind.TaskFinished, sdkTaskId, toolUseId, outcome, summary } as const
}

const CI = { description: 'CI checks on PR #42', timeout_ms: 1_800_000, command: 'gh pr checks 42 --watch' }

/** The agent arms a Monitor, as the SDK starts it. */
function armMonitor(taskId = task.id, toolUseId = 'toolu_ci', sdkTaskId = 'bci'): void {
  call(toolUseId, 'Monitor', CI, taskId)
  tracker.taskStarted(taskId, started(toolUseId, sdkTaskId, CI.description), null)
}

/** The agent starts a command in the background. */
function runCommand(toolUseId = 'toolu_tests', sdkTaskId = 'btests', command = 'npm run test:integration'): void {
  call(toolUseId, 'Bash', { command, description: 'Integration tests', run_in_background: true })
  tracker.taskStarted(task.id, started(toolUseId, sdkTaskId, 'Integration tests'), null)
}

const ROLLOUT = { delaySeconds: 300, reason: 'Check the rollout', prompt: 'Check the rollout.', noop: false }

/** The agent schedules a wakeup, due 5 minutes on. */
function scheduleWakeup(toolUseId = 'toolu_wake', input: ToolInput = ROLLOUT): ToolCallEvent {
  const scheduled = call(toolUseId, 'ScheduleWakeup', input)
  tracker.toolResult(task.id, scheduled, resultOf(toolUseId, { scheduledFor: START + 300_000 }))
  return scheduled
}

const QUEUE = { cron: '*/10 * * * *', prompt: 'Check the staging queue.', recurring: true }

/** The agent schedules a cron job. */
function createCron(toolUseId = 'toolu_cron', input: ToolInput = QUEUE, id = 'c7a1'): void {
  const created = call(toolUseId, 'CronCreate', input)
  const recurring = input.recurring !== false
  tracker.toolResult(task.id, created, resultOf(toolUseId, { id, humanSchedule: 'Every 10 minutes', recurring }))
}

function job(id: string, prompt: string, recurring: boolean, schedule = '*/10 * * * *'): SessionJob {
  return { id, schedule, recurring, prompt }
}

describe('a Monitor', () => {
  it('is running from its task starting, with its description, command and timeout, and broadcast', () => {
    armMonitor()

    expect(only()).toMatchObject({
      kind: WatcherKind.Monitor,
      toolUseId: 'toolu_ci',
      sdkId: 'bci',
      label: CI.description,
      detail: CI.command,
      recurring: true,
      state: WatcherState.Running,
      wakes: 0,
      lastWokeAt: null,
      lastOutput: null,
      nextDueAt: null,
      expiresAt: START + 1_800_000,
      outcome: null,
      startedAt: START,
      endedAt: null,
    })
    expect(broadcast()).toEqual([expect.objectContaining({ label: CI.description, state: WatcherState.Running })])
    // What only matching the SDK's reports needs stays in main.
    expect(broadcast()?.[0]).not.toHaveProperty('sdkId')
    expect(broadcast()?.[0]).not.toHaveProperty('stoppedByYou')
  })

  it('counts each event that wakes the agent, keeping its last line, then finishes when its stream ends', () => {
    armMonitor()
    clock = START + 60_000
    expect(tracker.prompt(task.id, eventNotice('bci', CI.description, 'lint\tpass'))).toBe(PromptVerdict.Allow)
    clock = START + 120_000
    tracker.prompt(task.id, eventNotice('bci', CI.description, 'build\tpass\nunit-tests\tfail'))
    expect(only()).toMatchObject({ wakes: 2, lastWokeAt: START + 120_000, lastOutput: 'unit-tests\tfail' })

    clock = START + 180_000
    tracker.taskFinished(task.id, finished('toolu_ci', 'bci', TaskOutcome.Completed, 'Monitor "CI" stream ended'))
    // The ending wakes it too, with the watch's last event.
    tracker.prompt(task.id, endNotice('bci', 'toolu_ci', 'completed', 'Monitor "CI" stream ended', 'e2e\tpass'))

    expect(only()).toMatchObject({
      state: WatcherState.Finished,
      wakes: 3,
      lastOutput: 'e2e\tpass',
      outcome: 'Monitor "CI" stream ended',
      endedAt: START + 180_000,
    })
    expect(broadcast()?.[0]?.state).toBe(WatcherState.Finished)
  })

  it('fails when its script exits with an error', () => {
    armMonitor()
    tracker.taskFinished(
      task.id,
      finished('toolu_ci', 'bci', TaskOutcome.Failed, 'Monitor "CI" script failed (exit 7)'),
    )
    expect(only()).toMatchObject({ state: WatcherState.Failed, outcome: 'Monitor "CI" script failed (exit 7)' })
  })

  it('ends as the wake that reports its ending says, even before its notification comes', () => {
    armMonitor()
    tracker.prompt(task.id, endNotice('bci', 'toolu_ci', 'failed', 'Monitor "CI" script failed (exit 7)'))
    expect(only()).toMatchObject({ state: WatcherState.Failed, wakes: 1 })
    // The notification after it changes nothing more.
    const before = events.length
    tracker.taskFinished(task.id, finished('toolu_ci', 'bci', TaskOutcome.Completed, 'late'))
    expect(only().state).toBe(WatcherState.Failed)
    expect(events).toHaveLength(before)
    // A status it doesn't know counts the wake and ends nothing.
    armMonitor(task.id, 'toolu_2', 'b2')
    tracker.prompt(task.id, endNotice('b2', 'toolu_2', 'exploded', 'What?'))
    expect(listWatchers(database.db, task.id)[1]).toMatchObject({ state: WatcherState.Running, wakes: 1 })
  })

  it('says who stopped it: you, the agent, or its timeout', () => {
    armMonitor()
    expect(tracker.requestStop(task.id, only().id)).toEqual({ action: StopAction.StopTask, sdkTaskId: 'bci' })
    // Still running until the SDK says it stopped.
    expect(only().state).toBe(WatcherState.Running)
    tracker.taskFinished(task.id, finished('toolu_ci', 'bci', TaskOutcome.Stopped, CI.description))
    expect(only()).toMatchObject({ state: WatcherState.Stopped, outcome: STOPPED_BY_YOU })

    armMonitor(task.id, 'toolu_2', 'b2')
    clock = START + 60_000
    tracker.taskFinished(task.id, finished('toolu_2', 'b2', TaskOutcome.Stopped, CI.description))
    expect(listWatchers(database.db, task.id)[1]?.outcome).toBe(STOPPED_BY_AGENT)

    clock = START
    armMonitor(task.id, 'toolu_3', 'b3')
    // The SDK's timer can go off a moment before Glade's clock says it's due.
    clock = START + 60_000 + 1_800_000 - 1_000
    tracker.taskFinished(task.id, finished('toolu_3', 'b3', TaskOutcome.Stopped, CI.description))
    expect(listWatchers(database.db, task.id)[2]?.outcome).toBe(TIMED_OUT)
  })

  it('takes its timeout from what the SDK says of the call, or none for a persistent watch', () => {
    armMonitor()
    expect(only().expiresAt).toBe(START + 1_800_000)

    // The call armMonitor made, as the runner hands it over with its result.
    const monitorCall: ToolCallEvent = { ...call('toolu_other', 'Monitor', CI), toolUseId: 'toolu_ci' }
    tracker.toolResult(task.id, monitorCall, resultOf('toolu_ci', { taskId: 'bci', timeoutMs: 60_000 }))
    expect(only().expiresAt).toBe(START + 60_000)
    tracker.toolResult(task.id, monitorCall, resultOf('toolu_ci', { taskId: 'bci', timeoutMs: 0, persistent: true }))
    expect(only().expiresAt).toBeNull()
    // An account it can't read, or a watch it doesn't know, changes nothing.
    const before = events.length
    tracker.toolResult(task.id, monitorCall, resultOf('toolu_ci', 'nonsense'))
    tracker.toolResult(task.id, { ...monitorCall, toolUseId: 'toolu_unknown' }, resultOf('toolu_unknown', {}))
    tracker.toolResult(task.id, monitorCall, resultOf('toolu_ci', { timeoutMs: 0 }))
    expect(events).toHaveLength(before)
  })

  it('defaults its timeout to five minutes, caps it at thirty, and reads a WebSocket watch', () => {
    call('toolu_a', 'Monitor', { description: 'Deploys', command: 'tail -F deploy.log' })
    tracker.taskStarted(task.id, started('toolu_a', 'ba', 'Deploys'), null)
    call('toolu_b', 'Monitor', { description: 'Long', timeout_ms: 99_000_000, command: 'x' })
    tracker.taskStarted(task.id, started('toolu_b', 'bb', 'Long'), null)
    call('toolu_c', 'Monitor', { timeout_ms: 1_000, ws: { url: 'wss://ci.example.com/events' } })
    tracker.taskStarted(task.id, started('toolu_c', 'bc', 'CI events'), null)

    expect(
      listWatchers(database.db, task.id).map(({ expiresAt, label, detail }) => [expiresAt, label, detail]),
    ).toEqual([
      [START + 300_000, 'Deploys', 'tail -F deploy.log'],
      [START + 1_800_000, 'Long', 'x'],
      [START + 1_000, 'CI events', 'wss://ci.example.com/events'],
    ])
  })
})

describe('a background command', () => {
  it('runs from its task starting, then finishes, waking the agent once, with the SDK’s summary', () => {
    runCommand()
    expect(only()).toMatchObject({
      kind: WatcherKind.Command,
      label: 'Integration tests',
      detail: 'npm run test:integration',
      recurring: false,
      state: WatcherState.Running,
      expiresAt: null,
    })
    clock = START + 90_000
    tracker.taskFinished(
      task.id,
      finished('toolu_tests', 'btests', TaskOutcome.Completed, 'Background command "Integration tests" completed'),
    )
    tracker.prompt(task.id, endNotice('btests', 'toolu_tests', 'completed', 'Background command completed'))
    expect(only()).toMatchObject({
      state: WatcherState.Finished,
      wakes: 1,
      lastWokeAt: START + 90_000,
      lastOutput: null,
      outcome: 'Background command "Integration tests" completed',
      endedAt: START + 90_000,
    })
  })

  it('fails with its exit code, and stops as you or the agent stopped it', () => {
    runCommand('toolu_1', 'b1')
    tracker.taskFinished(task.id, finished('toolu_1', 'b1', TaskOutcome.Failed, 'failed with exit code 3'))
    runCommand('toolu_2', 'b2')
    expect(tracker.requestStop(task.id, listWatchers(database.db, task.id)[1]?.id ?? '')).toEqual({
      action: StopAction.StopTask,
      sdkTaskId: 'b2',
    })
    tracker.taskFinished(task.id, finished('toolu_2', 'b2', TaskOutcome.Stopped, 'Integration tests'))
    runCommand('toolu_3', 'b3')
    tracker.taskFinished(task.id, finished('toolu_3', 'b3', TaskOutcome.Stopped, 'Integration tests'))

    expect(listWatchers(database.db, task.id).map(({ state, outcome }) => [state, outcome])).toEqual([
      [WatcherState.Failed, 'failed with exit code 3'],
      [WatcherState.Stopped, STOPPED_BY_YOU],
      [WatcherState.Stopped, STOPPED_BY_AGENT],
    ])
  })

  it('is named after its command when neither its call nor its task has a description', () => {
    call('toolu_q', 'Bash', { command: 'sleep 300', run_in_background: true })
    tracker.taskStarted(task.id, started('toolu_q', 'bq'), null)
    // A task the SDK moved to the background that Glade has no call for.
    tracker.taskStarted(task.id, started('toolu_missing', 'bm', 'Something slow'), null)
    expect(listWatchers(database.db, task.id).map(({ label, detail }) => [label, detail])).toEqual([
      ['sleep 300', 'sleep 300'],
      ['Something slow', ''],
    ])
  })

  it('leaves subagents to the Subagents tab, and a task started twice is one watcher', () => {
    call('toolu_agent', 'Agent', { description: 'Profile it', run_in_background: true })
    tracker.taskStarted(task.id, started('toolu_agent', 'a1', 'Profile it', 'local_agent'), null)
    tracker.taskStarted(task.id, { ...started('toolu_x', 'x1'), taskType: null }, null)
    expect(listWatchers(database.db, task.id)).toEqual([])

    runCommand()
    tracker.taskStarted(task.id, started('toolu_tests', 'btests', 'Integration tests'), null)
    expect(listWatchers(database.db, task.id)).toHaveLength(1)
  })

  it('ignores ends, wakes and stops of tasks it does not follow', () => {
    runCommand()
    const before = events.length
    tracker.taskFinished(task.id, finished('toolu_agent', 'a1', TaskOutcome.Completed, 'A subagent'))
    expect(tracker.prompt(task.id, eventNotice('a1', 'A subagent', 'x'))).toBe(PromptVerdict.Allow)
    expect(tracker.requestStop(task.id, 'no-such-watcher')).toBeUndefined()
    expect(tracker.requestStop('another-task', only().id)).toBeUndefined()
    expect(events).toHaveLength(before)
    expect(only()).toMatchObject({ state: WatcherState.Running, wakes: 0 })
  })
})

describe('a ScheduleWakeup', () => {
  it('is scheduled for its time, named by its reason, and learns its job id when the turn ends', () => {
    scheduleWakeup()
    expect(only()).toMatchObject({
      kind: WatcherKind.Wakeup,
      sdkId: null,
      label: 'Check the rollout',
      detail: 'Check the rollout.',
      recurring: false,
      state: WatcherState.Scheduled,
      nextDueAt: START + 300_000,
    })
    tracker.jobsListed(task.id, [job('f4f5', 'Check the rollout.', false, '12 13 * * *')])
    expect(only()).toMatchObject({ sdkId: 'f4f5', state: WatcherState.Scheduled })
  })

  it('finishes once it fires, counting the wake', () => {
    scheduleWakeup()
    clock = START + 300_000
    expect(tracker.prompt(task.id, 'Check the rollout.')).toBe(PromptVerdict.Allow)
    expect(only()).toMatchObject({
      state: WatcherState.Finished,
      wakes: 1,
      lastWokeAt: START + 300_000,
      nextDueAt: null,
      outcome: FIRED,
      endedAt: START + 300_000,
    })
    // Its prompt again is just a prompt.
    expect(tracker.prompt(task.id, 'Check the rollout.')).toBe(PromptVerdict.Allow)
    expect(only().wakes).toBe(1)
  })

  it('is cancelled by the agent’s ScheduleWakeup with stop, and by CronDelete of its job', () => {
    scheduleWakeup('toolu_1')
    scheduleWakeup('toolu_2', { ...ROLLOUT, prompt: 'Check again.' })
    tracker.jobsListed(task.id, [job('w1', 'Check the rollout.', false), job('w2', 'Check again.', false)])
    const deleted = call('toolu_del', 'CronDelete', { id: 'w2' })
    tracker.toolResult(task.id, deleted, resultOf('toolu_del', { id: 'w2' }))
    expect(listWatchers(database.db, task.id).map(({ state, outcome }) => [state, outcome])).toEqual([
      [WatcherState.Scheduled, null],
      [WatcherState.Stopped, CANCELLED_BY_AGENT],
    ])

    const stop = call('toolu_stop', 'ScheduleWakeup', { stop: true })
    tracker.toolResult(task.id, stop, resultOf('toolu_stop', { scheduledFor: 0, stopped: true, cancelledWakeups: 1 }))
    expect(listWatchers(database.db, task.id)[0]).toMatchObject({
      state: WatcherState.Stopped,
      outcome: CANCELLED_BY_AGENT,
    })
    expect(listWatchers(database.db, task.id)).toHaveLength(2)
    // With nothing left to cancel, nothing changes.
    const before = events.length
    tracker.toolResult(task.id, call('toolu_stop2', 'ScheduleWakeup', { stop: true }), resultOf('toolu_stop2', {}))
    expect(events).toHaveLength(before)
  })

  it('is left out when its call failed or its result says no time', () => {
    const failed = call('toolu_f', 'ScheduleWakeup', ROLLOUT)
    tracker.toolResult(task.id, failed, resultOf('toolu_f', { scheduledFor: START }, true))
    tracker.toolResult(task.id, failed, resultOf('toolu_f', { clampedDelaySeconds: 60 }))
    tracker.toolResult(
      task.id,
      call('toolu_n', 'ScheduleWakeup', { delaySeconds: 60 }),
      resultOf('toolu_n', { scheduledFor: START + 60_000 }),
    )
    // One with no reason or prompt still shows, as a plain wakeup.
    expect(listWatchers(database.db, task.id).map(({ label, detail }) => [label, detail])).toEqual([['Wakeup', '']])
  })

  it('stops at once when you stop it, and its fire is turned away', () => {
    scheduleWakeup()
    tracker.jobsListed(task.id, [job('w1', 'Check the rollout.', false)])
    clock = START + 10_000
    expect(tracker.requestStop(task.id, only().id)).toEqual({ action: StopAction.None })
    expect(only()).toMatchObject({
      state: WatcherState.Stopped,
      outcome: STOPPED_BY_YOU,
      nextDueAt: null,
      endedAt: START + 10_000,
    })
    expect(broadcast()?.[0]?.state).toBe(WatcherState.Stopped)
    // Stopping it again: it has ended.
    expect(tracker.requestStop(task.id, only().id)).toBeUndefined()

    expect(tracker.prompt(task.id, 'Check the rollout.')).toBe(PromptVerdict.Block)
    expect(only().wakes).toBe(0)
    // A job the agent cancelled isn't yours to turn away.
    scheduleWakeup('toolu_2', { ...ROLLOUT, prompt: 'Check again.' })
    tracker.toolResult(task.id, call('toolu_stop', 'ScheduleWakeup', { stop: true }), resultOf('toolu_stop', {}))
    expect(tracker.prompt(task.id, 'Check again.')).toBe(PromptVerdict.Allow)
  })

  it('counts a fire on the job with that prompt due soonest', () => {
    const later = call('toolu_later', 'ScheduleWakeup', ROLLOUT)
    tracker.toolResult(task.id, later, resultOf('toolu_later', { scheduledFor: START + 600_000 }))
    scheduleWakeup('toolu_sooner')
    createCron('toolu_cron', { cron: '0 0 30 2 *', prompt: 'Check the rollout.', recurring: true }, 'c1')
    tracker.prompt(task.id, 'Check the rollout.')
    expect(listWatchers(database.db, task.id).map(({ toolUseId, wakes }) => [toolUseId, wakes])).toEqual([
      ['toolu_later', 0],
      ['toolu_sooner', 1],
      ['toolu_cron', 0],
    ])
  })

  it('isn’t turned away when another live job has the same prompt: that one fires', () => {
    scheduleWakeup('toolu_1')
    tracker.requestStop(task.id, only().id)
    scheduleWakeup('toolu_2')
    expect(tracker.prompt(task.id, 'Check the rollout.')).toBe(PromptVerdict.Allow)
    expect(listWatchers(database.db, task.id).map(({ state, wakes }) => [state, wakes])).toEqual([
      [WatcherState.Stopped, 0],
      [WatcherState.Finished, 1],
    ])
  })
})

describe('a CronCreate job', () => {
  it('is scheduled with its schedule in words and when it is next due', () => {
    createCron()
    expect(only()).toMatchObject({
      kind: WatcherKind.Cron,
      sdkId: 'c7a1',
      label: 'Check the staging queue.',
      detail: 'Check the staging queue.',
      cron: '*/10 * * * *',
      schedule: 'Every 10 minutes',
      recurring: true,
      state: WatcherState.Scheduled,
      nextDueAt: new Date(2026, 8, 25, 13, 10).getTime(),
    })
  })

  it('stays scheduled as a recurring job fires, counting each wake and moving on to its next time', () => {
    createCron()
    clock = new Date(2026, 8, 25, 13, 10, 2).getTime()
    tracker.prompt(task.id, 'Check the staging queue.')
    clock = new Date(2026, 8, 25, 13, 20, 1).getTime()
    tracker.prompt(task.id, 'Check the staging queue.')
    expect(only()).toMatchObject({
      state: WatcherState.Scheduled,
      wakes: 2,
      lastWokeAt: clock,
      nextDueAt: new Date(2026, 8, 25, 13, 30).getTime(),
    })
  })

  it('finishes when a one-off job fires, and when the session no longer has a recurring one (it expired)', () => {
    createCron('toolu_once', { cron: '30 14 25 9 *', prompt: 'Check the migration.', recurring: false }, 'c3f8')
    createCron('toolu_rec', QUEUE, 'c7a1')
    tracker.prompt(task.id, 'Check the migration.')
    tracker.jobsListed(task.id, [])
    expect(listWatchers(database.db, task.id).map(({ state, outcome }) => [state, outcome])).toEqual([
      [WatcherState.Finished, FIRED],
      [WatcherState.Finished, NO_LONGER_SCHEDULED],
    ])
  })

  it('keeps its first line as its name, and takes the expression when the SDK gives no words for it', () => {
    const created = call('toolu_c', 'CronCreate', { cron: '0 9 * * 1-5', prompt: '\nCheck the queue.\nThen report.' })
    tracker.toolResult(task.id, created, resultOf('toolu_c', { id: 'c1' }))
    expect(only()).toMatchObject({ label: 'Check the queue.', schedule: '0 9 * * 1-5', recurring: true })
    // A result it can't read, or a failed call, makes none.
    tracker.toolResult(task.id, call('toolu_d', 'CronCreate', { cron: 'x' }), resultOf('toolu_d', { id: 'c2' }))
    tracker.toolResult(task.id, call('toolu_e', 'CronCreate', QUEUE), resultOf('toolu_e', { humanSchedule: 'x' }))
    expect(listWatchers(database.db, task.id)).toHaveLength(1)
    // An expression that never matches has no next time.
    tracker.toolResult(
      task.id,
      call('toolu_f', 'CronCreate', { cron: '0 0 30 2 *', prompt: 'Never.' }),
      resultOf('toolu_f', { id: 'c3' }),
    )
    expect(listWatchers(database.db, task.id)[1]?.nextDueAt).toBeNull()
  })

  it('stops when the agent deletes it; deleting one it doesn’t know, or one already ended, changes nothing', () => {
    createCron()
    tracker.toolResult(task.id, call('toolu_d', 'CronDelete', { id: 'c7a1' }), resultOf('toolu_d', { id: 'c7a1' }))
    expect(only()).toMatchObject({ state: WatcherState.Stopped, outcome: CANCELLED_BY_AGENT })
    const before = events.length
    tracker.toolResult(task.id, call('toolu_d2', 'CronDelete', { id: 'c7a1' }), resultOf('toolu_d2', { id: 'c7a1' }))
    tracker.toolResult(task.id, call('toolu_d3', 'CronDelete', { id: 'nope' }), resultOf('toolu_d3', { id: 'nope' }))
    tracker.toolResult(task.id, call('toolu_d4', 'CronDelete', {}), resultOf('toolu_d4', {}))
    tracker.toolResult(task.id, call('toolu_r', 'Read', { file_path: 'a.ts' }), resultOf('toolu_r', {}))
    expect(events).toHaveLength(before)
  })

  it('stops at once when you stop it, and every fire after is turned away', () => {
    createCron()
    tracker.prompt(task.id, 'Check the staging queue.')
    expect(tracker.requestStop(task.id, only().id)).toEqual({ action: StopAction.None })
    expect(only()).toMatchObject({ state: WatcherState.Stopped, outcome: STOPPED_BY_YOU, wakes: 1 })
    for (let fire = 0; fire < 3; fire += 1) {
      expect(tracker.prompt(task.id, 'Check the staging queue.')).toBe(PromptVerdict.Block)
    }
    expect(only().wakes).toBe(1)
    // The session still lists it (only the agent can delete it): it stays stopped.
    tracker.jobsListed(task.id, [job('c7a1', 'Check the staging queue.', true)])
    expect(only().state).toBe(WatcherState.Stopped)
    // Another task's prompt is its own.
    const other = createTask(database.db, { workspaceId: task.workspaceId, model: 'm', effort: Effort.Low })
    expect(tracker.prompt(other.id, 'Check the staging queue.')).toBe(PromptVerdict.Allow)
  })
})

describe('the session’s jobs, listed at the end of each turn', () => {
  it('names each wakeup by the first unclaimed one-off job with its prompt, oldest first', () => {
    scheduleWakeup('toolu_1')
    scheduleWakeup('toolu_2')
    createCron('toolu_c', { cron: '5 13 * * *', prompt: 'Check the rollout.', recurring: false }, 'c1')
    tracker.jobsListed(task.id, [
      job('c1', 'Check the rollout.', false),
      job('w1', 'Check the rollout.', true),
      job('w2', 'Check the rollout.', false),
      job('w3', 'Check the rollout.', false),
    ])
    expect(listWatchers(database.db, task.id).map(({ sdkId }) => sdkId)).toEqual(['w2', 'w3', 'c1'])
  })

  it('leaves a wakeup it can’t name yet as it is, and changes nothing when all is as it was', () => {
    scheduleWakeup()
    const before = events.length
    tracker.jobsListed(task.id, [job('x', 'Something else.', false)])
    expect(only()).toMatchObject({ sdkId: null, state: WatcherState.Scheduled })
    expect(events).toHaveLength(before)
  })
})

describe('when a session ends', () => {
  function everyKind(): void {
    armMonitor()
    runCommand()
    scheduleWakeup()
    createCron()
    tracker.jobsListed(task.id, [job('w1', 'Check the rollout.', false), job('c7a1', 'Check the staging queue.', true)])
  }

  it('on a relaunch, running watchers and wakeups stop with it, and cron jobs wait for the session to resume', () => {
    everyKind()
    const done = createTask(database.db, { workspaceId: task.workspaceId, model: 'm', effort: Effort.Low })
    armMonitor(done.id, 'toolu_done', 'bdone')
    markTaskDone({ db: database.db, emit: () => undefined }, done.id)
    clock = START + 500_000
    events.length = 0

    tracker.relaunched()

    expect(
      listWatchers(database.db, task.id).map(({ kind, state, outcome, endedAt }) => [kind, state, outcome, endedAt]),
    ).toEqual([
      [WatcherKind.Monitor, WatcherState.Stopped, STOPPED_BY_RELAUNCH, START + 500_000],
      [WatcherKind.Command, WatcherState.Stopped, STOPPED_BY_RELAUNCH, START + 500_000],
      [WatcherKind.Wakeup, WatcherState.Stopped, STOPPED_BY_RELAUNCH, START + 500_000],
      [WatcherKind.Cron, WatcherState.Suspended, null, null],
    ])
    // A done task's watcher too, and each task is told once.
    expect(only(done.id).state).toBe(WatcherState.Stopped)
    expect(events.map((event) => (event.type === EventType.WatchersChanged ? event.taskId : null))).toEqual([
      task.id,
      done.id,
    ])
    // Nothing is live any more but the suspended job: a second launch changes nothing.
    tracker.relaunched()
    expect(events).toHaveLength(2)
  })

  it('a suspended job comes back when the resumed session lists it, or ends when it doesn’t', () => {
    everyKind()
    createCron('toolu_gone', { cron: '0 * * * *', prompt: 'Hourly.', recurring: true }, 'c9')
    tracker.relaunched()
    clock = new Date(2026, 8, 25, 14, 3).getTime()
    tracker.jobsListed(task.id, [job('c7a1', 'Check the staging queue.', true)])
    const [, , , queue, gone] = listWatchers(database.db, task.id)
    expect(queue).toMatchObject({ state: WatcherState.Scheduled, nextDueAt: new Date(2026, 8, 25, 14, 10).getTime() })
    expect(gone).toMatchObject({ state: WatcherState.Finished, outcome: NO_LONGER_SCHEDULED })
  })

  it('a suspended job that fires is scheduled again, and one you stop is stopped', () => {
    createCron()
    createCron('toolu_2', { cron: '0 * * * *', prompt: 'Hourly.', recurring: true }, 'c9')
    tracker.relaunched()
    tracker.prompt(task.id, 'Check the staging queue.')
    const [queue, hourly] = listWatchers(database.db, task.id)
    expect(queue).toMatchObject({ state: WatcherState.Scheduled, wakes: 1 })
    expect(tracker.requestStop(task.id, hourly?.id ?? '')).toEqual({ action: StopAction.None })
    expect(getWatcher(database.db, hourly?.id ?? '')).toMatchObject({
      state: WatcherState.Stopped,
      outcome: STOPPED_BY_YOU,
    })
  })

  it('a failed session stops its running watchers and wakeups with its message, and suspends its jobs', () => {
    everyKind()
    tracker.sessionEnded(task.id, 'The agent stopped: exit 1')
    expect(listWatchers(database.db, task.id).map(({ state, outcome }) => [state, outcome])).toEqual([
      [WatcherState.Stopped, 'The agent stopped: exit 1'],
      [WatcherState.Stopped, 'The agent stopped: exit 1'],
      [WatcherState.Stopped, 'The agent stopped: exit 1'],
      [WatcherState.Suspended, null],
    ])
    const before = events.length
    tracker.sessionEnded(task.id, 'Again')
    expect(events).toHaveLength(before)
  })
})

describe('many watchers', () => {
  it('follows each one apart, in the order they started', () => {
    for (let index = 0; index < 40; index += 1) {
      clock = START + index
      if (index % 2 === 0) armMonitor(task.id, `toolu_m${String(index)}`, `bm${String(index)}`)
      else runCommand(`toolu_c${String(index)}`, `bc${String(index)}`, `job ${String(index)}`)
    }
    for (let index = 0; index < 40; index += 4) {
      tracker.prompt(task.id, eventNotice(`bm${String(index)}`, 'CI', `event ${String(index)}`))
    }
    tracker.taskFinished(task.id, finished('toolu_c39', 'bc39', TaskOutcome.Completed, 'done'))

    const watchers = listWatchers(database.db, task.id)
    expect(watchers).toHaveLength(40)
    expect(watchers.map(({ startedAt }) => startedAt)).toEqual(watchers.map((_, index) => START + index))
    expect(watchers.filter(({ wakes }) => wakes === 1).map(({ lastOutput }) => lastOutput)).toEqual(
      [0, 4, 8, 12, 16, 20, 24, 28, 32, 36].map((index) => `event ${String(index)}`),
    )
    expect(watchers.filter(({ state }) => state === WatcherState.Finished).map(({ sdkId }) => sdkId)).toEqual(['bc39'])
    expect(broadcast()).toHaveLength(40)
  })

  it('counts the wakes of several watches that wake the agent together', () => {
    armMonitor(task.id, 'toolu_1', 'b1')
    armMonitor(task.id, 'toolu_2', 'b2')
    const before = events.length
    tracker.prompt(task.id, `${eventNotice('b1', 'CI', 'one')}\n${eventNotice('b2', 'CI', 'two')}`)
    expect(listWatchers(database.db, task.id).map(({ wakes, lastOutput }) => [wakes, lastOutput])).toEqual([
      [1, 'one'],
      [1, 'two'],
    ])
    expect(events).toHaveLength(before + 1)
  })
})

describe('a watcher on a done task', () => {
  it('keeps running, waking the agent and ending as usual', () => {
    armMonitor()
    markTaskDone({ db: database.db, emit: () => undefined }, task.id)
    tracker.prompt(task.id, eventNotice('bci', CI.description, 'still watching'))
    tracker.taskFinished(task.id, finished('toolu_ci', 'bci', TaskOutcome.Completed, 'ended'))
    expect(only()).toMatchObject({ wakes: 1, lastOutput: 'still watching', state: WatcherState.Finished })
  })
})

describe('what it is told that isn’t about a watcher', () => {
  it('lets every other prompt through, changing nothing', () => {
    armMonitor()
    updateWatcher(database.db, only().id, { stoppedByYou: true })
    const before = events.length
    expect(tracker.prompt(task.id, 'Fix the flaky test.')).toBe(PromptVerdict.Allow)
    expect(tracker.prompt(task.id, CI.command)).toBe(PromptVerdict.Allow)
    expect(events).toHaveLength(before)
  })
})

/** A call as the tool log has it. */
function logged(toolUseId: string): ToolCallEvent {
  const found = getToolCall(database.db, task.id, toolUseId)
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

/** A call a subagent made (its `Agent` call, `parent`), as the runner logged it. */
function subagentCall(toolUseId: string, name: string, input: ToolInput, parent: string): ToolCallEvent {
  appendToolCall(database.db, { taskId: task.id, turn: 1, name, input, toolUseId, parentToolUseId: parent })
  return updateToolCall(database.db, { taskId: task.id, toolUseId, state: ToolCallState.Done, output: 'ok' })
}

/** A foreground `Bash` call, and the task the SDK starts for it once it has run a few seconds. */
function runInForeground(toolUseId = 'toolu_fg', sdkTaskId = 'bfg'): void {
  call(toolUseId, 'Bash', { command: 'gh pr checks 42 --watch', description: 'Wait for CI' })
  tracker.taskStarted(task.id, started(toolUseId, sdkTaskId, 'Wait for CI', 'local_bash', false), null)
}

describe("a subagent's watchers (#291)", () => {
  it('belong to the subagent whose call started them, or to the one the runner names for a call it never logged', () => {
    subagentCall('toolu_agent', 'Agent', { description: 'Fix the flaky test' }, 'toolu_top')
    subagentCall('toolu_e2e', 'Bash', { command: 'npm run test:e2e', run_in_background: true }, 'toolu_agent')
    tracker.taskStarted(task.id, started('toolu_e2e', 'be2e'), 'toolu_ignored')
    subagentCall('toolu_watch', 'Monitor', CI, 'toolu_agent')
    tracker.taskStarted(task.id, started('toolu_watch', 'bwatch', CI.description), null)
    tracker.taskStarted(task.id, started('toolu_unlogged', 'bun', 'Wait for CI'), 'toolu_agent')
    const wake = subagentCall('toolu_wake', 'ScheduleWakeup', ROLLOUT, 'toolu_agent')
    tracker.toolResult(task.id, wake, resultOf('toolu_wake', { scheduledFor: START + 300_000 }))
    const cron = subagentCall('toolu_cron', 'CronCreate', { cron: '*/5 * * * *', prompt: 'Look again.' }, 'toolu_agent')
    tracker.toolResult(task.id, cron, resultOf('toolu_cron', { id: 'c1' }))

    expect(listWatchers(database.db, task.id).map(({ kind, parentToolUseId }) => [kind, parentToolUseId])).toEqual([
      [WatcherKind.Command, 'toolu_agent'],
      [WatcherKind.Monitor, 'toolu_agent'],
      [WatcherKind.Command, 'toolu_agent'],
      [WatcherKind.Wakeup, 'toolu_agent'],
      [WatcherKind.Cron, 'toolu_agent'],
    ])
    expect(broadcast()?.every(({ parentToolUseId }) => parentToolUseId === 'toolu_agent')).toBe(true)
  })

  it('end with it when it’s stopped, and those of the subagents it started, but not its jobs or anyone else’s', () => {
    subagentCall('toolu_agent', 'Agent', { description: 'Fix the flaky test' }, 'toolu_top')
    subagentCall('toolu_nested', 'Agent', { description: 'Bisect' }, 'toolu_agent')
    subagentCall('toolu_e2e', 'Bash', { command: 'npm run test:e2e', run_in_background: true }, 'toolu_agent')
    tracker.taskStarted(task.id, started('toolu_e2e', 'be2e', 'e2e'), null)
    subagentCall('toolu_bisect', 'Monitor', CI, 'toolu_nested')
    tracker.taskStarted(task.id, started('toolu_bisect', 'bbis', 'bisect'), null)
    runCommand()
    const cron = subagentCall('toolu_cron', 'CronCreate', { cron: '*/5 * * * *', prompt: 'Look again.' }, 'toolu_agent')
    tracker.toolResult(task.id, cron, resultOf('toolu_cron', { id: 'c1' }))
    // Its foreground command's task is forgotten with it: it's never promoted later.
    subagentCall('toolu_fg', 'Bash', { command: 'npm test' }, 'toolu_nested')
    tracker.taskStarted(task.id, started('toolu_fg', 'bfg', 'npm test', 'local_bash', false), null)

    clock += 5_000
    expect(tracker.subagentStopped(task.id, 'toolu_agent')).toEqual(['be2e', 'bbis'])
    expect(listWatchers(database.db, task.id).map(({ label, state, outcome }) => [label, state, outcome])).toEqual([
      ['e2e', WatcherState.Stopped, ENDED_WITH_SUBAGENT],
      [CI.description, WatcherState.Stopped, ENDED_WITH_SUBAGENT],
      ['Integration tests', WatcherState.Running, null],
      ['Look again.', WatcherState.Scheduled, null],
    ])
    expect(broadcast()?.[0]?.endedAt).toBe(START + 5_000)
    tracker.taskBackgrounded(task.id, 'bfg')
    expect(listWatchers(database.db, task.id)).toHaveLength(4)

    // Stopped again, or a subagent with nothing live, changes nothing.
    const before = events.length
    expect(tracker.subagentStopped(task.id, 'toolu_agent')).toEqual([])
    expect(tracker.subagentStopped(task.id, 'toolu_nobody')).toEqual([])
    expect(events).toHaveLength(before)
  })

  it('finds whose a call is without looping, whatever the tool log says', () => {
    subagentCall('toolu_a', 'Agent', { description: 'A' }, 'toolu_b')
    subagentCall('toolu_b', 'Agent', { description: 'B' }, 'toolu_a')
    subagentCall('toolu_cmd', 'Bash', { command: 'x', run_in_background: true }, 'toolu_a')
    tracker.taskStarted(task.id, started('toolu_cmd', 'bcmd', 'x'), null)
    expect(tracker.subagentStopped(task.id, 'toolu_c')).toEqual([])
    expect(tracker.subagentStopped(task.id, 'toolu_b')).toEqual(['bcmd'])
  })
})

describe('a foreground command (#291)', () => {
  it('isn’t a watcher, though the SDK runs it as a task, and is forgotten once it ends', () => {
    runInForeground()
    expect(listWatchers(database.db, task.id)).toEqual([])
    expect(events).toEqual([])

    tracker.taskFinished(task.id, finished('toolu_fg', 'bfg', TaskOutcome.Completed, 'Wait for CI'))
    tracker.taskBackgrounded(task.id, 'bfg')
    runInForeground('toolu_fg2', 'bfg2')
    const failed = logged('toolu_fg2')
    tracker.toolResult(task.id, failed, { ...resultOf('toolu_fg2', null, true), output: 'moved to the background' })
    tracker.taskBackgrounded(task.id, 'bfg2')
    runInForeground('toolu_fg3', 'bfg3')
    tracker.toolResult(task.id, logged('toolu_fg3'), resultOf('toolu_fg3', { stdout: 'all green' }))
    tracker.taskBackgrounded(task.id, 'bfg3')
    runInForeground('toolu_fg4', 'bfg4')
    tracker.sessionEnded(task.id, 'The agent stopped: exit 1')
    tracker.taskBackgrounded(task.id, 'bfg4')
    expect(listWatchers(database.db, task.id)).toEqual([])
    expect(events).toEqual([])
  })

  it('becomes a watcher when the SDK moves it to the background, from when it started, once', () => {
    runInForeground()
    clock += 600_000
    tracker.taskBackgrounded(task.id, 'bfg')
    tracker.taskBackgrounded(task.id, 'bfg')
    expect(only()).toMatchObject({
      kind: WatcherKind.Command,
      label: 'Wait for CI',
      detail: 'gh pr checks 42 --watch',
      state: WatcherState.Running,
      startedAt: START,
    })
    expect(broadcast()).toHaveLength(1)
    // Its result, which says so too, changes nothing more.
    const before = events.length
    tracker.toolResult(task.id, logged('toolu_fg'), resultOf('toolu_fg', { backgroundTaskId: 'bfg' }))
    expect(events).toHaveLength(before)
  })

  it('becomes a watcher from its result, by what the SDK says of it or by its words', () => {
    runInForeground('toolu_a', 'ba')
    tracker.toolResult(task.id, logged('toolu_a'), resultOf('toolu_a', { backgroundTaskId: 'ba' }))
    runInForeground('toolu_b', 'bb')
    tracker.toolResult(task.id, logged('toolu_b'), {
      ...resultOf('toolu_b', null),
      output: 'Command did not complete within its 600s timeout and was moved to the background (ID: bb).',
    })
    expect(listWatchers(database.db, task.id).map(({ toolUseId }) => toolUseId)).toEqual(['toolu_a', 'toolu_b'])
  })
})
