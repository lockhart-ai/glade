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
import { BridgeErrorCode, EventType } from '../../shared/bridge'
import { TaskState, type Effort, type PermissionMode, type Task } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { emitTaskUpdated, type Emit } from '../bridge/events'
import { CommandFailure } from '../bridge/errors'
import { addArtifact, listArtifacts } from '../db/repositories/artifacts'
import { findTaskByExternalId, getHandoff, setExternalId, setHandoff } from '../db/repositories/backfills'
import { lastTurn, listMessages } from '../db/repositories/messages'
import { searchTaskIds } from '../db/repositories/search'
import { countTasksByWorkspace, getTasks, listTaskIds, updateTask } from '../db/repositories/tasks'
import { listToolEvents } from '../db/repositories/tool-events'
import { getWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import {
  changeTask,
  deleteTask,
  insertNewTask,
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
import { checkArtifacts, startedAt as startedAtOf, type ArtifactRegistration, type CheckedArtifact } from './backfill'
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
  /** Its handoff note, Markdown, for a past task backfilled (`docs/control-api.md`, "Backfilling past tasks"). */
  readonly handoff?: string
  /** Files of its workspace to register as its artifacts, by absolute path. */
  readonly artifacts?: readonly ArtifactRegistration[]
  /**
   * When it started, as an ISO 8601 date: its created time, and its done time too when it's created done. Now by
   * default.
   */
  readonly startedAt?: string
  /** Done creates it done, which takes no first message; active by default. */
  readonly state?: TaskState
  /** The caller's own id for it: creating a task with an id another already has answers with that task instead. */
  readonly externalId?: string
}

/** What `create_task` did: the task, and whether it made it (false when a task already had its `externalId`). */
export interface CreatedTask {
  readonly task: TaskDetail
  readonly created: boolean
}

/** The changes `update_task` makes: the task's fields, its handoff note (null clears it) and artifacts to register. */
export interface TaskUpdate extends TaskChange {
  readonly handoff?: string | null
  readonly artifacts?: readonly ArtifactRegistration[]
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
  createTask(request: NewTaskRequest): Promise<CreatedTask>
  updateTask(id: string, update: TaskUpdate): Promise<TaskDetail>
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
  const { db, emit, runner } = context
  const listings = createListings(context.now)
  const claudeCode = createClaudeCodeSessions({
    db,
    emit: context.emit,
    projectsDir: context.claudeProjectsDir ?? claudeProjectsDir(),
  })
  const now = context.now ?? Date.now

  const summaryOf = (workspaceId: string): WorkspaceSummary => {
    const workspace = getWorkspace(db, workspaceId)
    if (workspace === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No workspace ${workspaceId}`)
    return workspaceSummary(workspace, countTasksByWorkspace(db).get(workspaceId))
  }

  const detail = (task: Task): TaskDetail => taskDetail(db, task, summaryOf(task.workspaceId))

  const detailOf = (id: string): TaskDetail => detail(requireTask(db, id))

  const registerArtifacts = (taskId: string, checked: readonly CheckedArtifact[], at: number): void => {
    for (const { path, title } of checked) addArtifact(db, { taskId, path, title }, at)
  }

  /** Tells every window a task's handoff note, or its artifacts, changed. */
  const announceBackfill = (taskId: string, handoff: boolean, artifacts: boolean): void => {
    if (handoff) emit({ type: EventType.HandoffChanged, taskId, handoff: getHandoff(db, taskId) ?? null })
    if (artifacts) emit({ type: EventType.ArtifactsChanged, taskId, artifacts: listArtifacts(db, taskId) })
  }

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

    async createTask(request) {
      const { workspaceId, message, handoff, artifacts = [], state = TaskState.Active, externalId, ...fields } = request
      if (state === TaskState.Done && message !== undefined) {
        throw new ControlError(
          ControlErrorCode.InvalidInput,
          'message: a task created done takes no first message; send it one with send_message to reopen it',
        )
      }
      const existing = (): string | undefined =>
        externalId === undefined ? undefined : findTaskByExternalId(db, externalId)
      const found = existing()
      if (found !== undefined) return { task: detailOf(found), created: false }
      const at = now()
      const started = request.startedAt === undefined ? at : startedAtOf(request.startedAt, at)
      const checked = await checkArtifacts(summaryOf(workspaceId).rootPath, artifacts, 'artifacts')
      const write = db.transaction((): { readonly id: string; readonly created: boolean } => {
        // Another create with the same id may have finished while this one looked at the files.
        const raced = existing()
        if (raced !== undefined) return { id: raced, created: false }
        const { id } = insertNewTask(db, workspaceId, fields, started)
        if (externalId !== undefined) setExternalId(db, id, externalId)
        if (handoff !== undefined) setHandoff(db, id, handoff, at)
        registerArtifacts(id, checked, at)
        if (state === TaskState.Done) updateTask(db, id, { state }, started)
        return { id, created: true }
      })
      const { id, created } = write()
      if (!created) return { task: detailOf(id), created }
      emitTaskUpdated(emit, requireTask(db, id))
      announceBackfill(id, handoff !== undefined, checked.length > 0)
      if (message !== undefined) runner.send(id, message)
      return { task: detailOf(id), created }
    },

    async updateTask(id, { handoff, artifacts = [], ...change }) {
      const checked = await checkArtifacts(
        summaryOf(requireTask(db, id).workspaceId).rootPath,
        artifacts,
        'patch.artifacts',
      )
      // A patch of only the handoff and artifacts leaves the task as it is, so it keeps its place in the sidebar.
      const changesTask = Object.keys(change).length > 0
      const task = changesTask ? changeTask(context, id, change) : requireTask(db, id)
      const at = now()
      db.transaction(() => {
        if (handoff !== undefined) setHandoff(db, id, handoff, at)
        registerArtifacts(id, checked, at)
      })()
      announceBackfill(id, handoff !== undefined, checked.length > 0)
      return detail(task)
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
