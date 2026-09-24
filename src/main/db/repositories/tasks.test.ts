import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Effort, TaskActivity, TaskState, type Workspace } from '../../../shared/domain'
import { createTask, getTask, listTasks, listWorkingTasks, updateTask } from './tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'

let test: TestDatabase
let workspace: Workspace

beforeEach(() => {
  test = openTestDatabase()
  workspace = sampleWorkspace(test.db)
})

afterEach(() => {
  test.close()
})

describe('createTask', () => {
  it('creates an active, empty task', () => {
    const task = createTask(
      test.db,
      { workspaceId: workspace.id, model: 'claude-sample-1', effort: Effort.High },
      2_000,
    )

    expect(task).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown,
      workspaceId: workspace.id,
      title: '',
      objective: '',
      status: '',
      statusUpdatedAt: null,
      state: TaskState.Active,
      activity: TaskActivity.Waiting,
      pinned: false,
      unread: false,
      model: 'claude-sample-1',
      effort: Effort.High,
      createdAt: 2_000,
      updatedAt: 2_000,
      doneAt: null,
      sessionId: null,
    })
    expect(getTask(test.db, task.id)).toEqual(task)
  })

  it('takes an initial title, objective and status, and defaults the time to now', () => {
    const before = Date.now()
    const task = createTask(test.db, {
      workspaceId: workspace.id,
      model: 'claude-sample-1',
      effort: Effort.Low,
      title: 'Fix the flaky date test',
      objective: 'Make the date tests pass in every timezone',
      status: 'Reading the test config',
    })

    expect(getTask(test.db, task.id)).toMatchObject({
      title: 'Fix the flaky date test',
      objective: 'Make the date tests pass in every timezone',
      status: 'Reading the test config',
      statusUpdatedAt: task.createdAt,
    })
    expect(task.createdAt).toBeGreaterThanOrEqual(before)
  })

  it('refuses a task in an unknown workspace', () => {
    expect(() => sampleTask(test.db, 'missing')).toThrow('FOREIGN KEY constraint failed')
  })
})

describe('getTask', () => {
  it('is undefined for an unknown id', () => {
    expect(getTask(test.db, 'missing')).toBeUndefined()
  })

  it('rejects a row with an unknown state', () => {
    const task = sampleTask(test.db, workspace.id)
    test.db.pragma('ignore_check_constraints = ON')
    test.db.prepare("UPDATE tasks SET state = 'paused' WHERE id = ?").run(task.id)

    expect(() => getTask(test.db, task.id)).toThrow('tasks.state: expected one of active, done, got "paused"')
  })
})

describe('listTasks', () => {
  it("lists a workspace's tasks, most recently updated first", () => {
    const older = sampleTask(test.db, workspace.id, 2_000)
    const newer = sampleTask(test.db, workspace.id, 3_000)
    const other = sampleWorkspace(test.db, '/code/billing')
    sampleTask(test.db, other.id)

    expect(listTasks(test.db, workspace.id)).toEqual([newer, older])
    const touched = updateTask(test.db, older.id, { unread: true }, 4_000)
    expect(listTasks(test.db, workspace.id)).toEqual([touched, newer])
  })
})

describe('listWorkingTasks', () => {
  it("lists every workspace's active, working tasks, oldest first", () => {
    const other = sampleWorkspace(test.db, '/code/billing')
    const working = (workspaceId: string, now: number) =>
      updateTask(test.db, sampleTask(test.db, workspaceId, now).id, { activity: TaskActivity.Working }, now)
    const newer = working(workspace.id, 3_000)
    const older = working(other.id, 2_000)
    sampleTask(test.db, workspace.id)
    updateTask(test.db, sampleTask(test.db, workspace.id).id, { activity: TaskActivity.Error })
    updateTask(test.db, working(workspace.id, 1_000).id, { state: TaskState.Done })

    expect(listWorkingTasks(test.db)).toEqual([older, newer])
  })
})

describe('updateTask', () => {
  it('changes the given fields, keeps the rest, and stamps the update time', () => {
    const task = sampleTask(test.db, workspace.id)

    const updated = updateTask(
      test.db,
      task.id,
      {
        title: 'Fix the flaky date test',
        objective: 'Make the date tests pass in every timezone',
        status: 'Found it: a timezone bug',
        pinned: true,
        unread: true,
        model: 'claude-sample-2',
        effort: Effort.Max,
        activity: TaskActivity.Working,
        sessionId: 'session-1',
      },
      3_000,
    )

    expect(updated).toEqual({
      ...task,
      title: 'Fix the flaky date test',
      objective: 'Make the date tests pass in every timezone',
      status: 'Found it: a timezone bug',
      statusUpdatedAt: 3_000,
      pinned: true,
      unread: true,
      model: 'claude-sample-2',
      effort: Effort.Max,
      activity: TaskActivity.Working,
      sessionId: 'session-1',
      updatedAt: 3_000,
    })
    expect(getTask(test.db, task.id)).toEqual(updated)

    const unchanged = updateTask(test.db, task.id, {}, 4_000)
    expect(unchanged).toEqual({ ...updated, updatedAt: 4_000 })
    expect(updateTask(test.db, task.id, { sessionId: null }, 5_000).sessionId).toBeNull()
  })

  it('defaults the update time to now', () => {
    const task = sampleTask(test.db, workspace.id)
    expect(updateTask(test.db, task.id, { pinned: true }).updatedAt).toBeGreaterThan(task.updatedAt)
  })

  it('stamps the done time when marked done and clears it when reopened', () => {
    const task = sampleTask(test.db, workspace.id)

    const done = updateTask(test.db, task.id, { state: TaskState.Done, status: 'Fixed the bug' }, 3_000)
    expect(done).toMatchObject({ state: TaskState.Done, doneAt: 3_000, status: 'Fixed the bug' })
    expect(getTask(test.db, task.id)).toEqual(done)

    // Staying done keeps the original done time.
    expect(updateTask(test.db, task.id, { state: TaskState.Done }, 4_000).doneAt).toBe(3_000)

    const reopened = updateTask(test.db, task.id, { state: TaskState.Active }, 5_000)
    expect(reopened).toMatchObject({ state: TaskState.Active, doneAt: null, updatedAt: 5_000 })
    expect(getTask(test.db, task.id)).toEqual(reopened)
  })

  it('stamps the status time only when the status changes', () => {
    const task = sampleTask(test.db, workspace.id)
    updateTask(test.db, task.id, { status: 'Reading the tests' }, 3_000)

    expect(updateTask(test.db, task.id, { status: 'Reading the tests' }, 4_000).statusUpdatedAt).toBe(3_000)
    expect(updateTask(test.db, task.id, { activity: TaskActivity.Working }, 5_000).statusUpdatedAt).toBe(3_000)
    expect(updateTask(test.db, task.id, { status: 'Tests pass' }, 6_000).statusUpdatedAt).toBe(6_000)
  })

  it('throws for an unknown id', () => {
    expect(() => updateTask(test.db, 'missing', { pinned: true })).toThrow('No task missing')
  })
})
