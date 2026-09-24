import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { Effort, TaskActivity, TaskState, type EpochMs, type Task } from '../../../shared/domain'
import { Row } from './rows'

export interface NewTask {
  readonly workspaceId: string
  readonly model: string
  readonly effort: Effort
  readonly title?: string
  readonly objective?: string
  readonly status?: string
}

/** The fields `updateTask` can change; the ones left out keep their value. */
export interface TaskPatch {
  readonly title?: string
  readonly objective?: string
  readonly status?: string
  /** Moving to done sets `doneAt`; moving back to active clears it. */
  readonly state?: TaskState
  readonly activity?: TaskActivity
  readonly pinned?: boolean
  readonly unread?: boolean
  readonly model?: string
  readonly effort?: Effort
  readonly sessionId?: string | null
}

const COLUMNS = `id, workspace_id, title, objective, status, status_updated_at, state, activity, pinned, unread, model,
  effort, created_at, updated_at, done_at, session_id`

const TASK_STATES = Object.values(TaskState)
const TASK_ACTIVITIES = Object.values(TaskActivity)
const EFFORTS = Object.values(Effort)

function parseTask(raw: unknown): Task {
  const row = new Row('tasks', raw)
  return {
    id: row.text('id'),
    workspaceId: row.text('workspace_id'),
    title: row.text('title'),
    objective: row.text('objective'),
    status: row.text('status'),
    statusUpdatedAt: row.nullableInteger('status_updated_at'),
    state: row.oneOf('state', TASK_STATES),
    activity: row.oneOf('activity', TASK_ACTIVITIES),
    pinned: row.flag('pinned'),
    unread: row.flag('unread'),
    model: row.text('model'),
    effort: row.oneOf('effort', EFFORTS),
    createdAt: row.integer('created_at'),
    updatedAt: row.integer('updated_at'),
    doneAt: row.nullableInteger('done_at'),
    sessionId: row.nullableText('session_id'),
  }
}

/** The named parameters for a task's columns. */
function toParams(task: Task): Record<string, string | number | null> {
  return {
    ...task,
    pinned: task.pinned ? 1 : 0,
    unread: task.unread ? 1 : 0,
  }
}

/** Creates an active task. Its title, objective and status start empty unless given. */
export function createTask(db: Database, input: NewTask, now: EpochMs = Date.now()): Task {
  const status = input.status ?? ''
  const task: Task = {
    id: randomUUID(),
    workspaceId: input.workspaceId,
    title: input.title ?? '',
    objective: input.objective ?? '',
    status,
    statusUpdatedAt: status === '' ? null : now,
    state: TaskState.Active,
    activity: TaskActivity.Waiting,
    pinned: false,
    unread: false,
    model: input.model,
    effort: input.effort,
    createdAt: now,
    updatedAt: now,
    doneAt: null,
    sessionId: null,
  }
  db.prepare(
    `INSERT INTO tasks (${COLUMNS}) VALUES (@id, @workspaceId, @title, @objective, @status, @statusUpdatedAt, @state,
      @activity, @pinned, @unread, @model, @effort, @createdAt, @updatedAt, @doneAt, @sessionId)`,
  ).run(toParams(task))
  return task
}

export function getTask(db: Database, id: string): Task | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM tasks WHERE id = ?`).get(id)
  return row === undefined ? undefined : parseTask(row)
}

/** A workspace's tasks, most recently updated first. */
export function listTasks(db: Database, workspaceId: string): Task[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC, id`)
    .all(workspaceId)
    .map(parseTask)
}

/** Every workspace's active tasks whose agent is working, oldest first. On launch, these are the turns the app died in. */
export function listWorkingTasks(db: Database): Task[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM tasks WHERE state = ? AND activity = ? ORDER BY created_at, id`)
    .all(TaskState.Active, TaskActivity.Working)
    .map(parseTask)
}

function doneAtAfter(current: Task, state: TaskState, now: EpochMs): EpochMs | null {
  if (state === current.state) return current.doneAt
  switch (state) {
    case TaskState.Done:
      return now
    case TaskState.Active:
      return null
  }
}

/**
 * Changes a task's fields, stamps `updatedAt` (and `statusUpdatedAt` when the status changes), and returns it updated.
 * Throws if there's no such task.
 */
export function updateTask(db: Database, id: string, patch: TaskPatch, now: EpochMs = Date.now()): Task {
  const current = getTask(db, id)
  if (current === undefined) throw new Error(`No task ${id}`)
  const state = patch.state ?? current.state
  const status = patch.status ?? current.status
  const updated: Task = {
    ...current,
    title: patch.title ?? current.title,
    objective: patch.objective ?? current.objective,
    status,
    statusUpdatedAt: status === current.status ? current.statusUpdatedAt : now,
    state,
    activity: patch.activity ?? current.activity,
    pinned: patch.pinned ?? current.pinned,
    unread: patch.unread ?? current.unread,
    model: patch.model ?? current.model,
    effort: patch.effort ?? current.effort,
    updatedAt: now,
    doneAt: doneAtAfter(current, state, now),
    sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
  }
  db.prepare(
    `UPDATE tasks SET title = @title, objective = @objective, status = @status, status_updated_at = @statusUpdatedAt,
      state = @state, activity = @activity, pinned = @pinned, unread = @unread, model = @model, effort = @effort,
      updated_at = @updatedAt, done_at = @doneAt, session_id = @sessionId
    WHERE id = @id`,
  ).run(toParams(updated))
  return updated
}
