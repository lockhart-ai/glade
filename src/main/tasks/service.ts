// Every write to a task goes through here: the renderer's task commands, the agent runner and, from P1-09, the agent's
// own tools. Each function writes the task, tells every window with `task.updated`, and returns the task as it now is.
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode, type TaskUserPatch } from '../../shared/bridge'
import type { ApiRetry, Task, TaskActivity, TaskError, TaskPause } from '../../shared/domain'
import { CommandFailure } from '../bridge/errors'
import { emitTaskUpdated, emitToolEventUpdated, type Emit } from '../bridge/events'
import { createTask as insertTask, getTask, updateTask, type TaskPatch } from '../db/repositories/tasks'
import { interruptPausedToolCalls } from '../db/repositories/tool-events'
import { getWorkspace } from '../db/repositories/workspaces'
import { DEFAULT_EFFORT, DEFAULT_MODEL } from './defaults'
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
  /** Null clears it. */
  readonly error?: TaskError | null
  /** Null clears it. */
  readonly retrying?: ApiRetry | null
  /** Null clears it. */
  readonly pause?: TaskPause | null
}

function existing(db: Database, id: string): Task {
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
  const result = applyTransition(existing(context.db, id).state, transition)
  if (!result.ok) throw new CommandFailure(BridgeErrorCode.InvalidTransition, result.error.message)
  return write(context, id, { state: result.to })
}

/** Creates an active task in the workspace: empty title, objective and status, and the default model and effort. */
export function createTask(context: TaskServiceContext, workspaceId: string): Task {
  if (getWorkspace(context.db, workspaceId) === undefined) {
    throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${workspaceId}`)
  }
  const task = insertTask(context.db, { workspaceId, model: DEFAULT_MODEL, effort: DEFAULT_EFFORT })
  emitTaskUpdated(context.emit, task)
  return task
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

/** Applies the user's changes to a task: its title, pin, unread flag, model or effort. */
export function updateTaskFromUser(context: TaskServiceContext, id: string, patch: TaskUserPatch): Task {
  existing(context.db, id)
  const { title, pinned, unread, model, effort } = patch
  return write(context, id, { title, pinned, unread, model, effort })
}

/** Applies the agent's changes to a task: its title, objective or status. */
export function updateTaskFromAgent(context: TaskServiceContext, id: string, patch: AgentTaskPatch): Task {
  existing(context.db, id)
  const { title, objective, status } = patch
  return write(context, id, { title, objective, status })
}

/**
 * Records what the agent runner learned: the task's activity, its SDK session id, its context usage, its error or its
 * pause.
 */
export function updateTaskFromRunner(context: TaskServiceContext, id: string, patch: RunnerTaskPatch): Task {
  existing(context.db, id)
  const { activity, sessionId, contextUsedTokens, contextWindowTokens, error, retrying, pause } = patch
  return write(context, id, { activity, sessionId, contextUsedTokens, contextWindowTokens, error, retrying, pause })
}

/** Marks a task read or unread. This isn't a change to the task, so its `updatedAt` stays as it is. */
export function setTaskUnread(context: TaskServiceContext, id: string, unread: boolean): Task {
  existing(context.db, id)
  return write(context, id, { unread })
}
