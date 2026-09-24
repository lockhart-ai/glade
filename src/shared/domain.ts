/**
 * The core data model, shared by the main process and the renderer.
 *
 * - **Time** is always epoch milliseconds (UTC), as `Date.now()` returns, never an ISO string.
 * - **Ids** are UUIDs from `crypto.randomUUID()`.
 * - **Turns** count a task's user turns from 1: the task's first message starts turn 1, and every message the agent is
 *   given after that starts the next one. Chat messages and tool events carry the turn they belong to.
 */

/** Epoch milliseconds (UTC). */
export type EpochMs = number

/** A named root folder. Every task's agent runs in its workspace's root. */
export interface Workspace {
  readonly id: string
  readonly name: string
  readonly rootPath: string
  readonly createdAt: EpochMs
  readonly lastOpenedAt: EpochMs
}

/** A task has exactly two states. Whether an active task's agent is working, waiting or errored is not a state. */
export enum TaskState {
  Active = 'active',
  Done = 'done',
}

/**
 * What an active task's agent is doing, persisted so the task list and header can show it and a relaunch can resume
 * from it. Not a state: a task is still only active or done.
 */
export enum TaskActivity {
  /** The agent isn't running a turn: it's waiting on you. A new task starts here. */
  Waiting = 'waiting',
  /** The agent is running a turn. */
  Working = 'working',
  /** The agent's last turn failed. */
  Error = 'error',
}

/** How hard the model thinks, set per task from the input bar's effort picker. */
export enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Max = 'max',
}

/**
 * One agent session with one objective. There is no separate outcome: when the task is done, its `status` is the
 * outcome.
 */
export interface Task {
  readonly id: string
  readonly workspaceId: string
  /** Set by the agent from the first message (`set_title`); empty until then. */
  readonly title: string
  /** Set once by the agent from the first message (`set_objective`); empty until then. */
  readonly objective: string
  /** The agent's status summary (`set_status`); empty until it first sets one. */
  readonly status: string
  /** When the status last changed; null until the agent first sets one. */
  readonly statusUpdatedAt: EpochMs | null
  readonly state: TaskState
  /** What the agent is doing. Set by the agent runner. */
  readonly activity: TaskActivity
  readonly pinned: boolean
  readonly unread: boolean
  /** The model id the task's session runs on, as the SDK names it. */
  readonly model: string
  readonly effort: Effort
  readonly createdAt: EpochMs
  readonly updatedAt: EpochMs
  /** When the task was marked done; null while it's active. */
  readonly doneAt: EpochMs | null
  /** The Claude Agent SDK session id, stored from the session's first `system/init`; null until then. */
  readonly sessionId: string | null
  /**
   * How much of the context window the session's prompt fills, in tokens: the input tokens of the agent's latest
   * top-level message (`docs/sdk-notes.md`, "Usage and context size"). 0 until the agent first answers.
   */
  readonly contextUsedTokens: number
  /**
   * The model's context window, in tokens: what the SDK last reported for the task's model, or else what
   * `contextWindowFor` (`./contextWindow`) gives for it.
   */
  readonly contextWindowTokens: number
}

/** Who wrote a chat message. */
export enum MessageRole {
  User = 'user',
  Agent = 'agent',
}

/**
 * What a finished turn did, shown under its final reply: "Finished in 24m 10s · 4 files +61 −3". The file and line
 * counts come from the turn's file-editing tool calls (`src/main/agent/turn-summary.ts`).
 */
export interface TurnSummary {
  /** How long the turn ran, as the SDK's `result` reports it; null when it doesn't. */
  readonly durationMs: number | null
  /** The distinct files the turn's edits changed. */
  readonly filesChanged: number
  readonly linesAdded: number
  readonly linesRemoved: number
}

/** One chat log entry: a user message, or the agent's final reply for a turn. Append-only. */
export interface Message {
  readonly id: string
  readonly taskId: string
  readonly role: MessageRole
  /** Markdown. */
  readonly body: string
  readonly turn: number
  readonly createdAt: EpochMs
  /** The agent's final reply's turn summary; null for your messages, and for replies saved before summaries were. */
  readonly summary: TurnSummary | null
}

/** The variants of a tool log entry. */
export enum ToolEventKind {
  /** The agent's working notes between tool calls ("preamble"). */
  Narration = 'narration',
  ToolCall = 'tool_call',
  Divider = 'divider',
}

export enum ToolCallState {
  Running = 'running',
  Done = 'done',
  Error = 'error',
}

/** What a divider in the tool log marks. */
export enum DividerKind {
  /** The start of a turn ("turn 2 · 11:20"). */
  Turn = 'turn',
  MarkedDone = 'marked_done',
  Reopened = 'reopened',
  /** The task's session was resumed, e.g. after the app restarted. */
  Resumed = 'resumed',
}

/** The fields every tool log entry has. */
export interface ToolEventBase {
  readonly id: string
  readonly taskId: string
  readonly turn: number
  readonly createdAt: EpochMs
}

/** A tool's input: always a JSON object. */
export type ToolInput = Readonly<Record<string, unknown>>

export interface NarrationEvent extends ToolEventBase {
  readonly kind: ToolEventKind.Narration
  readonly text: string
}

export interface ToolCallEvent extends ToolEventBase {
  readonly kind: ToolEventKind.ToolCall
  /** The tool's name as the SDK reports it (MCP tools arrive as `mcp__<server>__<tool>`); see `toolDisplayName`. */
  readonly name: string
  readonly input: ToolInput
  /** The result's text; null until the result arrives. */
  readonly output: string | null
  readonly state: ToolCallState
  /** The SDK's `tool_use` id, which pairs the call with its result. */
  readonly toolUseId: string
  /** The `Agent` tool call's `tool_use` id when the call was made inside a subagent; null at the top level. */
  readonly parentToolUseId: string | null
}

export interface DividerEvent extends ToolEventBase {
  readonly kind: ToolEventKind.Divider
  readonly dividerKind: DividerKind
}

/** One tool log entry. Append-only, except that a tool call's state and output are filled in when its result arrives. */
export type ToolEvent = NarrationEvent | ToolCallEvent | DividerEvent

/** The keys of the app's persisted UI state. Each value is a string. */
export enum UiStateKey {
  /** The id of the workspace the window shows. */
  ActiveWorkspaceId = 'active_workspace_id',
  /** The id of the selected task. An empty string means no task is selected. */
  SelectedTaskId = 'selected_task_id',
  /** Whether the task list's Pinned section is collapsed: `'true'` or `'false'`. Unset means expanded. */
  PinnedSectionCollapsed = 'pinned_section_collapsed',
  /** Whether the task list's Active section is collapsed: `'true'` or `'false'`. Unset means expanded. */
  ActiveSectionCollapsed = 'active_section_collapsed',
  /** Whether the task list's Done section is collapsed: `'true'` or `'false'`. Unset means collapsed. */
  DoneSectionCollapsed = 'done_section_collapsed',
  /** The task list's filter chip: a `TaskFilter` (`./attention`). Unset means All. */
  TaskFilter = 'task_filter',
}

export interface UiStateEntry {
  readonly key: UiStateKey
  readonly value: string
}
