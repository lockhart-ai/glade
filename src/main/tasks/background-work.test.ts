import { afterEach, beforeEach, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { ToolCallState, WatcherKind, WatcherState, type Task } from '../../shared/domain'
import { deleteTask, getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendNarration, appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { addWatcher, listWatchers, publicWatcher, updateWatcher } from '../db/repositories/watchers'
import { createBackgroundWorkWatch, type BackgroundWorkWatch } from './background-work'

let test: TestDatabase
let task: Task
let other: Task
let watch: BackgroundWorkWatch
/** Every event sent, as the bridge sends them: each one is heard by the watch too. */
let sent: GladeEvent[]

function emit(event: GladeEvent): void {
  sent.push(event)
  watch.observe(event)
}

/** The tasks sent again, and whether each was read with background work. */
function taskUpdates(): [string, boolean][] {
  return sent.flatMap((event) =>
    event.type === EventType.TaskUpdated ? [[event.task.id, event.task.backgroundWork] as [string, boolean]] : [],
  )
}

function start(): void {
  const tasks = [task, other].flatMap((each) => getTask(test.db, each.id) ?? [])
  watch = createBackgroundWorkWatch({ db: test.db, emit }, tasks)
}

/** Starts a tool call of the task and tells the windows, as the runner does. */
function call(toolUseId: string, name: string, taskId = task.id): void {
  const toolEvent = appendToolCall(test.db, { taskId, turn: 1, toolUseId, name, input: {}, parentToolUseId: null })
  emit({ type: EventType.ToolEventAppended, toolEvent })
}

/** Ends a tool call and tells the windows. */
function end(toolUseId: string, state = ToolCallState.Done, taskId = task.id): void {
  const toolEvent = updateToolCall(test.db, { taskId, toolUseId, state, output: 'Done.' })
  emit({ type: EventType.ToolEventUpdated, toolEvent })
}

/** Tells the windows the task's watchers changed, as the watcher tracker does. */
function watchersChanged(taskId = task.id): void {
  emit({ type: EventType.WatchersChanged, taskId, watchers: listWatchers(test.db, taskId).map(publicWatcher) })
}

function command(toolUseId: string, state = WatcherState.Running): string {
  const watcher = addWatcher(test.db, {
    taskId: task.id,
    kind: WatcherKind.Command,
    toolUseId,
    parentToolUseId: null,
    sdkId: `b-${toolUseId}`,
    label: 'Run the e2e suite',
    detail: 'npm run test:e2e',
    cron: null,
    schedule: null,
    recurring: false,
    state,
    nextDueAt: null,
    expiresAt: null,
  })
  return watcher.id
}

beforeEach(() => {
  test = openTestDatabase()
  const workspace = sampleWorkspace(test.db)
  task = sampleTask(test.db, workspace.id)
  other = sampleTask(test.db, workspace.id)
  sent = []
})

afterEach(() => {
  test.close()
})

it('sends the task again when its first subagent starts and its last one ends, and not in between', () => {
  start()

  call('toolu_a', 'Agent')
  expect(taskUpdates()).toEqual([[task.id, true]])
  // A second subagent, and the first one ending, change nothing: it still has one running.
  call('toolu_b', 'Task')
  end('toolu_a')
  expect(taskUpdates()).toEqual([[task.id, true]])

  end('toolu_b', ToolCallState.Error)
  expect(taskUpdates()).toEqual([
    [task.id, true],
    [task.id, false],
  ])
  // Each is sent after the event that changed it.
  expect(sent.map(({ type }) => type)).toEqual([
    EventType.ToolEventAppended,
    EventType.TaskUpdated,
    EventType.ToolEventAppended,
    EventType.ToolEventUpdated,
    EventType.ToolEventUpdated,
    EventType.TaskUpdated,
  ])
})

it('leaves the task alone for tool calls that are no subagent, and for notes', () => {
  start()

  call('toolu_bash', 'Bash')
  end('toolu_bash')
  emit({
    type: EventType.ToolEventAppended,
    toolEvent: appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Hm.' }),
  })

  expect(taskUpdates()).toEqual([])
})

it('sends the task again when a watcher starts running and when it stops, and not for one only scheduled', () => {
  start()

  command('toolu_wake', WatcherState.Scheduled)
  watchersChanged()
  expect(taskUpdates()).toEqual([])

  const id = command('toolu_e2e')
  watchersChanged()
  expect(taskUpdates()).toEqual([[task.id, true]])

  // It wakes the agent: a change to the watcher that isn't one to the task.
  updateWatcher(test.db, id, { wakes: 1, lastWokeAt: 9_000 })
  watchersChanged()
  expect(taskUpdates()).toEqual([[task.id, true]])

  updateWatcher(test.db, id, { state: WatcherState.Finished, endedAt: 9_500 })
  watchersChanged()
  expect(taskUpdates()).toEqual([
    [task.id, true],
    [task.id, false],
  ])
})

it('keeps counting while either a subagent or a watcher runs', () => {
  start()
  call('toolu_a', 'Agent')
  const id = command('toolu_e2e')
  watchersChanged()

  end('toolu_a')
  expect(taskUpdates()).toEqual([[task.id, true]])

  updateWatcher(test.db, id, { state: WatcherState.Stopped, endedAt: 9_500 })
  watchersChanged()
  expect(taskUpdates()).toEqual([
    [task.id, true],
    [task.id, false],
  ])
})

it('starts from what each task has running at launch', () => {
  appendToolCall(test.db, {
    taskId: task.id,
    turn: 1,
    toolUseId: 'toolu_a',
    name: 'Agent',
    input: {},
    parentToolUseId: null,
  })
  start()

  // Another subagent of a task that already had one changes nothing; its last one ending does.
  call('toolu_b', 'Agent')
  end('toolu_b')
  expect(taskUpdates()).toEqual([])
  end('toolu_a', ToolCallState.Interrupted)
  expect(taskUpdates()).toEqual([[task.id, false]])
})

it('takes what a task update says, so the same change is never sent twice', () => {
  start()
  appendToolCall(test.db, {
    taskId: task.id,
    turn: 1,
    toolUseId: 'toolu_a',
    name: 'Agent',
    input: {},
    parentToolUseId: null,
  })
  // The runner writes the task (its turn ends): it's read with the subagent running, and sent.
  emit({ type: EventType.TaskUpdated, task: updateTask(test.db, task.id, { status: 'Profiling' }) })
  sent = []

  // The subagent's own events follow: the task already said so.
  emit({
    type: EventType.ToolEventUpdated,
    toolEvent: updateToolCall(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_a',
      state: ToolCallState.Running,
      output: null,
    }),
  })
  expect(taskUpdates()).toEqual([])
})

it('keeps each task apart, and forgets a deleted one', () => {
  start()

  call('toolu_a', 'Agent', other.id)
  expect(taskUpdates()).toEqual([[other.id, true]])

  // A task made since launch starts with nothing running.
  const created = sampleTask(test.db, task.workspaceId)
  call('toolu_c', 'Agent', created.id)
  expect(taskUpdates()).toEqual([
    [other.id, true],
    [created.id, true],
  ])

  deleteTask(test.db, other.id)
  emit({ type: EventType.TaskDeleted, taskId: other.id })
  // An event for a task that's gone sends nothing.
  emit({ type: EventType.WatchersChanged, taskId: other.id, watchers: [] })
  expect(taskUpdates()).toHaveLength(2)
})

it('ignores every other event', () => {
  start()
  emit({ type: EventType.ToolEventRemoved, taskId: task.id, toolEventId: 'gone' })
  expect(sent).toHaveLength(1)
})
