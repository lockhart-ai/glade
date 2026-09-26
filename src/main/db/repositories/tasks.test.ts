import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  AgentErrorKind,
  Effort,
  PauseReason,
  PermissionMode,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  type TaskError,
  type TaskPause,
  type Workspace,
} from '../../../shared/domain'
import { TaskFilter } from '../../../shared/attention'
import {
  createTask,
  getTask,
  listDoneTasks,
  listPausedTasks,
  listStaleTodoTaskIds,
  listTasks,
  listWorkingTasks,
  setTaskTodos,
  updateTask,
} from './tasks'
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
      permissionMode: PermissionMode.AllowAll,
      createdAt: 2_000,
      updatedAt: 2_000,
      doneAt: null,
      sessionId: null,
      contextUsedTokens: 0,
      contextWindowTokens: 200_000,
      error: null,
      retrying: null,
      asking: false,
      awaitingPermission: false,
      pause: null,
      importedAt: null,
      todos: null,
    })
    expect(getTask(test.db, task.id)).toEqual(task)
  })

  it('records when a task was imported', () => {
    const task = createTask(
      test.db,
      { workspaceId: workspace.id, model: 'claude-sample-1', effort: Effort.High, importedAt: 3_000 },
      2_000,
    )
    expect(task.importedAt).toBe(3_000)
    expect(getTask(test.db, task.id)?.importedAt).toBe(3_000)
  })

  it("starts with its model's context window", () => {
    const task = createTask(test.db, { workspaceId: workspace.id, model: 'claude-sample-1[1m]', effort: Effort.High })
    expect(getTask(test.db, task.id)?.contextWindowTokens).toBe(1_000_000)
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
    const touched = updateTask(test.db, older.id, { pinned: true }, 4_000)
    expect(listTasks(test.db, workspace.id)).toEqual([touched, newer])
  })
})

const PAUSE: TaskPause = {
  reason: PauseReason.UsageLimit,
  since: 2_000,
  resumesAt: 60_000,
  checks: 0,
  details: "You've hit your session limit",
}

describe('listPausedTasks', () => {
  it("lists every workspace's active, paused tasks, oldest first", () => {
    const other = sampleWorkspace(test.db, '/code/billing')
    const paused = (workspaceId: string, now: number) =>
      updateTask(
        test.db,
        sampleTask(test.db, workspaceId, now).id,
        { activity: TaskActivity.Paused, pause: PAUSE },
        now,
      )
    const newer = paused(workspace.id, 3_000)
    const older = paused(other.id, 2_000)
    sampleTask(test.db, workspace.id)
    const done = paused(workspace.id, 4_000)
    updateTask(test.db, done.id, { state: TaskState.Done })

    expect(listPausedTasks(test.db).map((task) => task.id)).toEqual([older.id, newer.id])
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
        contextUsedTokens: 76_000,
        contextWindowTokens: 190_000,
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
      contextUsedTokens: 76_000,
      contextWindowTokens: 190_000,
      updatedAt: 3_000,
    })
    expect(getTask(test.db, task.id)).toEqual(updated)

    const unchanged = updateTask(test.db, task.id, {}, 4_000)
    expect(unchanged).toEqual({ ...updated, updatedAt: 4_000 })
    expect(updateTask(test.db, task.id, { sessionId: null }, 5_000).sessionId).toBeNull()
  })

  it("resets the context window to the new model's when the model changes without one", () => {
    const task = sampleTask(test.db, workspace.id)
    const reported = updateTask(test.db, task.id, { contextUsedTokens: 76_000, contextWindowTokens: 190_000 })

    expect(updateTask(test.db, task.id, { model: reported.model }).contextWindowTokens).toBe(190_000)
    const extended = updateTask(test.db, task.id, { model: 'claude-sample-2[1m]' })
    expect(extended).toMatchObject({ contextUsedTokens: 76_000, contextWindowTokens: 1_000_000 })
    expect(getTask(test.db, task.id)).toEqual(extended)
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

  it('leaves the update time alone when only the unread flag changes', () => {
    const task = sampleTask(test.db, workspace.id)

    const unread = updateTask(test.db, task.id, { unread: true, title: undefined }, 3_000)
    expect(unread).toEqual({ ...task, unread: true })
    expect(getTask(test.db, task.id)).toEqual(unread)
    expect(updateTask(test.db, task.id, { unread: false }, 4_000)).toEqual(task)
    expect(updateTask(test.db, task.id, { unread: true, pinned: true }, 5_000).updatedAt).toBe(5_000)
  })

  it('throws for an unknown id', () => {
    expect(() => updateTask(test.db, 'missing', { pinned: true })).toThrow('No task missing')
  })

  it('keeps the error and the API retry until a patch clears them', () => {
    const task = sampleTask(test.db, workspace.id)
    const error: TaskError = {
      kind: AgentErrorKind.Transient,
      source: TaskErrorSource.Api,
      status: 529,
      code: 'overloaded',
      details: 'API Error: 529 Overloaded',
      retries: 3,
      retryingMs: 120_000,
    }
    const retrying = { attempt: 2, maxRetries: 10, since: 1_000 }

    const stopped = updateTask(test.db, task.id, { error, retrying })
    expect(stopped).toMatchObject({ error, retrying })
    expect(getTask(test.db, task.id)).toEqual(stopped)
    expect(updateTask(test.db, task.id, { pinned: true })).toMatchObject({ error, retrying })

    const cleared = updateTask(test.db, task.id, { error: null, retrying: null })
    expect(cleared).toMatchObject({ error: null, retrying: null })
    expect(getTask(test.db, task.id)).toEqual(cleared)
  })

  it('keeps the pause until a patch clears it', () => {
    const task = sampleTask(test.db, workspace.id)

    const paused = updateTask(test.db, task.id, { activity: TaskActivity.Paused, pause: PAUSE })
    expect(paused).toMatchObject({ activity: TaskActivity.Paused, pause: PAUSE })
    expect(getTask(test.db, task.id)).toEqual(paused)
    expect(updateTask(test.db, task.id, { pinned: true })).toMatchObject({ pause: PAUSE })

    expect(updateTask(test.db, task.id, { pause: null }).pause).toBeNull()
    expect(getTask(test.db, task.id)?.pause).toBeNull()
  })

  it('refuses a pause that is not what the schema promises', () => {
    const task = sampleTask(test.db, workspace.id)
    test.db.prepare(`UPDATE tasks SET pause = '{"reason":"bored"}' WHERE id = ?`).run(task.id)
    expect(() => getTask(test.db, task.id)).toThrow(/tasks\.pause/)
  })

  it('refuses an error that is not what the schema promises', () => {
    const task = sampleTask(test.db, workspace.id)
    test.db.prepare(`UPDATE tasks SET error = '{"kind":"odd"}' WHERE id = ?`).run(task.id)
    expect(() => getTask(test.db, task.id)).toThrow(/tasks\.error/)
  })
})

describe('setTaskTodos', () => {
  const summary = { done: 3, total: 7, doing: ['Copy the files'] }

  it("keeps a task's todo summary without moving it in the list, and clears it", () => {
    const task = sampleTask(test.db, workspace.id, 2_000)
    expect(setTaskTodos(test.db, task.id, summary)).toBe(true)
    expect(getTask(test.db, task.id)).toEqual({ ...task, todos: summary })

    // Other changes keep it.
    const renamed = updateTask(test.db, task.id, { title: 'Move uploads to S3' }, 3_000)
    expect(renamed.todos).toEqual(summary)
    expect(getTask(test.db, task.id)?.todos).toEqual(summary)

    expect(setTaskTodos(test.db, task.id, null)).toBe(true)
    expect(getTask(test.db, task.id)?.todos).toBeNull()
    expect(setTaskTodos(test.db, 'gone', summary)).toBe(false)
  })

  it('clears the stale mark', () => {
    const [a, b] = [sampleTask(test.db, workspace.id, 2_000), sampleTask(test.db, workspace.id, 1_000)]
    test.db.prepare('UPDATE tasks SET todos_stale = 1').run()
    expect(listStaleTodoTaskIds(test.db)).toEqual([b.id, a.id])
    setTaskTodos(test.db, b.id, null)
    expect(listStaleTodoTaskIds(test.db)).toEqual([a.id])
  })

  it('comes with each page of the Done section', () => {
    const task = sampleTask(test.db, workspace.id)
    updateTask(test.db, task.id, { state: TaskState.Done }, 3_000)
    setTaskTodos(test.db, task.id, summary)
    const page = listDoneTasks(test.db, { workspaceId: workspace.id, filter: TaskFilter.All, after: null, limit: 10 })
    expect(page.tasks.map(({ todos }) => todos)).toEqual([summary])
  })

  it("refuses a summary the schema doesn't hold", () => {
    const task = sampleTask(test.db, workspace.id)
    test.db.prepare('UPDATE tasks SET todos = ? WHERE id = ?').run('{"done":1,"total":0,"doing":[]}', task.id)
    expect(() => getTask(test.db, task.id)).toThrow(/tasks\.todos/)
  })
})
