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
  /**
   * The agent's turn is paused because the account hit its usage limit or the API can't be reached. The task's `pause`
   * says why and when it resumes; it resumes on its own, with no one needing to step in.
   */
  Paused = 'paused',
}

/**
 * What kind of error stopped a task's agent (`src/main/agent/error-classification.ts`). Claude Code itself retries the
 * transient ones before giving up (`docs/sdk-notes.md`, "Errors and retries").
 */
export enum AgentErrorKind {
  /** Worth another try later: the API is overloaded or had a server error, or it rate limited the request. */
  Transient = 'transient',
  /** Won't go away by trying again as is: e.g. a model that doesn't exist, or a failed sign-in. */
  Permanent = 'permanent',
  /** The account's usage limit or credits ran out. */
  UsageLimit = 'usage_limit',
  /** The API couldn't be reached at all. */
  Offline = 'offline',
}

/** Where the error that stopped a task's agent came from. */
export enum TaskErrorSource {
  /** An API request failed, after any retries: the turn ended with an API error. */
  Api = 'api',
  /** The turn ended with an error that wasn't the API's, e.g. it ran out of turns. */
  Turn = 'turn',
  /** The agent's process failed, or its session ended, mid-turn. */
  Session = 'session',
}

/** What stopped a task's agent, for the chat's error card and the task list's status line. */
export interface TaskError {
  readonly kind: AgentErrorKind
  readonly source: TaskErrorSource
  /** The API's HTTP status, e.g. 529; null when there was none (a connection error, or not the API's). */
  readonly status: number | null
  /** The SDK's name for the error, e.g. `overloaded` or `model_not_found`; null when it gave none. */
  readonly code: string | null
  /** The raw error, as the SDK or the agent process gave it: what "Show details" shows. */
  readonly details: string
  /** How many times the request was retried automatically before giving up. */
  readonly retries: number
  /** How long those retries took, from the first failure to giving up. 0 without retries. */
  readonly retryingMs: number
}

/** Why a task's turn is paused (`TaskPause`). */
export enum PauseReason {
  /** The account's usage limit ran out: the turn resumes when it resets. */
  UsageLimit = 'usage_limit',
  /** The API couldn't be reached: the turn resumes when the network is back. */
  Offline = 'offline',
}

/**
 * A paused turn (`TaskActivity.Paused`): the app-wide banner, the task list's "Paused: usage limit · resumes 11:42" and
 * the chat's paused line. Persisted, so a relaunch keeps the pause and its timer.
 */
export interface TaskPause {
  readonly reason: PauseReason
  /** When the task paused. */
  readonly since: EpochMs
  /**
   * When Glade next tries the turn again: the usage limit's reset time (or Glade's guess, when the API gave none), or,
   * offline, when it next checks whether the network is back.
   */
  readonly resumesAt: EpochMs
  /** How many times in a row Glade has found the network still down; 0 for a usage limit. Spaces out the checks. */
  readonly checks: number
  /** The raw error that paused the turn, as the SDK gave it: what the banner's Details shows. */
  readonly details: string
}

/** An automatic retry of a failed API request in progress: the working line says "Retrying (2 of 10)…". */
export interface ApiRetry {
  /** Which retry this is, from 1. */
  readonly attempt: number
  /** How many retries there will be at most. */
  readonly maxRetries: number
  /** When the first request of the run of retries failed. */
  readonly since: EpochMs
}

/** How hard the model thinks, set per task from the input bar's effort picker. */
export enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Max = 'max',
}

/** What a task is called until its agent sets a title: in the task list, the header and its notifications. */
export const UNTITLED_TASK_TITLE = 'New task'

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
  /** What stopped the agent, while its activity is error; null otherwise. */
  readonly error: TaskError | null
  /** The automatic retry in progress while the agent's API requests fail; null otherwise. */
  readonly retrying: ApiRetry | null
  /** Why the agent's turn is paused and when it resumes, while its activity is paused; null otherwise. */
  readonly pause: TaskPause | null
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
  /** How long the turn ran, wall-clock, from its first user message to its reply; null when that's unknown. */
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

/**
 * A message the user sent while the agent was working, waiting in the task's queue to be delivered after the agent's
 * current step (`docs/decisions.md`). It can be edited or removed until then; once delivered it leaves the queue and
 * becomes a user message in the chat log.
 */
export interface QueuedMessage {
  readonly id: string
  readonly taskId: string
  /** Markdown. */
  readonly body: string
  readonly createdAt: EpochMs
}

/** The variants of a tool log entry. */
export enum ToolEventKind {
  /** The agent's working notes between tool calls ("preamble"). */
  Narration = 'narration',
  ToolCall = 'tool_call',
  Divider = 'divider',
  /** The session's context was compacted: its older turns replaced with a summary for the agent. */
  Compaction = 'compaction',
}

export enum ToolCallState {
  Running = 'running',
  Done = 'done',
  Error = 'error',
  /**
   * Cut off by a pause (a usage limit, or offline) while the task is still paused: its turn picks up again when the
   * task resumes (`docs/design/html/17-usage-limit.html`). It becomes `Interrupted` once the task works again.
   */
  Paused = 'paused',
  /** Cut off by Glade quitting, or by a pause the task has since resumed from: not a failure (`18-relaunch.html`). */
  Interrupted = 'interrupted',
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

/**
 * The name of the failed tool call row the tool log shows for an API error that stopped the agent: "API · request 3 of
 * 3 · 529 overloaded · task paused" (`docs/design/html/16-error.html`). It isn't a real tool: the runner adds it.
 */
export const API_TOOL_NAME = 'API'

/** What started a compaction: you (Compact now, ⌘⇧K), or the SDK at its auto-compact threshold. */
export enum CompactionTrigger {
  Manual = 'manual',
  Auto = 'auto',
}

/**
 * A compaction of the session's context (`docs/sdk-notes.md` §5): the tool log's Compact row and the chat's
 * "Compacted · 198k → 41k" divider. A manual one is logged as running when it's asked for and filled in when the SDK
 * reports it done; one that never reports ends as an error.
 */
export interface CompactionEvent extends ToolEventBase {
  readonly kind: ToolEventKind.Compaction
  readonly trigger: CompactionTrigger
  readonly state: ToolCallState
  /** The context before, in tokens, as the SDK reports it; null until it does. */
  readonly preTokens: number | null
  /** The context after, in tokens, as the SDK reports it; null until it does, or when it doesn't. */
  readonly postTokens: number | null
  /** The task's context window when it compacted, so the chat can say how full it was. */
  readonly windowTokens: number
}

/**
 * One tool log entry. Append-only, except that a tool call's state and output are filled in when its result arrives,
 * and a compaction's state and token counts when it finishes.
 */
export type ToolEvent = NarrationEvent | ToolCallEvent | DividerEvent | CompactionEvent

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
  /**
   * The relaunch notice after Glade quit unexpectedly, until you dismiss it: a `RelaunchNotice` (`./relaunchNotice`) as
   * JSON. Unset or empty means no notice.
   */
  RelaunchNotice = 'relaunch_notice',
}

export interface UiStateEntry {
  readonly key: UiStateKey
  readonly value: string
}
