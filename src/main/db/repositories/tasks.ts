import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  AgentErrorKind,
  AutoCompactKind,
  Effort,
  PauseReason,
  PermissionMode,
  PermissionRequestState,
  TaskActivity,
  TaskErrorSource,
  QuestionSetState,
  TaskState,
  WatcherState,
  type ApiRetry,
  type AutoCompact,
  type EpochMs,
  type Task,
  type TaskError,
  type TaskPause,
  type TodoSummary,
} from '../../../shared/domain'
import { UsageLimitKind, type UsageLimit } from '../../../shared/account'
import { fitContextWindow } from '../../../shared/contextWindow'
import { sameModel } from '../../../shared/models'
import { SUBAGENT_TOOL_NAMES } from '../../../shared/subagents'
import { guessModelWindow, taskModelWindow } from './context-windows'
import { offeredModels } from './sdk-models'
import type { DoneCounts, DonePage, DonePageRequest } from '../../../shared/doneList'
import { sandboxAskSchema } from '../../permissions/schema'
import { Row, RowError } from './rows'

export interface NewTask {
  /** A new id unless given (a sample fixture's fixed one). */
  readonly id?: string
  readonly workspaceId: string
  readonly model: string
  readonly effort: Effort
  /** Allow all unless given. */
  readonly permissionMode?: PermissionMode
  readonly title?: string
  readonly objective?: string
  readonly status?: string
  /** When it was imported from a Claude Code session; not imported unless given. */
  readonly importedAt?: EpochMs
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
  /**
   * The window the SDK reported. Changing the model without one keeps the window when the new model is the same one
   * under another id, and otherwise takes the best guess at the new model's (`guessModelWindow`).
   */
  readonly contextWindowTokens?: number
  /**
   * Where the SDK compacts automatically, as it said. Changing the model without one clears it when the window changes
   * with it, since it depends on the window.
   */
  readonly autoCompact?: AutoCompact
  /** What stopped the agent; null clears it. */
  readonly error?: TaskError | null
  /** The automatic API retry in progress; null clears it. */
  readonly retrying?: ApiRetry | null
  /** Why the turn is paused and when it resumes; null clears it. */
  readonly pause?: TaskPause | null
  /** When it was last updated, given rather than stamped (a backfill's own date); `now`, or kept, if not. */
  readonly updatedAt?: EpochMs
  /** When its status was set, given rather than stamped; `now` if the status changes, and kept if it doesn't. */
  readonly statusUpdatedAt?: EpochMs
}

const COLUMNS = `id, workspace_id, title, objective, status, status_updated_at, state, activity, pinned, unread, model,
  effort, permission_mode, created_at, updated_at, done_at, session_id, context_used_tokens, context_window_tokens, error,
  retrying, pause, imported_at, todos, auto_compact`

/** The tools that start a subagent, as SQL string literals. */
const SUBAGENT_NAMES = SUBAGENT_TOOL_NAMES.map((name) => `'${name}'`).join(', ')

/**
 * What a task is read with: its columns, whether it has an open question set or permission request, and whether it
 * has background work running: a subagent's call (the literals match the `tool_events_running` index) or a watcher's
 * process.
 */
const SELECTED = `${COLUMNS}, (SELECT json_extract(choice, '$.model.name') || ' · ' || json_extract(choice, '$.provider.name') FROM openrouter_choices WHERE id = tasks.model) AS model_name, EXISTS (SELECT 1 FROM question_sets WHERE question_sets.task_id = tasks.id
  AND question_sets.state = '${QuestionSetState.Open}') AS asking,
  EXISTS (SELECT 1 FROM permission_requests WHERE permission_requests.task_id = tasks.id
  AND permission_requests.state = '${PermissionRequestState.Open}') AS awaiting_permission,
  (SELECT sandbox FROM permission_requests WHERE permission_requests.task_id = tasks.id
  AND permission_requests.state = '${PermissionRequestState.Open}'
  ORDER BY permission_requests.created_at, permission_requests.rowid LIMIT 1) AS permission_ask,
  (EXISTS (SELECT 1 FROM tool_events WHERE tool_events.task_id = tasks.id AND tool_events.kind = 'tool_call'
  AND tool_events.tool_state = 'running' AND tool_events.tool_name IN (${SUBAGENT_NAMES}))
  OR EXISTS (SELECT 1 FROM watchers WHERE watchers.task_id = tasks.id
  AND watchers.state = '${WatcherState.Running}')) AS background_work`

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

/** Which usage limit paused a turn (`TaskPause.limit`). */
const usageLimitSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.enum([UsageLimitKind.Session, UsageLimitKind.Weekly, UsageLimitKind.ExtraUsage]),
  }),
  z.strictObject({ kind: z.literal(UsageLimitKind.WeeklyModel), model: z.string() }),
]) satisfies z.ZodType<UsageLimit>

const taskPauseSchema = z.strictObject({
  reason: z.enum(PauseReason),
  since: count,
  resumesAt: count,
  checks: count,
  details: z.string(),
  // Left out of a pause from before #519, and of one whose limit the SDK didn't name.
  limit: usageLimitSchema.optional(),
}) satisfies z.ZodType<TaskPause>

const autoCompactSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal(AutoCompactKind.On), thresholdTokens: count }),
  z.strictObject({ kind: z.literal(AutoCompactKind.Off) }),
]) satisfies z.ZodType<AutoCompact>

const todoSummarySchema = z.strictObject({
  done: count,
  total: z.int().positive(),
  doing: z.array(z.string()).readonly(),
}) satisfies z.ZodType<TodoSummary>

/** A nullable JSON column holding a value `schema` parses. */
function jsonColumn<T>(row: Row, table: string, column: string, schema: z.ZodType<T>): T | null {
  if (row.nullableText(column) === null) return null
  const parsed = schema.safeParse(row.jsonObject(column))
  if (!parsed.success) throw new RowError(table, column, z.prettifyError(parsed.error))
  return parsed.data
}

/** The context window a task shows, and where the SDK compacts in it. */
interface ContextSize {
  readonly contextWindowTokens: number
  readonly autoCompact: AutoCompact | null
}

/**
 * The window to show for a task that has used `usedTokens` of a `windowTokens` window, which the SDK compacts at
 * `autoCompact`: the window, unless what's used is more than it holds, which proves it wrong, and the larger observed
 * size wins (`fitContextWindow`). A threshold no bigger than the wrong window was for that window, so it goes too: the
 * meter falls back to the SDK's default for the right one until the SDK says again. Only what's used counts as proof:
 * a threshold is the SDK's answer to a question asked after the turn, which a model change can leave stale.
 */
function fitContext(usedTokens: number, windowTokens: number, autoCompact: AutoCompact | null): ContextSize {
  const threshold = autoCompact?.kind === AutoCompactKind.On ? autoCompact.thresholdTokens : 0
  const fitted = fitContextWindow(windowTokens, usedTokens)
  const stale = fitted !== windowTokens && autoCompact?.kind === AutoCompactKind.On && threshold <= windowTokens
  return { contextWindowTokens: fitted, autoCompact: stale ? null : autoCompact }
}

function parseTask(db: Database, raw: unknown): Task {
  const row = new Row('tasks', raw)
  const model = row.text('model')
  const modelName = row.nullableText('model_name')
  const contextUsedTokens = row.integer('context_used_tokens')
  const context = fitContext(
    contextUsedTokens,
    // Null until the SDK reports the window, e.g. for a task from before there was a context meter.
    row.nullableInteger('context_window_tokens') ?? guessModelWindow(db, model),
    jsonColumn(row, 'tasks', 'auto_compact', autoCompactSchema),
  )
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
    ...(modelName === null ? {} : { modelName }),
    effort: row.oneOf('effort', EFFORTS),
    permissionMode: row.oneOf('permission_mode', PERMISSION_MODES),
    createdAt: row.integer('created_at'),
    updatedAt: row.integer('updated_at'),
    doneAt: row.nullableInteger('done_at'),
    sessionId: row.nullableText('session_id'),
    contextUsedTokens,
    contextWindowTokens: context.contextWindowTokens,
    error: jsonColumn(row, 'tasks', 'error', taskErrorSchema),
    retrying: jsonColumn(row, 'tasks', 'retrying', apiRetrySchema),
    asking: row.flag('asking'),
    awaitingPermission: row.flag('awaiting_permission'),
    permissionAsk: jsonColumn(row, 'tasks', 'permission_ask', sandboxAskSchema),
    backgroundWork: row.flag('background_work'),
    pause: jsonColumn(row, 'tasks', 'pause', taskPauseSchema),
    importedAt: row.nullableInteger('imported_at'),
    todos: jsonColumn(row, 'tasks', 'todos', todoSummarySchema),
    autoCompact: context.autoCompact,
  }
}

/**
 * The named parameters for a task's columns (and `asking`, `awaitingPermission`, `permissionAsk` and `backgroundWork`, which no
 * statement uses: they're derived from the question sets, permission requests, tool log and watchers).
 */
function toParams(task: Task): Record<string, string | number | null> {
  return {
    ...task,
    asking: task.asking ? 1 : 0,
    awaitingPermission: task.awaitingPermission ? 1 : 0,
    permissionAsk: null,
    backgroundWork: task.backgroundWork ? 1 : 0,
    pinned: task.pinned ? 1 : 0,
    unread: task.unread ? 1 : 0,
    error: task.error === null ? null : JSON.stringify(task.error),
    retrying: task.retrying === null ? null : JSON.stringify(task.retrying),
    pause: task.pause === null ? null : JSON.stringify(task.pause),
    todos: task.todos === null ? null : JSON.stringify(task.todos),
    autoCompact: task.autoCompact === null ? null : JSON.stringify(task.autoCompact),
  }
}

/** Creates an active task. Its title, objective and status start empty unless given. */
export function createTask(db: Database, input: NewTask, now: EpochMs = Date.now()): Task {
  const status = input.status ?? ''
  const task: Task = {
    id: input.id ?? randomUUID(),
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
    contextWindowTokens: taskModelWindow(db, input.model),
    error: null,
    retrying: null,
    asking: false,
    awaitingPermission: false,
    permissionAsk: null,
    backgroundWork: false,
    pause: null,
    importedAt: input.importedAt ?? null,
    todos: null,
    autoCompact: null,
  }
  db.prepare(
    `INSERT INTO tasks (${COLUMNS}) VALUES (@id, @workspaceId, @title, @objective, @status, @statusUpdatedAt, @state,
      @activity, @pinned, @unread, @model, @effort, @permissionMode, @createdAt, @updatedAt, @doneAt, @sessionId,
      @contextUsedTokens, @contextWindowTokens, @error, @retrying, @pause, @importedAt, @todos, @autoCompact)`,
  ).run(toParams(task))
  return task
}

export function getTask(db: Database, id: string): Task | undefined {
  const row: unknown = db.prepare(`SELECT ${SELECTED} FROM tasks WHERE id = ?`).get(id)
  return row === undefined ? undefined : parseTask(db, row)
}

/** A workspace's tasks, most recently updated first. */
export function listTasks(db: Database, workspaceId: string): Task[] {
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE workspace_id = ? ORDER BY updated_at DESC, id`)
    .all(workspaceId)
    .map((row) => parseTask(db, row))
}

/**
 * A workspace's tasks outside the Done section: its active tasks, and its pinned ones whatever their state, most
 * recently updated first.
 */
export function listActiveTasks(db: Database, workspaceId: string): Task[] {
  return db
    .prepare(
      `SELECT ${SELECTED} FROM tasks WHERE workspace_id = ? AND (state = ? OR pinned = 1) ORDER BY updated_at DESC, id`,
    )
    .all(workspaceId, TaskState.Active)
    .map((row) => parseTask(db, row))
}

/** The Done section: a workspace's done tasks that aren't pinned (a pinned task shows under Pinned). */
const DONE_SECTION = `workspace_id = @workspaceId AND state = '${TaskState.Done}' AND pinned = 0`

/** How many tasks a workspace's Done section holds. */
export function countDoneTasks(db: Database, workspaceId: string): DoneCounts {
  const row: unknown = db.prepare(`SELECT COUNT(*) AS total FROM tasks WHERE ${DONE_SECTION}`).get({ workspaceId })
  const counts = new Row('tasks', row)
  return { all: counts.integer('total') }
}

/** How many active and done tasks a workspace has. */
export interface TaskCounts {
  readonly active: number
  readonly done: number
}

/** How many active and done tasks each workspace has, by its id; a workspace with none isn't in it. */
export function countTasksByWorkspace(db: Database): Map<string, TaskCounts> {
  const counts = new Map<string, TaskCounts>()
  const rows = db
    .prepare(
      `SELECT workspace_id, SUM(state = @active) AS active, SUM(state = @done) AS done FROM tasks GROUP BY workspace_id`,
    )
    .all({ active: TaskState.Active, done: TaskState.Done })
  for (const raw of rows) {
    const row = new Row('tasks', raw)
    counts.set(row.text('workspace_id'), { active: row.integer('active'), done: row.integer('done') })
  }
  return counts
}

/**
 * The ids of the tasks in a workspace (or in every workspace, for null) in a state (or in either, for null), pinned
 * first, then most recently updated first, ties by id.
 */
export function listTaskIds(db: Database, workspaceId: string | null, state: TaskState | null): string[] {
  const ids: unknown[] = db
    .prepare(
      `SELECT id FROM tasks WHERE (@workspaceId IS NULL OR workspace_id = @workspaceId)
        AND (@state IS NULL OR state = @state) ORDER BY pinned DESC, updated_at DESC, id`,
    )
    .pluck()
    .all({ workspaceId, state })
  return ids.filter((id): id is string => typeof id === 'string')
}

/**
 * A page of a workspace's Done section, most recently updated first and ties by id, starting just
 * after `after` (keyset pagination on the `tasks_done_list` index). It reads one task more than the page holds to
 * tell whether more follow.
 */
export function listDoneTasks(db: Database, request: DonePageRequest): DonePage {
  const { workspaceId, after, limit } = request
  // "After" in the list's order: older, or as old with a later id. The first half is a range the index can seek to.
  const keyset = after === null ? '' : 'AND updated_at <= @updatedAt AND (updated_at < @updatedAt OR id > @id)'
  const rows = db
    .prepare(
      `SELECT ${SELECTED} FROM tasks WHERE ${DONE_SECTION} ${keyset}
      ORDER BY updated_at DESC, id LIMIT @limit`,
    )
    .all({ workspaceId, limit: limit + 1, ...(after === null ? {} : { updatedAt: after.updatedAt, id: after.id }) })
    .map((row) => parseTask(db, row))
  return { tasks: rows.slice(0, limit), hasMore: rows.length > limit }
}

/** The tasks with these ids that exist, in no particular order. */
export function getTasks(db: Database, ids: readonly string[]): Task[] {
  if (ids.length === 0) return []
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(ids))
    .map((row) => parseTask(db, row))
}

/** Every workspace's active tasks whose turn is paused, oldest first. On launch, their pauses are armed again. */
export function listPausedTasks(db: Database): Task[] {
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE state = ? AND activity = ? ORDER BY created_at, id`)
    .all(TaskState.Active, TaskActivity.Paused)
    .map((row) => parseTask(db, row))
}

/** Every workspace's active tasks whose agent is working, oldest first. On launch, these are the turns the app died in. */
export function listWorkingTasks(db: Database): Task[] {
  return db
    .prepare(`SELECT ${SELECTED} FROM tasks WHERE state = ? AND activity = ? ORDER BY created_at, id`)
    .all(TaskState.Active, TaskActivity.Working)
    .map((row) => parseTask(db, row))
}

/**
 * Every workspace's active tasks a lost login stopped (an error of kind `AgentErrorKind.LoggedOut`), oldest first: the
 * ones Retry all retries once you've logged in again (#409).
 */
export function listLoggedOutTasks(db: Database): Task[] {
  return db
    .prepare(
      `SELECT ${SELECTED} FROM tasks WHERE state = ? AND activity = ? AND json_extract(error, '$.kind') = ?
        ORDER BY created_at, id`,
    )
    .all(TaskState.Active, TaskActivity.Error, AgentErrorKind.LoggedOut)
    .map((row) => parseTask(db, row))
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
 * The window and auto-compact threshold a task has after `patch` moves it to model `model`: the ones it gives, else the
 * task's own while the model stays the same one (by any id) or the new model's best guess (`guessModelWindow`) is the
 * same size; else that guess, with the threshold unknown until the SDK says.
 */
function contextAfter(
  db: Database,
  current: Task,
  model: string,
  patch: TaskPatch,
): [window: number, autoCompact: AutoCompact | null] {
  const guess = model === current.model ? current.contextWindowTokens : taskModelWindow(db, model)
  const kept = guess === current.contextWindowTokens || sameModel(offeredModels(db), model, current.model)
  const window = patch.contextWindowTokens ?? (kept ? current.contextWindowTokens : guess)
  return [window, patch.autoCompact ?? (kept ? current.autoCompact : null)]
}

/**
 * Changes a task's fields, stamps `updatedAt` (and `statusUpdatedAt` when the status changes), and returns it updated.
 * A patch of only `unread` leaves `updatedAt` alone (see `onlyUnread`), and a date the patch gives wins over the stamp.
 * Throws if there's no such task.
 */
export function updateTask(db: Database, id: string, patch: TaskPatch, now: EpochMs = Date.now()): Task {
  const current = getTask(db, id)
  if (current === undefined) throw new Error(`No task ${id}`)
  const state = patch.state ?? current.state
  const status = patch.status ?? current.status
  const model = patch.model ?? current.model
  const contextUsedTokens = patch.contextUsedTokens ?? current.contextUsedTokens
  const context = fitContext(contextUsedTokens, ...contextAfter(db, current, model, patch))
  const updated: Task = {
    ...current,
    title: patch.title ?? current.title,
    objective: patch.objective ?? current.objective,
    status,
    statusUpdatedAt: patch.statusUpdatedAt ?? (status === current.status ? current.statusUpdatedAt : now),
    state,
    activity: patch.activity ?? current.activity,
    pinned: patch.pinned ?? current.pinned,
    unread: patch.unread ?? current.unread,
    model,
    effort: patch.effort ?? current.effort,
    permissionMode: patch.permissionMode ?? current.permissionMode,
    updatedAt: patch.updatedAt ?? (onlyUnread(patch) ? current.updatedAt : now),
    doneAt: doneAtAfter(current, state, now),
    sessionId: patch.sessionId === undefined ? current.sessionId : patch.sessionId,
    contextUsedTokens,
    contextWindowTokens: context.contextWindowTokens,
    autoCompact: context.autoCompact,
    error: patch.error === undefined ? current.error : patch.error,
    retrying: patch.retrying === undefined ? current.retrying : patch.retrying,
    pause: patch.pause === undefined ? current.pause : patch.pause,
  }
  db.prepare(
    `UPDATE tasks SET title = @title, objective = @objective, status = @status, status_updated_at = @statusUpdatedAt,
      state = @state, activity = @activity, pinned = @pinned, unread = @unread, model = @model, effort = @effort,
      permission_mode = @permissionMode, updated_at = @updatedAt, done_at = @doneAt, session_id = @sessionId, context_used_tokens = @contextUsedTokens,
      context_window_tokens = @contextWindowTokens, auto_compact = @autoCompact, error = @error, retrying = @retrying,
      pause = @pause
    WHERE id = @id`,
  ).run(toParams(updated))
  return updated
}

/**
 * Sets a task's todo summary (null for no list) and clears its stale mark. It's worked out from the tool log, not a
 * change the task made, so it leaves `updatedAt` alone: the task keeps its place in the task list. Answers whether there
 * was such a task.
 */
export function setTaskTodos(db: Database, id: string, todos: TodoSummary | null): boolean {
  const json = todos === null ? null : JSON.stringify(todos)
  return db.prepare('UPDATE tasks SET todos = ?, todos_stale = 0 WHERE id = ?').run(json, id).changes > 0
}

/** The ids of the tasks whose todo summary must be worked out again (see migration 29), oldest first. */
export function listStaleTodoTaskIds(db: Database): string[] {
  const ids: unknown[] = db.prepare('SELECT id FROM tasks WHERE todos_stale = 1 ORDER BY created_at, id').pluck().all()
  return ids.filter((id): id is string => typeof id === 'string')
}

/**
 * Deletes a task and, through the foreign keys' `ON DELETE CASCADE`, every row that belongs to it: its messages, tool
 * events, queued messages, question sets, permission requests and search index rows. It touches nothing on disk. Answers whether there was such a task.
 */
export function deleteTask(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0
}
