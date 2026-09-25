import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  AgentErrorKind,
  Effort,
  PauseReason,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  TaskErrorSource,
  QuestionSetState,
  TaskState,
  type ApiRetry,
  type EpochMs,
  type Task,
  type TaskError,
  type TaskPause,
} from '../../../shared/domain'
import { contextWindowFor } from '../../../shared/contextWindow'
import { Row, RowError } from './rows'

export interface NewTask {
  readonly workspaceId: string
  readonly model: string
  readonly effort: Effort
  /** Allow all unless given. */
  readonly permissionMode?: PermissionMode
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
  readonly permissionMode?: PermissionMode
  readonly sessionId?: string | null
  readonly contextUsedTokens?: number
  /** The window the SDK reported. Changing the model without one resets it to what the new model's id gives. */
  readonly contextWindowTokens?: number
  /** What stopped the agent; null clears it. */
  readonly error?: TaskError | null
  /** The automatic API retry in progress; null clears it. */
  readonly retrying?: ApiRetry | null
  /** Why the turn is paused and when it resumes; null clears it. */
  readonly pause?: TaskPause | null
}

const COLUMNS = `id, workspace_id, title, objective, status, status_updated_at, state, activity, pinned, unread, model,
  effort, permission_mode, created_at, updated_at, done_at, session_id, context_used_tokens, context_window_tokens, error,
  retrying, pause`

/** What a task is read with: its columns, and whether it has an open question set or permission request. */
const SELECTED = `${COLUMNS}, EXISTS (SELECT 1 FROM question_sets WHERE question_sets.task_id = tasks.id
  AND question_sets.state = '${QuestionSetState.Open}') AS asking,
  EXISTS (SELECT 1 FROM permission_requests WHERE permission_requests.task_id = tasks.id
  AND permission_requests.state = '${PermissionRequestState.Open}') AS awaiting_permission`

const TASK_STATES = Object.values(TaskState)
const TASK_ACTIVITIES = Object.values(TaskActivity)
const EFFORTS = Object.values(Effort)
const PERMISSION_MODES = Object.values(PermissionMode)

const count = z.int().nonnegative()

const taskErrorSchema = z.strictObject({
  kind: z.enum(AgentErrorKind),
  source: z.enum(TaskErrorSource),
  status: z.int().nullable(),
  code: z.string().nullable(),
  details: z.string(),
  retries: count,
  retryingMs: count,
}) satisfies z.ZodType<TaskError>

const apiRetrySchema = z.strictObject({
  attempt: z.int().positive(),
  maxRetries: count,
  since: count,
}) satisfies z.ZodType<ApiRetry>

const taskPauseSchema = z.strictObject({
  reason: z.enum(PauseReason),
  since: count,
  resumesAt: count,
  checks: count,
  details: z.string(),
}) satisfies z.ZodType<TaskPause>

/** A nullable JSON column holding a value `schema` parses. */
function jsonColumn<T>(row: Row, table: string, column: string, schema: z.ZodType<T>): T | null {
  if (row.nullableText(column) === null) return null
  const parsed = schema.safeParse(row.jsonObject(column))
  if (!parsed.success) throw new RowError(table, column, z.prettifyError(parsed.error))
  return parsed.data
}

function parseTask(raw: unknown): Task {
  const row = new Row('tasks', raw)
  const model = row.text('model')
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
    model,
    effort: row.oneOf('effort', EFFORTS),
    permissionMode: row.oneOf('permission_mode', PERMISSION_MODES),
    createdAt: row.integer('created_at'),
    updatedAt: row.integer('updated_at'),
    doneAt: row.nullableInteger('done_at'),
    sessionId: row.nullableText('session_id'),
    contextUsedTokens: row.integer('context_used_tokens'),
    // Null until the SDK reports the window, e.g. for a task from before there was a context meter.
    contextWindowTokens: row.nullableInteger('context_window_tokens') ?? contextWindowFor(model),
    error: jsonColumn(row, 'tasks', 'error', taskErrorSchema),
    retrying: jsonColumn(row, 'tasks', 'retrying', apiRetrySchema),
    asking: row.flag('asking'),
    awaitingPermission: row.flag('awaiting_permission'),
    pause: jsonColumn(row, 'tasks', 'pause', taskPauseSchema),
  }
}

/**
 * The named parameters for a task's columns (and `asking` and `awaitingPermission`, which no statement uses: they're
 * derived from the question sets and permission requests).
 */
function toParams(task: Task): Record<string, string | number | null> {
  return {
    ...task,
    asking: task.asking ? 1 : 0,
    awaitingPermission: task.awaitingPermission ? 1 : 0,
    pinned: task.pinned ? 1 : 0,
    unread: task.unread ? 1 : 0,
    error: task.error === null ? null : JSON.stringify(task.error),
    retrying: task.retrying === null ? null : JSON.stringify(task.retrying),
    pause: task.pause === null ? null : JSON.stringify(task.pause),
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
    permissionMode: input.permissionMode ?? PermissionMode.AllowAll,
    createdAt: now,
    updatedAt: now,
    doneAt: null,
    sessionId: null,
    contextUsedTokens: 0,
    contextWindowTokens: contextWindowFor(input.model),
    error: null,
    retrying: null,
    asking: false,
    awaitingPermission: false,
    pause: null,
  }
  db.prepare(
    `INSERT INTO tasks (${COLUMNS}) VALUES (@id, @workspaceId, @title, @objective, @status, @statusUpdatedAt, @state,
      @activity, @pinned, @unread, @model, @effort, @permissionMode, @createdAt, @updatedAt, @doneAt, @sessionId,
      @contextUsedTokens, @contextWindowTokens, @error, @retrying, @pause)`,
  ).run(toParams(task))
  return task
}

export function getTask(db: Database, id: string): Task | undefined {
  const row: unknown = db.prepare(`SELECT ${SELECTED} FROM tasks WHERE id = ?`).get(id)
  return row === undefined ? undefined : parseTask(row)
}

/** A workspace's tasks, most recently updated first. */
export function listTasks(db: Database, workspaceId: string): Task[] {
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC, id`)
    .all(workspaceId)
    .map(parseTask)
}

/** Every workspace's active tasks whose turn is paused, oldest first. On launch, their pauses are armed again. */
export function listPausedTasks(db: Database): Task[] {
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE state = ? AND activity = ? ORDER BY created_at, id`)
    .all(TaskState.Active, TaskActivity.Paused)
    .map(parseTask)
}

/** Every workspace's active tasks whose agent is working, oldest first. On launch, these are the turns the app died in. */
export function listWorkingTasks(db: Database): Task[] {
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE state = ? AND activity = ? ORDER BY created_at, id`)
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
 * Whether a patch changes only whether the task is unread. Reading a task, or marking it unread, isn't a change to the
 * task, so it doesn't stamp `updatedAt`: the task keeps its place and its relative time in the task list.
 */
function onlyUnread(patch: TaskPatch): boolean {
  return (
    patch.unread !== undefined && Object.entries(patch).every(([key, value]) => key === 'unread' || value === undefined)
  )
}

/**
 * Changes a task's fields, stamps `updatedAt` (and `statusUpdatedAt` when the status changes), and returns it updated.
 * A patch of only `unread` leaves `updatedAt` alone (see `onlyUnread`). Throws if there's no such task.
 */
export function updateTask(db: Database, id: string, patch: TaskPatch, now: EpochMs = Date.now()): Task {
  const current = getTask(db, id)
  if (current === undefined) throw new Error(`No task ${id}`)
  const state = patch.state ?? current.state
  const status = patch.status ?? current.status
  const model = patch.model ?? current.model
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
    model,
    effort: patch.effort ?? current.effort,
    permissionMode: patch.permissionMode ?? current.permissionMode,
    updatedAt: onlyUnread(patch) ? current.updatedAt : now,
    doneAt: doneAtAfter(current, state, now),
    sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
    contextUsedTokens: patch.contextUsedTokens ?? current.contextUsedTokens,
    contextWindowTokens:
      patch.contextWindowTokens ?? (model === current.model ? current.contextWindowTokens : contextWindowFor(model)),
    error: patch.error === undefined ? current.error : patch.error,
    retrying: patch.retrying === undefined ? current.retrying : patch.retrying,
    pause: patch.pause === undefined ? current.pause : patch.pause,
  }
  db.prepare(
    `UPDATE tasks SET title = @title, objective = @objective, status = @status, status_updated_at = @statusUpdatedAt,
      state = @state, activity = @activity, pinned = @pinned, unread = @unread, model = @model, effort = @effort,
      permission_mode = @permissionMode, updated_at = @updatedAt, done_at = @doneAt, session_id = @sessionId, context_used_tokens = @contextUsedTokens,
      context_window_tokens = @contextWindowTokens, error = @error, retrying = @retrying,
      pause = @pause
    WHERE id = @id`,
  ).run(toParams(updated))
  return updated
}

/**
 * Deletes a task and, through the foreign keys' `ON DELETE CASCADE`, every row that belongs to it: its messages, tool
 * events, queued messages, question sets, permission requests and search index rows. It touches nothing on disk. Answers whether there was such a task.
 */
export function deleteTask(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
}
