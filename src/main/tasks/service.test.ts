import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { Effort, TaskActivity, TaskState, type Task, type Workspace } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './defaults'
import {
  createTask,
  markTaskDone,
  reopenTask,
  updateTaskFromAgent,
  updateTaskFromRunner,
  updateTaskFromUser,
  type TaskServiceContext,
} from './service'

let database: TestDatabase
let workspace: Workspace
let events: GladeEvent[]
let context: TaskServiceContext

beforeEach(() => {
  vi.useFakeTimers({ now: 5_000 })
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  events = []
  context = { db: database.db, emit: (event) => events.push(event) }
})

afterEach(() => {
  database.close()
  vi.useRealTimers()
})

/** Checks `write` throws a `CommandFailure` with this code and message. */
function expectFailure(write: () => unknown, code: BridgeErrorCode, message: string): void {
  expect(write).toThrow(CommandFailure)
  expect(write).toThrow(expect.objectContaining({ code, message }))
}

/** A task with every field the user and agent set filled in, as it would be mid-task. */
function busyTask(): Task {
  const task = createTask(context, workspace.id)
  vi.setSystemTime(6_000)
  const busy = updateTask(database.db, task.id, {
    title: 'Add rate limiting',
    objective: 'Limit each API key to 100 requests a minute.',
    status: 'Middleware written; tests passing.',
    pinned: true,
    unread: true,
    effort: Effort.Low,
    sessionId: 'session-1',
  })
  events = []
  return busy
}

describe('createTask', () => {
  it('creates an active, empty task with the default model and effort, and says so', () => {
    const task = createTask(context, workspace.id)

    expect(task).toEqual({
      id: expect.any(String) as unknown,
      workspaceId: workspace.id,
      title: '',
      objective: '',
      status: '',
      statusUpdatedAt: null,
      state: TaskState.Active,
      activity: TaskActivity.Waiting,
      pinned: false,
      unread: false,
      model: DEFAULT_MODEL,
      effort: DEFAULT_EFFORT,
      createdAt: 5_000,
      updatedAt: 5_000,
      doneAt: null,
      sessionId: null,
    })
    expect(DEFAULT_EFFORT).toBe(Effort.High)
    expect(getTask(database.db, task.id)).toEqual(task)
    expect(events).toEqual([{ type: EventType.TaskUpdated, task }])
  })

  it('refuses a workspace that does not exist', () => {
    expectFailure(
      () => createTask(context, 'no-such-workspace'),
      BridgeErrorCode.NotFound,
      'No workspace no-such-workspace',
    )
    expect(events).toEqual([])
  })
})

describe('markTaskDone', () => {
  it('marks an active task done, keeping its status as the outcome', () => {
    const task = busyTask()
    vi.setSystemTime(7_000)

    const done = markTaskDone(context, task.id)

    expect(done).toEqual({ ...task, state: TaskState.Done, doneAt: 7_000, updatedAt: 7_000 })
    expect(done.status).toBe('Middleware written; tests passing.')
    expect(getTask(database.db, task.id)).toEqual(done)
    expect(events).toEqual([{ type: EventType.TaskUpdated, task: done }])
  })

  it('refuses a task that is already done, leaving it alone', () => {
    const task = markTaskDone(context, busyTask().id)
    events = []

    expectFailure(
      () => markTaskDone(context, task.id),
      BridgeErrorCode.InvalidTransition,
      "Can't mark done a task that is done",
    )
    expect(getTask(database.db, task.id)).toEqual(task)
    expect(events).toEqual([])
  })
})

describe('reopenTask', () => {
  it('restores every field but updatedAt when it undoes markTaskDone', () => {
    const task = busyTask()
    vi.setSystemTime(7_000)
    markTaskDone(context, task.id)
    vi.setSystemTime(8_000)

    const reopened = reopenTask(context, task.id)

    expect(reopened).toEqual({ ...task, updatedAt: 8_000 })
    expect(getTask(database.db, task.id)).toEqual(reopened)
    expect(events.at(-1)).toEqual({ type: EventType.TaskUpdated, task: reopened })
  })

  it('refuses a task that is active, leaving it alone', () => {
    const task = busyTask()

    expectFailure(
      () => reopenTask(context, task.id),
      BridgeErrorCode.InvalidTransition,
      "Can't reopen a task that is active",
    )
    expect(getTask(database.db, task.id)).toEqual(task)
    expect(events).toEqual([])
  })
})

describe('updating fields', () => {
  it("changes only the user's fields from the user", () => {
    const task = busyTask()
    vi.setSystemTime(7_000)
    // Bypass the types, as a caller holding a wider object could: only the user's fields are taken from it.
    const patch = { title: 'Rate limits', pinned: false, model: 'claude-sample-2', status: 'x', state: TaskState.Done }

    const updated = updateTaskFromUser(context, task.id, patch)

    expect(updated).toEqual({
      ...task,
      title: 'Rate limits',
      pinned: false,
      model: 'claude-sample-2',
      updatedAt: 7_000,
    })
    expect(events).toEqual([{ type: EventType.TaskUpdated, task: updated }])
  })

  it("changes only the agent's fields from the agent", () => {
    const task = busyTask()
    vi.setSystemTime(7_000)
    const patch = { objective: 'Limit each key.', status: 'Deployed.', pinned: false }

    const updated = updateTaskFromAgent(context, task.id, patch)

    expect(updated).toEqual({
      ...task,
      objective: 'Limit each key.',
      status: 'Deployed.',
      statusUpdatedAt: 7_000,
      updatedAt: 7_000,
    })
    expect(events).toEqual([{ type: EventType.TaskUpdated, task: updated }])
  })
})

describe('updateTaskFromRunner', () => {
  it("records the agent's activity and session id, leaving everything else alone", () => {
    const task = busyTask()
    vi.setSystemTime(7_000)

    const working = updateTaskFromRunner(context, task.id, { activity: TaskActivity.Working, sessionId: 'session-2' })
    const errored = updateTaskFromRunner(context, task.id, { activity: TaskActivity.Error })

    expect(working).toEqual({ ...task, activity: TaskActivity.Working, sessionId: 'session-2', updatedAt: 7_000 })
    expect(errored).toEqual({ ...working, activity: TaskActivity.Error })
    expect(events).toEqual([working, errored].map((updated) => ({ type: EventType.TaskUpdated, task: updated })))
  })
})

it.each([
  ['markTaskDone', (id: string) => markTaskDone(context, id)],
  ['reopenTask', (id: string) => reopenTask(context, id)],
  ['updateTaskFromUser', (id: string) => updateTaskFromUser(context, id, { pinned: true })],
  ['updateTaskFromAgent', (id: string) => updateTaskFromAgent(context, id, { status: 'Done.' })],
  ['updateTaskFromRunner', (id: string) => updateTaskFromRunner(context, id, { activity: TaskActivity.Working })],
])('%s refuses a task that does not exist', (_name, write) => {
  expectFailure(() => write('no-such-task'), BridgeErrorCode.NotFound, 'No task no-such-task')
  expect(events).toEqual([])
})
