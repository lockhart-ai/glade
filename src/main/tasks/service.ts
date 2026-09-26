// Every write to a task goes through here: the renderer's task commands, the agent runner and, from P1-09, the agent's
// own tools. Each function writes the task, tells every window with `task.updated`, and returns the task as it now is.
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, EventType, type TaskUserPatch } from '../../shared/bridge'
import {
  UiStateKey,
  type ApiRetry,
  type AutoCompact,
  type Effort,
  type EpochMs,
  type PermissionMode,
  type Task,
  type TaskActivity,
  type TaskError,
  type TaskPause,
} from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { CommandFailure } from '../bridge/errors'
import { emitTaskUpdated, emitToolEventUpdated, type Emit } from '../bridge/events'
import {
  createTask as insertTask,
  deleteTask as removeTask,
  getTask,
  updateTask,
  type TaskPatch,
} from '../db/repositories/tasks'
import { interruptPausedToolCalls } from '../db/repositories/tool-events'
import { getUiState, setUiState } from '../db/repositories/ui-state'
import { getWorkspace } from '../db/repositories/workspaces'
import { getSettings } from '../db/repositories/settings'
import { applyTransition, TaskTransition } from './taskLifecycle'

export interface TaskServiceContext {
  readonly db: Database
  readonly emit: Emit
}

/** The fields the agent sets through its tools (`set_title`, `set_objective`, `set_status`). */
export interface AgentTaskPatch {
  readonly title?: string
  readonly objective?: string
  readonly status?: string
}

/**
 * The fields the agent runner keeps current: what the agent is doing, its SDK session id, its context usage, what
 * stopped it, the API retry in progress and what paused it.
 */
export interface RunnerTaskPatch {
  readonly activity?: TaskActivity
  readonly sessionId?: string
  readonly contextUsedTokens?: number
  readonly contextWindowTokens?: number
  readonly autoCompact?: AutoCompact
  /** Null clears it. */
  readonly error?: TaskError | null
  /** Null clears it. */
  readonly retrying?: ApiRetry | null
  /** Null clears it. */
  readonly pause?: TaskPause | null
}

/** The task, as it is now. Throws a `CommandFailure` `not_found` for no such task. */
export function requireTask(db: Database, id: string): Task {
  const task = getTask(db, id)
  if (task === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${id}`)
  return task
}

function write(context: TaskServiceContext, id: string, patch: TaskPatch): Task {
  const task = updateTask(context.db, id, patch)
  emitTaskUpdated(context.emit, task)
  return task
}

function move(context: TaskServiceContext, id: string, transition: TaskTransition): Task {
  const result = applyTransition(requireTask(context.db, id).state, transition)
  if (!result.ok) throw new CommandFailure(BridgeErrorCode.InvalidTransition, result.error.message)
  return write(context, id, { state: result.to })
}

/** What a new task can start with besides Settings' defaults: the control API's `create_task` sets these. */
export interface NewTaskFields {
  readonly title?: string
  readonly objective?: string
  readonly model?: string
  readonly effort?: Effort
  readonly permissionMode?: PermissionMode
}

/**
 * Creates an active task in the workspace: empty title, objective and status, and the model, effort and permission mode
 * Settings has as the defaults for new tasks, unless `fields` gives them.
 */
export function createTask(context: TaskServiceContext, workspaceId: string, fields: NewTaskFields = {}): Task {
  const task = insertNewTask(context.db, workspaceId, fields)
  emitTaskUpdated(context.emit, task)
  return task
}

/**
 * Writes the row of a task `createTask` would make, created `now`, without telling the windows: for a caller that
 * writes more of it in the same transaction (a backfill through the control API) and tells them once it's done.
 */
export function insertNewTask(
  db: Database,
  workspaceId: string,
  fields: NewTaskFields = {},
  now: EpochMs = Date.now(),
): Task {
  if (getWorkspace(db, workspaceId) === undefined) {
    throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${workspaceId}`)
  }
  const { defaultModel, defaultEffort, defaultPermissionMode } = getSettings(db)
  return insertTask(
    db,
    {
      workspaceId,
      model: fields.model ?? defaultModel,
      effort: fields.effort ?? defaultEffort,
      permissionMode: fields.permissionMode ?? defaultPermissionMode,
      ...(fields.title === undefined ? {} : { title: fields.title }),
      ...(fields.objective === undefined ? {} : { objective: fields.objective }),
    },
    now,
  )
}

/**
 * Marks an active task done and stamps `doneAt`. Its status stays as it is and is its outcome. A pause is behind it
 * then, so the calls a pause cut off read as interrupted, as they do when a task resumes.
 */
export function markTaskDone(context: TaskServiceContext, id: string): Task {
  const task = move(context, id, TaskTransition.MarkDone)
  for (const call of interruptPausedToolCalls(context.db, id)) emitToolEventUpdated(context.emit, call)
  return task
}

/**
 * Reopens a done task and clears `doneAt`. Marking done changes only the state, `doneAt` and `updatedAt`, so reopening
 * straight after restores every field but `updatedAt`: this is also Undo.
 */
export function reopenTask(context: TaskServiceContext, id: string): Task {
  return move(context, id, TaskTransition.Reopen)
}

/** Applies the user's changes to a task: its title, pin, unread flag, model, effort or permission mode. */
export function updateTaskFromUser(context: TaskServiceContext, id: string, patch: TaskUserPatch): Task {
  requireTask(context.db, id)
  const { title, pinned, unread, model, effort, permissionMode } = patch
  return write(context, id, { title, pinned, unread, model, effort, permissionMode })
}

/**
 * The changes a person, or an agent driving Glade (`update_task`, `docs/control-api.md`), can make to a task: the
 * user's, and its objective and status, which the window leaves to the task's own agent.
 */
export interface TaskChange extends TaskUserPatch {
  readonly objective?: string
  readonly status?: string
}

/** What changing a task needs besides the database: the runner, to tell a live session its new permission mode. */
export interface TaskChangeContext extends TaskServiceContext {
  readonly runner: Pick<AgentRunner, 'applyPermissionMode'>
}

/**
 * Changes a task (`tasks.update`, and the control API's `update_task`) in one write. A new permission mode reaches the
 * task's running session at once: it applies from the agent's next tool call, not its next turn.
 */
export function changeTask(context: TaskChangeContext, id: string, change: TaskChange): Task {
  requireTask(context.db, id)
  const { title, objective, status, pinned, unread, model, effort, permissionMode } = change
  const task = write(context, id, { title, objective, status, pinned, unread, model, effort, permissionMode })
  if (permissionMode !== undefined) context.runner.applyPermissionMode(id)
  return task
}

/** Applies the agent's changes to a task: its title, objective or status. */
export function updateTaskFromAgent(context: TaskServiceContext, id: string, patch: AgentTaskPatch): Task {
  requireTask(context.db, id)
  const { title, objective, status } = patch
  return write(context, id, { title, objective, status })
}

/**
 * Records what the agent runner learned: the task's activity, its SDK session id, its context usage, its error or its
 * pause.
 */
export function updateTaskFromRunner(context: TaskServiceContext, id: string, patch: RunnerTaskPatch): Task {
  requireTask(context.db, id)
  const { activity, sessionId, contextUsedTokens, contextWindowTokens, autoCompact, error, retrying, pause } = patch
  return write(context, id, {
    activity,
    sessionId,
    contextUsedTokens,
    contextWindowTokens,
    autoCompact,
    error,
    retrying,
    pause,
  })
}

/** Marks a task read or unread. This isn't a change to the task, so its `updatedAt` stays as it is. */
export function setTaskUnread(context: TaskServiceContext, id: string, unread: boolean): Task {
  requireTask(context.db, id)
  return write(context, id, { unread })
}

/** What deleting a task needs besides the database: the runner, to close the task's agent session first. */
export interface TaskDeletionContext extends TaskServiceContext {
  readonly runner: Pick<AgentRunner, 'discard'>
}

/**
 * Deletes a task (`tasks.delete`): closes its agent's live session, if it has one, then deletes its rows, which takes
 * its chat log, tool log, queue and question sets with it (`deleteTask` in the repository). Nothing on disk is touched.
 * The selected task is deselected. Tells every window with `task.deleted`.
 */
export function deleteTask(context: TaskDeletionContext, id: string): void {
  const { db, emit, runner } = context
  requireTask(db, id)
  runner.discard(id)
  const deselect = getUiState(db, UiStateKey.SelectedTaskId) === id
  db.transaction(() => {
    removeTask(db, id)
    if (deselect) setUiState(db, { key: UiStateKey.SelectedTaskId, value: '' })
  })()
  if (deselect) emit({ type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: '' } })
  emit({ type: EventType.TaskDeleted, taskId: id })
}
