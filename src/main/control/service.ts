/**
 * The control service (`docs/control-api.md`): one typed function per thing another agent can do to Glade, over the
 * same code the window's commands run (`../tasks/service`, the agent runner, the repositories), so a change made
 * through it is the change the UI would make, with the same checks and the same events to every open window.
 *
 * It knows nothing of who's calling or how: the switch, the rate limits and a task's guard against itself are the
 * tools' (`./tools`). Failures throw: a `ControlError`, or the `CommandFailure` the shared code throws, which the tools
 * turn into the same codes.
 */
import type { Database } from 'better-sqlite3'
import { BridgeErrorCode } from '../../shared/bridge'
import { TaskState, type Effort, type PermissionMode, type Task } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import type { Emit } from '../bridge/events'
import { CommandFailure } from '../bridge/errors'
import { lastTurn, listMessages } from '../db/repositories/messages'
import { searchTaskIds } from '../db/repositories/search'
import { countTasksByWorkspace, getTasks, listTaskIds } from '../db/repositories/tasks'
import { listToolEvents } from '../db/repositories/tool-events'
import { getWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import {
  changeTask,
  createTask,
  deleteTask,
  markTaskDone,
  reopenTask,
  requireTask,
  type TaskChange,
} from '../tasks/service'
import {
  createClaudeCodeSessions,
  type ClaudeCodeSession,
  type ClaudeCodeSessionRef,
  type ListClaudeCodeSessionsInput,
} from './claude-code/service'
import type { SkippedCounts } from './claude-code/session'
import { claudeProjectsDir } from './claude-code/transcripts'
import { ControlError, ControlErrorCode } from './errors'
import { createListings } from './listings'
import {
  chatTurns,
  taskDetail,
  taskSummary,
  workspaceSummary,
  type ChatTurn,
  type TaskDetail,
  type TaskSummary,
  type WorkspaceSummary,
} from './views'

export interface ControlServiceContext {
  readonly db: Database
  readonly emit: Emit
  readonly runner: AgentRunner
  /** The clock the listings expire by: `Date.now` by default. */
  readonly now?: () => number
  /**
   * Claude Code's projects folder, whose sessions `list_claude_code_sessions` lists: `$CLAUDE_CONFIG_DIR/projects`, or
   * `~/.claude/projects`, by default.
   */
  readonly claudeProjectsDir?: string
}

/** Which tasks `list_tasks` lists by state. */
export enum TaskStateFilter {
  Active = 'active',
  Done = 'done',
  All = 'all',
}

export interface TaskListRequest {
  /** Every workspace's tasks when null. */
  readonly workspaceId: string | null
  readonly state: TaskStateFilter
  /** Full-text, over the sidebar search's index; null lists without searching. */
  readonly query: string | null
  readonly cursor: string | undefined
  readonly limit: number
}

export interface TaskPage {
  readonly tasks: readonly TaskSummary[]
  readonly nextCursor: string | null
}

export interface ChatRequest {
  readonly id: string
  readonly fromTurn: number
  readonly limit: number
  readonly includeTools: boolean
}

export interface ChatPage {
  readonly turns: readonly ChatTurn[]
  readonly totalTurns: number
  readonly nextFromTurn: number | null
}

export interface NewTaskRequest {
  readonly workspaceId: string
  /** The first message: sending it starts the agent. Without one the task waits for it. */
  readonly message?: string
  readonly title?: string
  readonly objective?: string
  readonly model?: string
  readonly effort?: Effort
  readonly permissionMode?: PermissionMode
}

/** What sending a message did with it, as the input bar decides. */
export enum Delivery {
  /** It started a turn (reopening a done task). */
  Sent = 'sent',
  /** It waits in the queue, while the agent works, a permission card waits or the task is paused. */
  Queued = 'queued',
  /** It answered the agent's open questions, in words. */
  Answered = 'answered',
}

export interface SentMessage {
  readonly delivery: Delivery
  readonly task: TaskDetail
}

export interface DeletedTask {
  readonly deleted: string
}

export interface ClaudeCodeSessionPage {
  readonly sessions: readonly ClaudeCodeSession[]
  readonly nextCursor: string | null
}

export interface ClaudeCodeImportRequest {
  readonly session: ClaudeCodeSessionRef
  readonly state: TaskState
  readonly createWorkspace: boolean
}

export interface ImportedSession {
  readonly task: TaskDetail
  /** False when the session was already in Glade: `task` is the task that has it. */
  readonly imported: boolean
  readonly skipped: SkippedCounts
}

export interface ControlService {
  listWorkspaces(): readonly WorkspaceSummary[]
  listTasks(request: TaskListRequest): TaskPage
  getTask(id: string): TaskDetail
  getChat(request: ChatRequest): ChatPage
  createTask(request: NewTaskRequest): TaskDetail
  updateTask(id: string, change: TaskChange): TaskDetail
  sendMessage(id: string, text: string): SentMessage
  stopTask(id: string): Promise<TaskDetail>
  markDone(id: string): TaskDetail
  reopenTask(id: string): TaskDetail
  deleteTask(id: string): DeletedTask
  listClaudeCodeSessions(request: ListClaudeCodeSessionsInput): Promise<ClaudeCodeSessionPage>
  importClaudeCodeSession(request: ClaudeCodeImportRequest): Promise<ImportedSession>
}

/** The state a filter lists, or null for both. */
function stateOf(filter: TaskStateFilter): TaskState | null {
  switch (filter) {
    case TaskStateFilter.Active:
      return TaskState.Active
    case TaskStateFilter.Done:
      return TaskState.Done
    case TaskStateFilter.All:
      return null
  }
}

export function createControlService(context: ControlServiceContext): ControlService {
  const { db, runner } = context
  const listings = createListings(context.now)
  const claudeCode = createClaudeCodeSessions({
    db,
    emit: context.emit,
    projectsDir: context.claudeProjectsDir ?? claudeProjectsDir(),
  })

  const summaryOf = (workspaceId: string): WorkspaceSummary => {
    const workspace = getWorkspace(db, workspaceId)
    if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${workspaceId}`)
    return workspaceSummary(workspace, countTasksByWorkspace(db).get(workspaceId))
  }

  const detail = (task: Task): TaskDetail => taskDetail(db, task, summaryOf(task.workspaceId))

  const detailOf = (id: string): TaskDetail => detail(requireTask(db, id))

  /** The order a listing's first page fixes: the search's ranking, or pinned first then newest first. */
  const orderOf = (request: TaskListRequest): string[] => {
    const state = stateOf(request.state)
    if (request.query === null) return listTaskIds(db, request.workspaceId, state)
    const ranked = searchTaskIds(db, request.workspaceId, request.query)
    if (state === null) return ranked
    const inState = new Set(getTasks(db, ranked).flatMap((task) => (task.state === state ? [task.id] : [])))
    return ranked.filter((id) => inState.has(id))
  }

  return {
    listWorkspaces() {
      const counts = countTasksByWorkspace(db)
      return listWorkspaces(db).map((workspace) => workspaceSummary(workspace, counts.get(workspace.id)))
    },

    listTasks(request) {
      if (request.workspaceId !== null) summaryOf(request.workspaceId)
      const { workspaceId, state, query, cursor, limit } = request
      const page = listings.page({
        key: JSON.stringify({ workspaceId, state, query }),
        cursor,
        limit,
        order: () => orderOf(request),
      })
      const byId = new Map(getTasks(db, page.ids).map((task) => [task.id, task]))
      const tasks = page.ids.flatMap((id) => {
        const task = byId.get(id)
        return task === undefined ? [] : [taskSummary(task)]
      })
      return { tasks, nextCursor: page.nextCursor }
    },

    getTask: detailOf,

    getChat({ id, fromTurn, limit, includeTools }) {
      const task = requireTask(db, id)
      const totalTurns = lastTurn(db, id)
      const to = Math.min(totalTurns, fromTurn + limit - 1)
      const source = {
        db,
        taskId: id,
        rootPath: summaryOf(task.workspaceId).rootPath,
        messages: listMessages(db, id),
        toolEvents: includeTools ? listToolEvents(db, id) : [],
      }
      return {
        turns: chatTurns(source, fromTurn, to, includeTools),
        totalTurns,
        nextFromTurn: to < totalTurns ? to + 1 : null,
      }
    },

    createTask({ workspaceId, message, ...fields }) {
      const task = createTask(context, workspaceId, fields)
      if (message !== undefined) runner.send(task.id, message)
      return detailOf(task.id)
    },

    updateTask(id, change) {
      return detail(changeTask(context, id, change))
    },

    sendMessage(id, text) {
      const task = requireTask(db, id)
      // What the input bar does: a message to an agent waiting on answers answers them; otherwise it's sent, unless the
      // agent is busy (working, waiting on a permission card, paused), when it waits in the queue.
      if (task.asking) {
        runner.send(id, text)
        return { delivery: Delivery.Answered, task: detailOf(id) }
      }
      try {
        runner.send(id, text)
        return { delivery: Delivery.Sent, task: detailOf(id) }
      } catch (error) {
        if (!(error instanceof CommandFailure) || error.code !== BridgeErrorCode.Busy) throw error
      }
      runner.queue(id, text)
      return { delivery: Delivery.Queued, task: detailOf(id) }
    },

    async stopTask(id) {
      return detail(await runner.stop(id))
    },

    markDone(id) {
      return detail(markTaskDone(context, id))
    },

    reopenTask(id) {
      return detail(reopenTask(context, id))
    },

    deleteTask(id) {
      deleteTask(context, id)
      return { deleted: id }
    },

    listClaudeCodeSessions: (request) => claudeCode.list(request),

    async importClaudeCodeSession(request) {
      const { task, imported, skipped } = await claudeCode.import(request)
      return { task: detail(task), imported, skipped }
    },
  }
}

/** Refuses a delete that wasn't confirmed. */
export function requireConfirmed(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new ControlError(ControlErrorCode.ConfirmRequired, 'Deleting a task needs confirm: true')
  }
}
