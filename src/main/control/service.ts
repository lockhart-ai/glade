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
import { ArtifactKind, TaskState, type Effort, type EpochMs, type PermissionMode, type Task } from '../../shared/domain'
import type { AgentRunner } from '../agent/runner'
import { emitTaskUpdated, type Emit } from '../bridge/events'
import { CommandFailure } from '../bridge/errors'
import { lookAtArtifactFile } from '../artifacts/artifacts'
import {
  addArtifact,
  addLinkArtifact,
  changeArtifact,
  changeLinkArtifact,
  listArtifacts,
  removeArtifact,
  setArtifactFile,
  type ArtifactFileState,
} from '../db/repositories/artifacts'
import { findTaskByExternalId, getHandoff, setExternalId, setHandoff } from '../db/repositories/backfills'
import { lastTurn, listMessages } from '../db/repositories/messages'
import { searchTaskIds } from '../db/repositories/search'
import { countTasksByWorkspace, getTasks, listTaskIds, updateTask } from '../db/repositories/tasks'
import { listToolEvents } from '../db/repositories/tool-events'
import { getWorkspace, listWorkspaces } from '../db/repositories/workspaces'
import { findModel } from '../../shared/models'
import { childOfArtifact } from '../../shared/todoHub'
import { listModels } from '../models/models'
import {
  changeTask,
  deleteTask,
  insertNewTask,
  markTaskDone,
  reopenTask,
  requireTask,
  type TaskChange,
  type TaskDates,
} from '../tasks/service'
import { refileChild, unfileChildren } from '../todo-hub/todo-hub'
import {
  createClaudeCodeSessions,
  type ClaudeCodeSession,
  type ClaudeCodeSessionRef,
  type ListClaudeCodeSessionsInput,
} from './claude-code/service'
import type { SkippedCounts } from './claude-code/session'
import { claudeProjectsDir } from './claude-code/transcripts'
import {
  checkArtifactRemovals,
  checkArtifacts,
  checkArtifactUpdates,
  planArtifactChanges,
  type ArtifactRegistration,
  type ArtifactUpdateRequest,
  type CheckedArtifact,
  type PlannedArtifactChange,
} from './backfill'
import { instantOf } from './dates'
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
  /** Its one-line status. */
  readonly status?: string
  readonly model?: string
  readonly effort?: Effort
  readonly permissionMode?: PermissionMode
  /** Its handoff note, Markdown, for a past task backfilled (`docs/control-api.md`, "Backfilling past tasks"). */
  readonly handoff?: string
  /** Files of its workspace to register as its artifacts, by absolute path. */
  readonly artifacts?: readonly ArtifactRegistration[]
  /** When it started, as an ISO 8601 date (`./dates`): its created time. Now by default. */
  readonly startedAt?: string
  /**
   * When it was last updated, as an ISO 8601 date: its place in the sidebar, and its done time too when it's created
   * done. `statusUpdatedAt`, else `startedAt`, by default.
   */
  readonly updatedAt?: string
  /** When its status was set, as an ISO 8601 date; it needs a `status`. `updatedAt` by default. */
  readonly statusUpdatedAt?: string
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

/**
 * The changes `update_task` makes: the task's fields, its handoff note (null clears it), its artifacts (those to take
 * off, then those to change, then those to register), the caller's own id for it, and its dates, as ISO 8601 dates
 * (`./dates`), given rather than stamped.
 */
export interface TaskUpdate extends TaskChange {
  readonly handoff?: string | null
  readonly artifacts?: readonly ArtifactRegistration[]
  readonly updateArtifacts?: readonly ArtifactUpdateRequest[]
  /** Artifacts to take off, by absolute path; their files stay. */
  readonly removeArtifacts?: readonly string[]
  readonly externalId?: string
  readonly updatedAt?: string
  readonly statusUpdatedAt?: string
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
    for (const artifact of checked) {
      switch (artifact.kind) {
        case ArtifactKind.File:
          addArtifact(db, { taskId, path: artifact.path, title: artifact.title }, at)
          break
        case ArtifactKind.Link:
          addLinkArtifact(db, { taskId, url: artifact.url, title: artifact.title }, at)
          break
      }
    }
  }

  /** Makes one planned change to one of a task's artifacts, noting what its new file is now when it has one. */
  const changeOne = (taskId: string, change: PlannedArtifactChange, file: ArtifactFileState | null, at: number) => {
    const { ref, newRef, title } = change
    if (ref.kind === ArtifactKind.Link && newRef.kind === ArtifactKind.Link) {
      changeLinkArtifact(db, { taskId, url: ref.url, newUrl: newRef.url, title }, at)
    } else if (ref.kind === ArtifactKind.File && newRef.kind === ArtifactKind.File) {
      changeArtifact(db, { taskId, path: ref.path, newPath: newRef.path, title }, at)
      if (file !== null) setArtifactFile(db, { taskId, path: newRef.path, file })
    }
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
      const {
        workspaceId,
        message,
        handoff,
        artifacts = [],
        state = TaskState.Active,
        externalId,
        startedAt,
        updatedAt,
        statusUpdatedAt,
        ...fields
      } = request
      requireOfferedModel(db, fields.model, 'model')
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
      const dates = creationDates({ startedAt, updatedAt, statusUpdatedAt, status: fields.status }, at)
      const checked = await checkArtifacts(summaryOf(workspaceId).rootPath, artifacts, 'artifacts')
      const write = db.transaction((): { readonly id: string; readonly created: boolean } => {
        // Another create with the same id may have finished while this one looked at the files.
        const raced = existing()
        if (raced !== undefined) return { id: raced, created: false }
        const { id } = insertNewTask(db, workspaceId, fields, dates.started)
        if (externalId !== undefined) setExternalId(db, id, externalId)
        if (handoff !== undefined) setHandoff(db, id, handoff, at)
        registerArtifacts(id, checked, at)
        // Created at its start; last updated (and done, when it's created done) at its updatedAt.
        if (state === TaskState.Done || dates.updated !== dates.started) {
          const patch = { updatedAt: dates.updated, statusUpdatedAt: dates.statusUpdated }
          updateTask(db, id, state === TaskState.Done ? { ...patch, state } : patch, dates.updated)
        }
        return { id, created: true }
      })
      const { id, created } = write()
      if (!created) return { task: detailOf(id), created }
      emitTaskUpdated(emit, requireTask(db, id))
      announceBackfill(id, handoff !== undefined, checked.length > 0)
      if (message !== undefined) runner.send(id, message)
      return { task: detailOf(id), created }
    },

    async updateTask(
      id,
      {
        handoff,
        artifacts = [],
        updateArtifacts = [],
        removeArtifacts = [],
        externalId,
        updatedAt,
        statusUpdatedAt,
        ...change
      },
    ) {
      requireOfferedModel(db, change.model, 'patch.model')
      const root = summaryOf(requireTask(db, id).workspaceId).rootPath
      const checked = await checkArtifacts(root, artifacts, 'patch.artifacts')
      const updates = await checkArtifactUpdates(root, updateArtifacts, 'patch.updateArtifacts')
      const removals = checkArtifactRemovals(root, removeArtifacts, 'patch.removeArtifacts')
      // What each repointed artifact's new file is now, which places it in the Artifacts tab. A link has none.
      const files = await Promise.all(
        updates.map(async ({ ref, newRef }) =>
          ref.kind === ArtifactKind.File && newRef.kind === ArtifactKind.File && newRef.path !== ref.path
            ? await lookAtArtifactFile(root, newRef.path)
            : null,
        ),
      )
      // Everything is checked before anything is written, with nothing awaited between, so a refused patch changes
      // nothing and no other call can take the external id meanwhile. The artifact changes are planned against the
      // artifacts as they are once the files have been looked at.
      const current = requireTask(db, id)
      const dates = updateDates({ current, change, updatedAt, statusUpdatedAt }, now())
      if (externalId !== undefined) requireFreeExternalId(db, id, externalId)
      const plan = planArtifactChanges(listArtifacts(db, id), removals, updates, {
        removals: 'patch.removeArtifacts',
        updates: 'patch.updateArtifacts',
      })
      // Only the task's own fields and dates write the task, and `updateDates` says whether that moves it in the
      // sidebar; the handoff, artifacts and external id alone leave it as it is.
      const changesTask = Object.keys(change).length > 0 || updatedAt !== undefined || statusUpdatedAt !== undefined
      const task = changesTask ? changeTask(context, id, change, dates) : current
      const at = now()
      db.transaction(() => {
        if (handoff !== undefined) setHandoff(db, id, handoff, at)
        if (externalId !== undefined) setExternalId(db, id, externalId)
        for (const ref of plan.removals) removeArtifact(db, id, ref)
        for (const [index, change] of plan.changes.entries()) changeOne(id, change, files[index] ?? null, at)
        registerArtifacts(id, checked, at)
      })()
      // With the todo hub on, an artifact's filing under a todo follows it, as it does for the agent's own tools: one
      // taken off leaves none, and one pointed elsewhere keeps its todo. One added here has no todo: nothing names it.
      unfileChildren(context, id, plan.removals.map(childOfArtifact))
      for (const { ref, newRef } of plan.changes)
        refileChild(context, id, childOfArtifact(ref), childOfArtifact(newRef))
      announceBackfill(id, handoff !== undefined, checked.length + plan.changes.length + plan.removals.length > 0)
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

/**
 * Refuses a model the pickers don't offer (`listModels`): the id the SDK takes, or the full id it stands for. `field`
 * names it in the error.
 */
export function requireOfferedModel(db: Database, model: string | undefined, field: string): void {
  if (model === undefined) return
  const models = listModels(db)
  if (findModel(models, model) !== undefined) return
  const offered = models.map(({ id, name }) => `${id} (${name})`).join(', ')
  throw new ControlError(ControlErrorCode.InvalidInput, `${field}: ${model} is not a model Glade offers: ${offered}`)
}

/** Refuses a delete that wasn't confirmed. */
export function requireConfirmed(confirm: boolean | undefined): void {
  if (confirm !== true) {
    throw new ControlError(ControlErrorCode.ConfirmRequired, 'Deleting a task needs confirm: true')
  }
}

/** A new task's dates, as `create_task` gives them, before they're checked. */
interface CreationDateInput {
  readonly startedAt: string | undefined
  readonly updatedAt: string | undefined
  readonly statusUpdatedAt: string | undefined
  readonly status: string | undefined
}

/** A new task's dates, checked: when it started, was last updated, and had its status set (when it has one). */
interface CreationDates {
  readonly started: EpochMs
  readonly updated: EpochMs
  readonly statusUpdated: EpochMs | undefined
}

/** An instant in ISO 8601, UTC, for an error message. */
const isoOf = (at: EpochMs): string => new Date(at).toISOString()

function refuse(message: string): ControlError {
  return new ControlError(ControlErrorCode.InvalidInput, message)
}

/**
 * A new task's dates, as of `now`: started `startedAt` (now by default), last updated `updatedAt` (else
 * `statusUpdatedAt`, else when it started), its status set `statusUpdatedAt` (else when it was last updated). Each must
 * be no later than now, and they must come in that order: started, status set, last updated. `invalid_input` names the
 * field that doesn't.
 */
function creationDates(input: CreationDateInput, now: EpochMs): CreationDates {
  const started = input.startedAt === undefined ? now : instantOf(input.startedAt, 'startedAt', now)
  const statusSet =
    input.statusUpdatedAt === undefined ? undefined : instantOf(input.statusUpdatedAt, 'statusUpdatedAt', now)
  const updated = input.updatedAt === undefined ? (statusSet ?? started) : instantOf(input.updatedAt, 'updatedAt', now)
  if (statusSet !== undefined) {
    if (input.status === undefined) throw refuse('statusUpdatedAt: needs a status')
    if (statusSet < started) {
      throw refuse(`statusUpdatedAt: ${String(input.statusUpdatedAt)} is before the task started (${isoOf(started)})`)
    }
    if (statusSet > updated) {
      throw refuse(`statusUpdatedAt: ${String(input.statusUpdatedAt)} is after updatedAt (${isoOf(updated)})`)
    }
  }
  if (updated < started) {
    throw refuse(`updatedAt: ${String(input.updatedAt)} is before the task started (${isoOf(started)})`)
  }
  return { started, updated, statusUpdated: input.status === undefined ? undefined : (statusSet ?? updated) }
}

/** A patch's dates, as `update_task` gives them, before they're checked, and the task they change. */
interface UpdateDateInput {
  readonly current: Task
  readonly change: TaskChange
  readonly updatedAt: string | undefined
  readonly statusUpdatedAt: string | undefined
}

/**
 * The dates a patch writes, as of `now`: the ones it gives, each no later than now and no earlier than the task
 * started (a status date only for a task with a status, and no later than an `updatedAt` given with it). A new status
 * given with an `updatedAt` is dated then. A patch that changes nothing that moves the task (only its unread flag or its
 * status date) keeps its `updatedAt`; any other change stamps it now, unless the patch gives one.
 */
function updateDates(input: UpdateDateInput, now: EpochMs): TaskDates {
  const { current, change } = input
  const instant = (iso: string | undefined, field: string): EpochMs | undefined => {
    if (iso === undefined) return undefined
    const at = instantOf(iso, field, now)
    if (at < current.createdAt)
      throw refuse(`${field}: ${iso} is before the task started (${isoOf(current.createdAt)})`)
    return at
  }
  const updated = instant(input.updatedAt, 'patch.updatedAt')
  const statusSet = instant(input.statusUpdatedAt, 'patch.statusUpdatedAt')
  if (statusSet !== undefined) {
    if ((change.status ?? current.status) === '') throw refuse('patch.statusUpdatedAt: the task has no status')
    if (updated !== undefined && statusSet > updated) {
      throw refuse(
        `patch.statusUpdatedAt: ${String(input.statusUpdatedAt)} is after patch.updatedAt (${isoOf(updated)})`,
      )
    }
  }
  const moves = Object.keys(change).some((field) => field !== 'unread')
  const newStatus = change.status !== undefined && change.status !== current.status
  return {
    updatedAt: updated ?? (moves ? undefined : current.updatedAt),
    statusUpdatedAt: statusSet ?? (newStatus ? updated : undefined),
  }
}

/** Refuses an external id another task already has: `invalid_input`, naming that task. */
function requireFreeExternalId(db: Database, id: string, externalId: string): void {
  const holder = findTaskByExternalId(db, externalId)
  if (holder !== undefined && holder !== id) {
    throw refuse(`patch.externalId: another task (${holder}) already has ${externalId}`)
  }
}
