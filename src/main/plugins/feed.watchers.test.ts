// How many watchers a task has running, as a plugin is told it (`PluginTask.watchers`, #490), on a real database:
// in the snapshot, and in a `task.updated` each time the count changes and only then. Every event the feed sends is
// checked against the strict schema on its way out, so anything of a watcher beyond the count fails.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  Effort,
  TaskActivity,
  TaskState,
  ToolCallState,
  WatcherKind,
  WatcherState,
  type Task,
  type Workspace,
} from '../../shared/domain'
import {
  PluginEventType,
  PluginSubagentState,
  PluginTaskActivity,
  PluginTaskState,
  type PluginChangeEvent,
  type PluginSnapshotEvent,
  type PluginTask,
} from '../../shared/plugin-api'
import { pluginEventSchema } from '../../shared/plugin-api-schema'
import { createTask, deleteTask, getTask, listTasks, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import {
  addWatcher,
  listWatchers,
  publicWatcher,
  updateWatcher,
  type NewWatcher,
  type WatcherChange,
} from '../db/repositories/watchers'
import { createWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import { createPluginFeed, type PluginFeed, type PluginFeedSource, type PluginSink } from './feed'
import { databaseFeedSource } from './feed-source'

type Sent = PluginSnapshotEvent | PluginChangeEvent

let database: TestDatabase
let acme: Workspace
let feed: PluginFeed
let sent: Sent[]

beforeEach(() => {
  database = openTestDatabase()
  acme = createWorkspace(database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  sent = []
})

afterEach(() => {
  database.close()
})

/** Starts the feed as the app does, on every task there is now. */
function start(source: PluginFeedSource = databaseFeedSource(database.db)): void {
  const tasks = listWorkspaces(database.db).flatMap((workspace) => listTasks(database.db, workspace.id))
  feed = createPluginFeed({ source, tasks })
}

/** A sink that checks each event against the strict schema, then keeps it. */
function sinkInto(into: Sent[]): PluginSink {
  return (event) => {
    expect(pluginEventSchema.parse(event)).toEqual(event)
    into.push(event)
  }
}

function subscribe(into: Sent[] = sent): PluginSnapshotEvent {
  feed.subscribe(sinkInto(into))
  const snapshot = into.shift()
  if (snapshot?.type !== PluginEventType.Snapshot) throw new Error('No snapshot came first')
  return snapshot
}

/** Starts the feed and subscribes to it; answers with the snapshot, which `sent` doesn't keep. */
function listen(): PluginSnapshotEvent {
  start()
  return subscribe()
}

function emit(event: GladeEvent): void {
  feed.observe(event)
}

/** A task whose agent has run a turn that's over, and whose reply you've read: idle unless something still runs. */
function newTask(now = 2_000): Task {
  const task = createTask(database.db, { workspaceId: acme.id, model: 'claude-sample-1', effort: Effort.Medium }, now)
  return updateTask(database.db, task.id, { sessionId: `session-${task.id}` }, now)
}

function asPlugin(task: Task, overrides: Partial<PluginTask> = {}): PluginTask {
  return {
    id: task.id,
    workspaceId: acme.id,
    workspaceName: acme.name,
    title: task.title,
    status: task.status,
    state: PluginTaskState.Active,
    activity: PluginTaskActivity.Waiting,
    needsYou: false,
    waitingOn: null,
    watchers: 0,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    doneAt: null,
    ...overrides,
  }
}

/** What a watcher of each kind starts as, as the watcher tracker makes it. */
function watcherOf(kind: WatcherKind, task: Task, toolUseId: string, parent: string | null): NewWatcher {
  const process = kind === WatcherKind.Monitor || kind === WatcherKind.Command
  return {
    taskId: task.id,
    kind,
    toolUseId,
    parentToolUseId: parent,
    sdkId: `sdk-${toolUseId}`,
    label: 'CI checks on PR #42',
    detail: 'gh pr checks 42 --watch',
    cron: kind === WatcherKind.Cron ? '0 9 * * *' : null,
    schedule: kind === WatcherKind.Cron ? 'Every day at 9:00 AM' : null,
    recurring: kind === WatcherKind.Monitor || kind === WatcherKind.Cron,
    state: process ? WatcherState.Running : WatcherState.Scheduled,
    nextDueAt: process ? null : 90_000,
    expiresAt: null,
  }
}

/** Tells the feed the task's watchers changed, as the watcher tracker does after every change it saves. */
function told(task: Task): void {
  emit({
    type: EventType.WatchersChanged,
    taskId: task.id,
    watchers: listWatchers(database.db, task.id).map(publicWatcher),
  })
}

/** The agent leaves a watcher: it's saved, then the task's watchers are broadcast. Answers its id. */
function watch(task: Task, toolUseId: string, kind = WatcherKind.Monitor, parent: string | null = null): string {
  const { id } = addWatcher(database.db, watcherOf(kind, task, toolUseId, parent), 4_000)
  told(task)
  return id
}

/** A watcher changes: it's saved, then the task's watchers are broadcast. */
function change(task: Task, id: string, patch: WatcherChange): void {
  updateWatcher(database.db, id, patch)
  told(task)
}

function end(task: Task, id: string, state = WatcherState.Finished): void {
  change(task, id, { state, outcome: 'Monitor "CI checks on PR #42" stream ended', nextDueAt: null, endedAt: 6_000 })
}

/** The `watchers` of each `task.updated` sent since the snapshot, in order. */
function counts(from: readonly Sent[] = sent): number[] {
  return from.flatMap((event) => (event.type === PluginEventType.TaskUpdated ? [event.task.watchers] : []))
}

describe('the snapshot', () => {
  it('counts each task’s running monitors and background commands, its subagents’ included, and nothing else', () => {
    const watching = newTask()
    const scheduled = newTask(2_100)
    const idle = newTask(2_200)
    const over = newTask(2_300)
    addWatcher(database.db, watcherOf(WatcherKind.Monitor, watching, 'toolu_ci', null))
    addWatcher(database.db, watcherOf(WatcherKind.Command, watching, 'toolu_tests', null))
    // One a subagent of the task's left running is the task's background work too.
    addWatcher(database.db, watcherOf(WatcherKind.Command, watching, 'toolu_e2e', 'toolu_sub'))
    // A wakeup and a cron job run nothing until they fire: the Watchers tab lists them, the count leaves them out.
    addWatcher(database.db, watcherOf(WatcherKind.Wakeup, watching, 'toolu_wake', null))
    addWatcher(database.db, watcherOf(WatcherKind.Wakeup, scheduled, 'toolu_wake', null))
    addWatcher(database.db, watcherOf(WatcherKind.Cron, scheduled, 'toolu_cron', null))
    const suspended = addWatcher(database.db, watcherOf(WatcherKind.Cron, scheduled, 'toolu_cron_2', null))
    updateWatcher(database.db, suspended.id, { state: WatcherState.Suspended })
    // Ones that finished, failed or were stopped aren't running.
    for (const [index, state] of [WatcherState.Finished, WatcherState.Failed, WatcherState.Stopped].entries()) {
      const ended = addWatcher(database.db, watcherOf(WatcherKind.Command, over, `toolu_${String(index)}`, null))
      updateWatcher(database.db, ended.id, { state, outcome: 'It ended.', endedAt: 5_000 })
    }

    const snapshot = listen()

    // The newest task first, as the task list has them.
    expect(snapshot.tasks).toEqual([
      asPlugin(over),
      asPlugin(idle),
      asPlugin(scheduled),
      asPlugin(watching, { watchers: 3 }),
    ])
    expect(snapshot.subagents).toEqual([])
  })

  it('counts again each time: a later one has what changed since, with or without anyone listening', () => {
    const task = newTask()
    const ci = addWatcher(database.db, watcherOf(WatcherKind.Monitor, task, 'toolu_ci', null))
    start()
    expect(subscribe([]).tasks).toEqual([asPlugin(task, { watchers: 1 })])

    watch(task, 'toolu_tests', WatcherKind.Command)
    expect(subscribe([]).tasks).toEqual([asPlugin(task, { watchers: 2 })])

    end(task, ci.id)
    expect(subscribe([]).tasks).toEqual([asPlugin(task, { watchers: 1 })])
  })

  it('has a watcher that changes while it is read, or sends the change after it: never both, never neither', () => {
    const task = newTask()
    const real = databaseFeedSource(database.db)
    let reading = true
    start({
      ...real,
      activeTasks() {
        const tasks = real.activeTasks()
        // One starts before the watchers are counted (so the snapshot has it).
        if (reading) watch(task, 'toolu_before')
        return tasks
      },
      openQuestionSets() {
        // And one after (so it doesn't).
        if (reading) watch(task, 'toolu_after', WatcherKind.Command)
        reading = false
        return real.openQuestionSets()
      },
    })

    const snapshot = subscribe()

    expect(snapshot.tasks).toEqual([asPlugin(task, { watchers: 1 })])
    expect(sent).toEqual([{ type: PluginEventType.TaskUpdated, task: asPlugin(task, { watchers: 2 }) }])
  })
})

describe('a snapshot that can’t be read', () => {
  it('leaves the counts as they were: the next change is sent against them, to everyone else', () => {
    const task = newTask()
    const real = databaseFeedSource(database.db)
    let fail = false
    start({
      ...real,
      liveWatchers() {
        if (fail) throw new Error('disk I/O error')
        return real.liveWatchers()
      },
    })
    subscribe()
    const ci = watch(task, 'toolu_ci')
    watch(task, 'toolu_tests', WatcherKind.Command)
    sent.length = 0
    fail = true
    const failed: Sent[] = []

    expect(() => feed.subscribe(sinkInto(failed))).toThrow('disk I/O error')
    told(task)
    end(task, ci)

    expect(failed).toEqual([])
    expect(sent).toEqual([{ type: PluginEventType.TaskUpdated, task: asPlugin(task, { watchers: 1 }) }])
  })
})

describe('task.updated', () => {
  it('carries the count when a watcher starts, a second starts, and each finishes, fails or is stopped', () => {
    const task = newTask()
    listen()

    const ci = watch(task, 'toolu_ci')
    const tests = watch(task, 'toolu_tests', WatcherKind.Command)
    const docs = watch(task, 'toolu_docs', WatcherKind.Command)
    end(task, docs, WatcherState.Failed)
    end(task, ci, WatcherState.Stopped)
    end(task, tests, WatcherState.Finished)

    expect(sent).toEqual(
      [1, 2, 3, 2, 1, 0].map((watchers) => ({
        type: PluginEventType.TaskUpdated,
        task: asPlugin(task, { watchers }),
      })),
    )
  })

  it('counts a watcher a subagent started with the task’s own', () => {
    const task = newTask()
    listen()

    const own = watch(task, 'toolu_ci')
    const subagents = watch(task, 'toolu_e2e', WatcherKind.Command, 'toolu_sub')
    end(task, own)
    end(task, subagents)

    expect(counts()).toEqual([1, 2, 1, 0])
  })

  it('is one event for the one task: no other task is sent, and no snapshot', () => {
    const task = newTask()
    const other = newTask(2_100)
    listen()

    watch(task, 'toolu_ci')

    expect(sent).toEqual([{ type: PluginEventType.TaskUpdated, task: asPlugin(task, { watchers: 1 }) }])
    expect(JSON.stringify(sent)).not.toContain(other.id)
  })

  it('sends nothing when the count is as it was', () => {
    const task = newTask()
    const ci = addWatcher(database.db, watcherOf(WatcherKind.Monitor, task, 'toolu_ci', null))
    listen()

    // The monitor wakes the agent, reports a line, has its timeout set, and is marked as yours to stop.
    change(task, ci.id, { wakes: 1, lastWokeAt: 5_000, lastOutput: 'unit-tests\tfail' })
    change(task, ci.id, { expiresAt: 90_000 })
    change(task, ci.id, { stoppedByYou: true })
    // A wakeup and a cron job are scheduled, fire, are suspended by a relaunch, come back and end.
    const wakeup = watch(task, 'toolu_wake', WatcherKind.Wakeup)
    const cron = watch(task, 'toolu_cron', WatcherKind.Cron)
    change(task, cron, { wakes: 1, lastWokeAt: 5_500, nextDueAt: 180_000 })
    change(task, cron, { state: WatcherState.Suspended })
    change(task, cron, { state: WatcherState.Scheduled })
    end(task, wakeup, WatcherState.Finished)
    end(task, cron, WatcherState.Stopped)
    // The same watchers, told again.
    told(task)

    expect(sent).toEqual([])
    // It's still counted: the next change sends what it now is.
    end(task, ci.id, WatcherState.Stopped)
    expect(sent).toEqual([{ type: PluginEventType.TaskUpdated, task: asPlugin(task) }])
  })

  it('sends nothing for a task with no watchers whose (empty) list is told', () => {
    const task = newTask()
    listen()

    told(task)

    expect(sent).toEqual([])
  })

  it('keeps the count on every later change to the task, and on a renamed workspace’s tasks', () => {
    const task = newTask()
    listen()
    watch(task, 'toolu_ci')
    watch(task, 'toolu_tests', WatcherKind.Command)
    sent.length = 0

    const working = updateTask(database.db, task.id, { activity: TaskActivity.Working, title: 'Watch CI' }, 5_000)
    emit({ type: EventType.TaskUpdated, task: working })
    emit({ type: EventType.WorkspaceUpdated, workspace: { ...acme, name: 'Acme' } })

    expect(sent).toEqual([
      {
        type: PluginEventType.TaskUpdated,
        task: asPlugin(working, { title: 'Watch CI', activity: PluginTaskActivity.Working, watchers: 2 }),
      },
      {
        type: PluginEventType.TaskUpdated,
        task: asPlugin(working, {
          title: 'Watch CI',
          activity: PluginTaskActivity.Working,
          workspaceName: 'Acme',
          watchers: 2,
        }),
      },
    ])
  })

  it('sends nothing more when the task is sent again unchanged, as it is when its background work changes', () => {
    const task = newTask()
    listen()

    watch(task, 'toolu_ci')
    // What main sends the windows next: the task again, now read with background work.
    const again = getTask(database.db, task.id)
    if (again === undefined) throw new Error('No task')
    emit({ type: EventType.TaskUpdated, task: again })

    expect(again.backgroundWork).toBe(true)
    expect(counts()).toEqual([1])
  })

  it('follows a done task’s watchers too, which no snapshot has', () => {
    const task = newTask()
    const ci = addWatcher(database.db, watcherOf(WatcherKind.Monitor, task, 'toolu_ci', null))
    const done = updateTask(database.db, task.id, { state: TaskState.Done }, 3_000)
    const snapshot = listen()

    end(task, ci.id)

    expect(snapshot.tasks).toEqual([])
    expect(sent).toEqual([
      {
        type: PluginEventType.TaskUpdated,
        task: asPlugin(done, { state: PluginTaskState.Done, doneAt: done.doneAt, watchers: 0 }),
      },
    ])
  })

  it('keeps up while no one is subscribed, so a subscriber is only sent what changes after its snapshot', () => {
    const task = newTask()
    start()
    const ci = watch(task, 'toolu_ci')
    watch(task, 'toolu_tests', WatcherKind.Command)

    const snapshot = subscribe()
    end(task, ci)

    expect(snapshot.tasks).toEqual([asPlugin(task, { watchers: 2 })])
    expect(counts()).toEqual([1])
  })

  it('tells every subscriber, each once', () => {
    const task = newTask()
    start()
    const first: Sent[] = []
    const second: Sent[] = []
    subscribe(first)
    subscribe(second)

    watch(task, 'toolu_ci')

    expect(counts(first)).toEqual([1])
    expect(counts(second)).toEqual([1])
  })
})

describe('a task the feed is told of later, or no longer has', () => {
  it('gives a new task the count of the watchers it was told of first', () => {
    listen()
    const task = newTask()

    watch(task, 'toolu_ci')
    emit({ type: EventType.TaskUpdated, task })

    expect(sent).toEqual([{ type: PluginEventType.TaskCreated, task: asPlugin(task, { watchers: 1 }) }])
  })

  it('forgets a deleted task’s count', () => {
    const task = newTask()
    listen()
    watch(task, 'toolu_ci')
    deleteTask(database.db, task.id)
    emit({ type: EventType.TaskDeleted, taskId: task.id })
    sent.length = 0

    // Were a task of that id told of again, it would start from none.
    emit({ type: EventType.TaskUpdated, task })

    expect(sent).toEqual([{ type: PluginEventType.TaskCreated, task: asPlugin(task) }])
  })
})

describe('what a plugin is told of a watcher', () => {
  it('is the count and nothing else: no id, kind, name, command, schedule, output or outcome', () => {
    const task = newTask()
    const snapshotWatcher = addWatcher(database.db, {
      ...watcherOf(WatcherKind.Monitor, task, 'toolu_snapshot', null),
      label: 'SNAPSHOT_LABEL',
      detail: 'SNAPSHOT_COMMAND',
    })
    updateWatcher(database.db, snapshotWatcher.id, { lastOutput: 'SNAPSHOT_OUTPUT', sdkId: 'SNAPSHOT_SDK_ID' })
    const snapshot = listen()

    const live = addWatcher(database.db, {
      ...watcherOf(WatcherKind.Command, task, 'toolu_live', 'toolu_parent'),
      label: 'LIVE_LABEL',
      detail: 'LIVE_COMMAND',
    })
    told(task)
    change(task, live.id, { wakes: 1, lastWokeAt: 5_000, lastOutput: 'LIVE_OUTPUT' })
    change(task, live.id, { state: WatcherState.Failed, outcome: 'LIVE_OUTCOME', endedAt: 6_000 })

    const everything = [snapshot, ...sent]
    const json = JSON.stringify(everything)
    expect(counts()).toEqual([2, 1])
    for (const text of [
      'SNAPSHOT_',
      'LIVE_',
      snapshotWatcher.id,
      live.id,
      'toolu_',
      WatcherKind.Monitor,
      WatcherKind.Command,
      'failed',
      'CI checks',
    ]) {
      expect(json).not.toContain(text)
    }
    // Every task sent has the documented fields and no others; a watcher adds one number to it.
    const tasks = [...snapshot.tasks, ...sent.flatMap((event) => ('task' in event ? [event.task] : []))]
    expect(tasks).toHaveLength(3)
    for (const sentTask of tasks) {
      expect(Object.keys(sentTask).sort()).toEqual(Object.keys(asPlugin(task)).sort())
      expect(typeof sentTask.watchers).toBe('number')
    }
    // And nothing but tasks is sent for one: no event of a watcher's own.
    expect(sent.map(({ type }) => type)).toEqual([PluginEventType.TaskUpdated, PluginEventType.TaskUpdated])
  })
})

// Glade counts a task whose turn is over as working while it has background work (`Task.backgroundWork`): a subagent's
// call still running, or a watcher whose process runs. A plugin must be able to tell the same from what it's sent.
describe('with the running subagents, everything Glade counts as the task’s background work', () => {
  const SUBAGENT_TOOLS = ['Agent', 'Task']
  const WATCHER_CASES = Object.values(WatcherKind).flatMap((kind) =>
    Object.values(WatcherState).flatMap((state) =>
      [null, 'toolu_sub'].map((parent) => ({ kind, state, parent, name: `a ${state} ${kind}` })),
    ),
  )
  const CALL_CASES = [...SUBAGENT_TOOLS, 'Bash', 'Monitor'].flatMap((tool) =>
    Object.values(ToolCallState).flatMap((state) =>
      [null, 'toolu_outer'].map((parent) => ({ tool, state, parent, name: `a ${state} ${tool} call` })),
    ),
  )

  /** Whether a plugin, from a snapshot alone, has something alive under the task. */
  function alive(snapshot: PluginSnapshotEvent, task: Task): boolean {
    const running = snapshot.subagents.filter(
      (subagent) => subagent.taskId === task.id && subagent.state === PluginSubagentState.Running,
    )
    const told = snapshot.tasks.find(({ id }) => id === task.id)
    if (told === undefined) throw new Error('The task is not in the snapshot')
    return running.length > 0 || told.watchers > 0
  }

  function backgroundWork(task: Task): boolean {
    const read = getTask(database.db, task.id)
    if (read === undefined) throw new Error('No task')
    expect(read.activity).toBe(TaskActivity.Waiting)
    return read.backgroundWork
  }

  it.each(WATCHER_CASES)('agrees with it for $name (started by $parent)', ({ kind, state, parent }) => {
    const task = newTask()
    const watcher = addWatcher(database.db, watcherOf(kind, task, 'toolu_w', parent))
    updateWatcher(database.db, watcher.id, { state })

    const snapshot = listen()

    expect(alive(snapshot, task)).toBe(backgroundWork(task))
    expect(backgroundWork(task)).toBe(state === WatcherState.Running)
  })

  it.each(CALL_CASES)('agrees with it for $name (made by $parent)', ({ tool, state, parent }) => {
    const task = newTask()
    appendToolCall(database.db, {
      taskId: task.id,
      turn: 1,
      name: tool,
      input: {},
      toolUseId: 'toolu_c',
      parentToolUseId: parent,
    })
    if (state !== ToolCallState.Running) {
      updateToolCall(database.db, { taskId: task.id, toolUseId: 'toolu_c', state, output: 'ok' })
    }

    const snapshot = listen()

    expect(alive(snapshot, task)).toBe(backgroundWork(task))
    expect(backgroundWork(task)).toBe(state === ToolCallState.Running && SUBAGENT_TOOLS.includes(tool))
  })

  it('agrees with it at every step, from the events alone, as subagents and watchers come and go', () => {
    const task = newTask()
    listen()
    /** What a plugin that only follows the events knows: its running subagents, and the task's count. */
    const subagents = new Set<string>()
    let watchers = 0
    let read = 0
    const check = (expected: boolean): void => {
      for (const event of sent.slice(read)) {
        if (event.type === PluginEventType.TaskUpdated) watchers = event.task.watchers
        if (event.type === PluginEventType.SubagentStarted) subagents.add(event.subagent.id)
        if (event.type === PluginEventType.SubagentUpdated) {
          if (event.subagent.state === PluginSubagentState.Running) subagents.add(event.subagent.id)
          else subagents.delete(event.subagent.id)
        }
      }
      read = sent.length
      expect(subagents.size > 0 || watchers > 0).toBe(expected)
      expect(backgroundWork(task)).toBe(expected)
    }
    const call = (toolUseId: string, name: string, parent: string | null = null): void => {
      const toolEvent = appendToolCall(database.db, {
        taskId: task.id,
        turn: 1,
        name,
        input: {},
        toolUseId,
        parentToolUseId: parent,
      })
      emit({ type: EventType.ToolEventAppended, toolEvent })
    }
    const callEnded = (toolUseId: string, state = ToolCallState.Done): void => {
      const toolEvent = updateToolCall(database.db, { taskId: task.id, toolUseId, state, output: 'ok' })
      emit({ type: EventType.ToolEventUpdated, toolEvent })
    }

    check(false)
    // A watcher alone, then a subagent beside it.
    const ci = watch(task, 'toolu_ci')
    check(true)
    call('toolu_sub', 'Agent')
    check(true)
    end(task, ci)
    check(true)
    // The subagent leaves a command running and finishes: its command is all that's left.
    call('toolu_sub_bash', 'Bash', 'toolu_sub')
    const e2e = watch(task, 'toolu_e2e', WatcherKind.Command, 'toolu_sub')
    callEnded('toolu_sub_bash')
    callEnded('toolu_sub')
    check(true)
    end(task, e2e, WatcherState.Failed)
    check(false)
    // Only scheduled things: nothing runs.
    const wakeup = watch(task, 'toolu_wake', WatcherKind.Wakeup)
    watch(task, 'toolu_cron', WatcherKind.Cron)
    check(false)
    // A subagent alone, with one of its own inside it, then interrupted.
    call('toolu_second', 'Agent')
    call('toolu_nested', 'Task', 'toolu_second')
    check(true)
    callEnded('toolu_second', ToolCallState.Interrupted)
    check(true)
    callEnded('toolu_nested', ToolCallState.Error)
    check(false)
    // A call that isn't a subagent's, and the wakeup firing: still nothing alive.
    call('toolu_bash', 'Bash')
    end(task, wakeup)
    check(false)
  })
})
