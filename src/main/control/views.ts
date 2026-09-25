/**
 * What the control API says of workspaces, tasks and chats (`docs/control-api.md`, "Types"): plain JSON, made from the
 * rows the window reads, with the fields another agent needs and nothing of the window's own.
 */
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { needsYou } from '../../shared/attention'
import {
  ToolEventKind,
  type AgentErrorKind,
  type Effort,
  type MessageRole,
  type ToolCallState,
  type EpochMs,
  type Message,
  type PauseReason,
  type PermissionMode,
  type Task,
  type TaskActivity,
  type TaskState,
  type ToolCallEvent,
  type ToolEvent,
  type Workspace,
} from '../../shared/domain'
import { toolDisplayName } from '../../shared/toolName'
import { argumentSummary } from '../../shared/toolSummary'
import { listArtifacts } from '../db/repositories/artifacts'
import { getExternalId, getHandoff } from '../db/repositories/backfills'
import { lastTurn, turnStartedAt } from '../db/repositories/messages'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import type { TaskCounts } from '../db/repositories/tasks'

/** A workspace, with how many tasks it holds. */
export interface WorkspaceSummary {
  readonly id: string
  readonly name: string
  readonly rootPath: string
  readonly activeTasks: number
  readonly doneTasks: number
}

/** A task as its row in the sidebar shows it. */
export interface TaskSummary {
  readonly id: string
  readonly workspaceId: string
  /** Empty until the task is named. */
  readonly title: string
  readonly status: string
  readonly state: TaskState
  /** What its agent is doing: the status dot, with `needsYou`. */
  readonly activity: TaskActivity
  readonly needsYou: boolean
  readonly pinned: boolean
  readonly unread: boolean
  readonly updatedAt: EpochMs
  readonly doneAt: EpochMs | null
}

/** What stopped a task's agent, in short. */
export interface TaskDetailError {
  readonly kind: AgentErrorKind
  readonly details: string
}

/** What paused a task's turn, and when it resumes. */
export interface TaskDetailPause {
  readonly reason: PauseReason
  readonly resumesAt: EpochMs
}

/** A task's handoff note, from a backfill: Markdown, and when it was set. */
export interface TaskDetailHandoff {
  readonly body: string
  readonly addedAt: EpochMs
}

/** One of a task's artifacts: its file's absolute path, its title, and when it was first declared or registered. */
export interface TaskDetailArtifact {
  readonly path: string
  readonly title: string
  readonly addedAt: EpochMs
}

/** A task as its header card and its sidebar row show it. */
export interface TaskDetail extends TaskSummary {
  readonly workspace: WorkspaceSummary
  readonly objective: string
  readonly statusUpdatedAt: EpochMs | null
  /** Whether its agent waits on answers to its questions. */
  readonly asking: boolean
  /** Whether its agent waits on your OK for a tool call. */
  readonly awaitingPermission: boolean
  readonly model: string
  readonly effort: Effort
  readonly permissionMode: PermissionMode
  readonly contextUsedTokens: number
  readonly contextWindowTokens: number
  readonly error: TaskDetailError | null
  readonly pause: TaskDetailPause | null
  /** How many messages wait in its queue. */
  readonly queuedMessages: number
  /** How many turns it has had. */
  readonly turns: number
  readonly createdAt: EpochMs
  /** The SDK's id for its agent's session; null before its first turn. */
  readonly sessionId: string | null
  /** Its handoff note (the Backfilled card); null when it has none. */
  readonly handoff: TaskDetailHandoff | null
  /** Its artifacts (the Artifacts tab), in the order they were first declared. */
  readonly artifacts: readonly TaskDetailArtifact[]
  /** The caller's own id it was created with (`create_task`'s `externalId`); null when it has none. */
  readonly externalId: string | null
}

/** A message in the chat. */
export interface ChatMessage {
  readonly role: MessageRole
  /** Cut to `MAX_MESSAGE_LENGTH` characters, with `truncated`. */
  readonly body: string
  readonly createdAt: EpochMs
  readonly truncated: boolean
}

/** A tool call in the tool log, as its row says it in one line. */
export interface ChatToolCall {
  /** The tool's name as the tool log shows it: `set_title` for Glade's own `mcp__glade__set_title`. */
  readonly name: string
  /** The row's one-line argument: the file, command, pattern, … */
  readonly summary: string
  readonly state: ToolCallState
}

/** One turn of a task's chat. */
export interface ChatTurn {
  readonly turn: number
  /** When the turn started: its divider's time. */
  readonly startedAt: EpochMs | null
  readonly messages: readonly ChatMessage[]
  /** Its agent's own tool calls (not its subagents'); left out when the caller asks for no tools. */
  readonly toolCalls?: readonly ChatToolCall[]
}

/** How long a chat message's body may be before `get_chat` cuts it. */
export const MAX_MESSAGE_LENGTH = 20_000

const NO_TASKS: TaskCounts = { active: 0, done: 0 }

export function workspaceSummary(workspace: Workspace, counts: TaskCounts = NO_TASKS): WorkspaceSummary {
  const { id, name, rootPath } = workspace
  return { id, name, rootPath, activeTasks: counts.active, doneTasks: counts.done }
}

export function taskSummary(task: Task): TaskSummary {
  const { id, workspaceId, title, status, state, activity, pinned, unread, updatedAt, doneAt } = task
  return {
    id,
    workspaceId,
    title,
    status,
    state,
    activity,
    needsYou: needsYou(task),
    pinned,
    unread,
    updatedAt,
    doneAt,
  }
}

/** A task in full, in its workspace. */
export function taskDetail(db: Database, task: Task, workspace: WorkspaceSummary): TaskDetail {
  const { error, pause } = task
  return {
    ...taskSummary(task),
    workspace,
    objective: task.objective,
    statusUpdatedAt: task.statusUpdatedAt,
    asking: task.asking,
    awaitingPermission: task.awaitingPermission,
    model: task.model,
    effort: task.effort,
    permissionMode: task.permissionMode,
    contextUsedTokens: task.contextUsedTokens,
    contextWindowTokens: task.contextWindowTokens,
    error: error === null ? null : { kind: error.kind, details: error.details },
    pause: pause === null ? null : { reason: pause.reason, resumesAt: pause.resumesAt },
    queuedMessages: listQueuedMessages(db, task.id).length,
    turns: lastTurn(db, task.id),
    createdAt: task.createdAt,
    sessionId: task.sessionId,
    handoff: handoffOf(db, task.id),
    artifacts: listArtifacts(db, task.id).map(({ path, title, addedAt }) => ({
      path: join(workspace.rootPath, path),
      title,
      addedAt,
    })),
    externalId: getExternalId(db, task.id),
  }
}

function handoffOf(db: Database, taskId: string): TaskDetailHandoff | null {
  const handoff = getHandoff(db, taskId)
  return handoff === undefined ? null : { body: handoff.body, addedAt: handoff.addedAt }
}

function chatMessage(message: Message): ChatMessage {
  const truncated = message.body.length > MAX_MESSAGE_LENGTH
  return {
    role: message.role,
    body: truncated ? message.body.slice(0, MAX_MESSAGE_LENGTH) : message.body,
    createdAt: message.createdAt,
    truncated,
  }
}

function chatToolCall(call: ToolCallEvent, rootPath: string): ChatToolCall {
  return { name: toolDisplayName(call.name), summary: argumentSummary(call, rootPath), state: call.state }
}

/** What a page of chat turns is made from. */
export interface ChatSource {
  readonly db: Database
  readonly taskId: string
  /** The workspace's root, which the tool calls' paths are shown relative to. */
  readonly rootPath: string
  readonly messages: readonly Message[]
  readonly toolEvents: readonly ToolEvent[]
}

/** Turns `from` to `to` of a task's chat, each with its tool calls when `includeTools`. */
export function chatTurns(source: ChatSource, from: number, to: number, includeTools: boolean): ChatTurn[] {
  const { db, taskId, rootPath, messages, toolEvents } = source
  const turns: ChatTurn[] = []
  for (let turn = from; turn <= to; turn += 1) {
    const chat = messages.filter((message) => message.turn === turn).map(chatMessage)
    const base = { turn, startedAt: turnStartedAt(db, taskId, turn), messages: chat }
    if (!includeTools) {
      turns.push(base)
      continue
    }
    const toolCalls = toolEvents
      .filter(
        (event): event is ToolCallEvent =>
          event.kind === ToolEventKind.ToolCall && event.turn === turn && event.parentToolUseId === null,
      )
      .map((call) => chatToolCall(call, rootPath))
    turns.push({ ...base, toolCalls })
  }
  return turns
}
