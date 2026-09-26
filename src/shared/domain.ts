/**
 * The core data model, shared by the main process and the renderer.
 *
 * - **Time** is always epoch milliseconds (UTC), as `Date.now()` returns, never an ISO string.
 * - **Ids** are UUIDs from `crypto.randomUUID()`.
 * - **Turns** count a task's user turns from 1: the task's first message starts turn 1, and every message the agent is
 *   given after that starts the next one. Chat messages and tool events carry the turn they belong to.
 */
import type { ImageData, ImageRef } from './images'

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
  /**
   * Claude Code couldn't start the session, for a reason it named (`startup_failure_reason`): the error's `code` is that
   * reason, e.g. `cwd_unavailable` (`./startupFailure`).
   */
  Startup = 'startup',
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

/**
 * How hard the model thinks, set per task from the input bar's effort picker, lowest first: the levels the SDK knows
 * (`EffortLevel`). Each model supports its own (`ModelChoice.efforts` in `./models`), and some none.
 */
export enum Effort {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  XHigh = 'xhigh',
  Max = 'max',
}

/**
 * What a task's agent may do without asking you, set per task from the input bar's permissions picker
 * (`docs/decisions.md`, "Per-call permission review").
 */
export enum PermissionMode {
  /** Every tool call runs without asking. The default. */
  AllowAll = 'allow_all',
  /**
   * Edits, writes, commands and any tool Glade doesn't know to be read-only wait for your OK on a permission request;
   * reads, searches and Glade's own tools don't.
   */
  AskBeforeEdits = 'ask_before_edits',
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
  /** What the agent may do without asking you. */
  readonly permissionMode: PermissionMode
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
  /**
   * Whether the agent is waiting on your answers to questions it asked (`ask`): the task has an open question set.
   * Derived from the question sets, so it's always right, across restarts too.
   */
  readonly asking: boolean
  /**
   * Whether a tool call of the agent's waits on your OK: the task has an open permission request. Derived from the
   * permission requests, so it's always right, across restarts too.
   */
  readonly awaitingPermission: boolean
  /** Why the agent's turn is paused and when it resumes, while its activity is paused; null otherwise. */
  readonly pause: TaskPause | null
  /** When the task was imported from a Claude Code session; null for a task made in Glade. */
  readonly importedAt: EpochMs | null
  /**
   * Its todo list in brief, for its row in the task list; null while the agent keeps no list (or an empty one). Main
   * keeps it in step with the todo list the tool log leaves, which the Todos tab shows (see `src/main/todos`).
   */
  readonly todos: TodoSummary | null
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
  /** The images pasted into your message, in the order they were attached; none for the agent's replies. */
  readonly images: readonly ImageRef[]
}

/**
 * A message the user sent while the agent was working, waiting in the task's queue to be delivered after the agent's
 * current step (`docs/decisions.md`). It can be edited or removed until then; once delivered it leaves the queue and
 * becomes a user message in the chat log.
 */
export interface QueuedMessage {
  readonly id: string
  readonly taskId: string
  /** Markdown. Empty for a message that's only images. */
  readonly body: string
  readonly createdAt: EpochMs
  /** The images pasted into it, which go with it. */
  readonly images: readonly ImageRef[]
}

/**
 * What's in a task's input bar and not sent yet: its message field's text and the images pasted into it, in order. It's
 * kept for the task, as you switch tasks and across a relaunch or a crash, until it's sent or emptied.
 */
export interface InputDraft {
  readonly text: string
  readonly images: readonly ImageData[]
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
   * task resumes (`docs/design/html/17-usage-limit.html`). It becomes `Interrupted` once the task works again or is
   * marked done.
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
  /** The `Agent` tool call's `tool_use` id when a subagent wrote it; null for the agent's own notes. */
  readonly parentToolUseId: string | null
}

export interface ToolCallEvent extends ToolEventBase {
  readonly kind: ToolEventKind.ToolCall
  /** The tool's name as the SDK reports it (MCP tools arrive as `mcp__<server>__<tool>`); see `toolDisplayName`. */
  readonly name: string
  readonly input: ToolInput
  /** The result's text; null until the result arrives. */
  readonly output: string | null
  readonly state: ToolCallState
  /** When its result arrived; null while it runs, and for calls logged before Glade recorded it. */
  readonly finishedAt: EpochMs | null
  /** The SDK's `tool_use` id, which pairs the call with its result. */
  readonly toolUseId: string
  /** The `Agent` tool call's `tool_use` id when the call was made inside a subagent; null at the top level. */
  readonly parentToolUseId: string | null
  /**
   * For an `Agent` call whose subagent is running: the latest one-line summary of what it's doing now, as the SDK sends
   * it (`task_progress.summary`, `docs/sdk-notes.md`, "Subagents"). Null before the first, and once the call finishes.
   */
  readonly progressSummary: string | null
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

/** Where an item on the agent's todo list stands (`docs/design/html/09-todos.html`). */
export enum TodoState {
  Todo = 'todo',
  /** Being worked on now. */
  Doing = 'doing',
  Done = 'done',
  /**
   * Waiting on you. Claude Code's own todo tools have no such state, so nothing sets it yet; the Todos tab shows it for
   * when something does.
   */
  Waiting = 'waiting',
}

/** One item on the agent's todo list. */
export interface Todo {
  readonly text: string
  readonly state: TodoState
  /** The line under a doing or waiting item, e.g. what the agent is doing on it now; null for none. */
  readonly note: string | null
  /**
   * When a done item was finished: the time of the tool call that marked it done (#282). Null for an item that isn't
   * done, including one that was done and went back to being worked on.
   */
  readonly completedAt: EpochMs | null
}

/**
 * A task's todo list, as the agent keeps it with Claude Code's own todo tools (see `src/main/todos`). It isn't stored
 * on its own: main works it out from the task's tool log, which is.
 */
export interface TodoList {
  /** In the agent's order (the Todos tab groups them by state: `orderTodos` in `src/renderer/todos`). */
  readonly items: readonly Todo[]
  /** When the agent last changed it: the time of its latest todo tool call. */
  readonly updatedAt: EpochMs
}

/** A todo list in brief: how far through it the agent is (the task row's `3/7`), and what it's working on now. */
export interface TodoSummary {
  readonly done: number
  /** Every item, done or not; never 0 (an empty list has no summary). */
  readonly total: number
  /** The text of each item being worked on now, in the list's order. */
  readonly doing: readonly string[]
}

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
  /** The right panel's selected tab: a `PanelTab` (`src/renderer/right-panel`). Unset means Tool calls. */
  RightPanelTab = 'right_panel_tab',
  /** The right panel's width in CSS pixels, as you last dragged it. Unset means the design's default. */
  RightPanelWidth = 'right_panel_width',
  /** Whether the right panel is collapsed: `'true'` or `'false'`. Unset means open. */
  RightPanelCollapsed = 'right_panel_collapsed',
  /** Whether the sidebar (the task list) is collapsed: `'true'` or `'false'`. Unset means open. */
  SidebarCollapsed = 'sidebar_collapsed',
  /** The sidebar's width in CSS pixels, as you last dragged it. Unset means the design's default. */
  SidebarWidth = 'sidebar_width',
  /** Whether the bottom bar is collapsed to its tab row: `'true'` or `'false'`. Unset means open. */
  BottomBarCollapsed = 'bottom_bar_collapsed',
  /** The bottom bar's height in CSS pixels while it's open, as you last dragged it. Unset means the design's default. */
  BottomBarHeight = 'bottom_bar_height',
  /** The plugin card's width beside the terminal in CSS pixels, as you last dragged it. Unset means the design's default. */
  PluginWidth = 'plugin_width',
  /** The id of the terminal tab the bottom bar shows. Unset, or a tab that's gone, means the first tab. */
  TerminalTab = 'terminal_tab',
}

export interface UiStateEntry {
  readonly key: UiStateKey
  readonly value: string
}

/** The kinds of question the agent can ask (`ask`, `docs/model-surface.md`). */
export enum QuestionKind {
  /** Option cards, each with a label and optionally a detail line and a sketch. */
  Choice = 'choice',
  /** Short options shown as pills. */
  Pills = 'pills',
  /** A text box. */
  Text = 'text',
}

/** One option card of a choice question. */
export interface ChoiceOption {
  /** What the answer names the option by. Unique within its question. */
  readonly id: string
  readonly label: string
  /** A line under the label. */
  readonly detail?: string
  /**
   * A small sketch of what the option would look like: a few short lines of plain text, shown as is in a small
   * monospace frame, with lines starting with `#` as headings (`docs/model-surface.md`).
   */
  readonly sketch?: string
}

export interface ChoiceQuestion {
  readonly kind: QuestionKind.Choice
  readonly prompt: string
  readonly options: readonly ChoiceOption[]
  /** Whether you can pick more than one. */
  readonly multiple?: boolean
}

export interface PillsQuestion {
  readonly kind: QuestionKind.Pills
  readonly prompt: string
  /** Each pill's text, which is also what the answer gives back. Unique within its question. */
  readonly options: readonly string[]
  /** Whether you can pick more than one. */
  readonly multiple?: boolean
}

export interface TextQuestion {
  readonly kind: QuestionKind.Text
  readonly prompt: string
  readonly placeholder?: string
  /** Whether it can be left empty. */
  readonly optional?: boolean
}

/** One question the agent asks. */
export type Question = ChoiceQuestion | PillsQuestion | TextQuestion

/**
 * One question's answer: a choice's option id, a pill's text or the text typed; an array of option ids or pill texts
 * when the question takes more than one.
 */
export type QuestionAnswer = string | readonly string[]

/**
 * The answers to a question set, keyed by each question's index in it, from 0 (`"0"`, `"1"`, …). An optional text
 * question left empty has no key.
 */
export type QuestionAnswers = Readonly<Record<string, QuestionAnswer>>

/** Where a question set is in its life. */
export enum QuestionSetState {
  /** Waiting on your answers. */
  Open = 'open',
  /** You answered it: with the card, or in words. */
  Answered = 'answered',
  /** The turn that asked it ended without an answer: it was stopped, or failed. */
  Withdrawn = 'withdrawn',
}

/** How you answered a question set. */
export enum QuestionReplyKind {
  /** With the card: an answer for each question. */
  Answers = 'answers',
  /** In your own words: a chat message sent while it was open. */
  FreeText = 'free_text',
}

export interface AnswersReply {
  readonly kind: QuestionReplyKind.Answers
  readonly answers: QuestionAnswers
}

export interface FreeTextReply {
  readonly kind: QuestionReplyKind.FreeText
  readonly text: string
}

export type QuestionReply = AnswersReply | FreeTextReply

/**
 * The questions one `ask` call asked, shown as one card in the chat. It stays open until you answer it, and the agent's
 * turn waits on it until then.
 */
export interface QuestionSet {
  readonly id: string
  readonly taskId: string
  /** The turn that asked it. */
  readonly turn: number
  /** At least one. */
  readonly questions: readonly Question[]
  readonly state: QuestionSetState
  /** How you answered it; null while it's open, and for a withdrawn set. */
  readonly reply: QuestionReply | null
  readonly createdAt: EpochMs
  /** When it was answered or withdrawn; null while it's open. */
  readonly closedAt: EpochMs | null
}

/** Where a permission rule the SDK suggests would be saved (the SDK's `PermissionUpdateDestination`). */
export enum PermissionDestination {
  UserSettings = 'userSettings',
  ProjectSettings = 'projectSettings',
  LocalSettings = 'localSettings',
  /** Only for as long as the agent's process runs. */
  Session = 'session',
  CliArg = 'cliArg',
}

/** What a permission rule does to the calls it matches (the SDK's `PermissionBehavior`). */
export enum PermissionRuleBehavior {
  Allow = 'allow',
  Deny = 'deny',
  Ask = 'ask',
}

/** A permission rule: a tool, and optionally what of it, e.g. `Bash` with `npm test:*` (the SDK's `PermissionRuleValue`). */
export interface PermissionRule {
  readonly toolName: string
  readonly ruleContent?: string
}

/** The kinds of change to the permissions the SDK can suggest (the SDK's `PermissionUpdate['type']`). */
export enum PermissionUpdateType {
  AddRules = 'addRules',
  ReplaceRules = 'replaceRules',
  RemoveRules = 'removeRules',
  SetMode = 'setMode',
  AddDirectories = 'addDirectories',
  RemoveDirectories = 'removeDirectories',
}

export interface PermissionRulesUpdate {
  readonly type: PermissionUpdateType.AddRules | PermissionUpdateType.ReplaceRules | PermissionUpdateType.RemoveRules
  readonly rules: readonly PermissionRule[]
  readonly behavior: PermissionRuleBehavior
  readonly destination: PermissionDestination
}

export interface PermissionModeUpdate {
  readonly type: PermissionUpdateType.SetMode
  /** The SDK's permission mode, e.g. `acceptEdits`. */
  readonly mode: string
  readonly destination: PermissionDestination
}

export interface PermissionDirectoriesUpdate {
  readonly type: PermissionUpdateType.AddDirectories | PermissionUpdateType.RemoveDirectories
  readonly directories: readonly string[]
  readonly destination: PermissionDestination
}

/**
 * A change to the permissions the SDK suggests with a request, so the same call wouldn't ask again (its
 * `PermissionUpdate`), e.g. adding the rule `Bash(npm test)` (`docs/sdk-notes.md` §9).
 */
export type PermissionSuggestion = PermissionRulesUpdate | PermissionModeUpdate | PermissionDirectoriesUpdate

/** Where a permission request is in its life. */
export enum PermissionRequestState {
  /** Waiting on your answer. */
  Open = 'open',
  /** You allowed the call. */
  Allowed = 'allowed',
  /** You denied the call. */
  Denied = 'denied',
  /** Closed without an answer: the turn was stopped, failed or ended, or the SDK cancelled the call. */
  Withdrawn = 'withdrawn',
}

/**
 * One tool call of the agent's that waits on your OK in the ask mode (`PermissionMode.AskBeforeEdits`), shown as a
 * permission card in the chat. It stays open until you answer it or it's withdrawn.
 */
export interface PermissionRequest {
  readonly id: string
  readonly taskId: string
  /** The turn the call was made in. */
  readonly turn: number
  /** The call's `tool_use` id, which its tool log row has too. */
  readonly toolUseId: string
  /** The SDK's id for the subagent that made the call (its `agentID`); null for the agent's own calls. */
  readonly agentId: string | null
  /** The tool's name as the SDK reports it (MCP tools arrive as `mcp__<server>__<tool>`). */
  readonly toolName: string
  readonly input: ToolInput
  /** The prompt sentence Claude Code wrote for it, e.g. "Claude wants to edit a.txt"; null when it wrote none. */
  readonly title: string | null
  /** Claude Code's short name for the action, e.g. "Bash"; null when it gave none. */
  readonly displayName: string | null
  /** Claude Code's subtitle for it, e.g. the command's description or the file's name; null when it gave none. */
  readonly description: string | null
  /** What the SDK suggests would stop the same call asking again; none when it suggests nothing. */
  readonly suggestions: readonly PermissionSuggestion[]
  /** Whether the card must open on Deny, so a stray key can't approve the call. */
  readonly defaultToNo: boolean
  /** Whether the card mustn't offer to remember the answer: the rule would grant more than this call. */
  readonly suppressAlwaysAllowRule: boolean
  readonly state: PermissionRequestState
  /** The note you denied it with; null when you gave none, and while it isn't denied. */
  readonly denyNote: string | null
  /** The rule you allowed it with for the rest of the task (Allow for this task); null when you didn't. */
  readonly grantedRule: PermissionRule | null
  readonly createdAt: EpochMs
  /** When it was answered or withdrawn; null while it's open. */
  readonly closedAt: EpochMs | null
}

/** How you answer a permission request. */
export enum PermissionDecisionKind {
  /** Run this call, and ask again next time. */
  AllowOnce = 'allow_once',
  /**
   * Run this call, and don't ask again in this task about the calls its rule covers (`taskPermissionRule` in
   * `./permissions`): the tool, or a `Bash` command prefix.
   */
  AllowForTask = 'allow_for_task',
  /** Don't run it: the agent is told, with your note if you gave one, and carries on. */
  Deny = 'deny',
}

export interface AllowOnceDecision {
  readonly kind: PermissionDecisionKind.AllowOnce
}

export interface AllowForTaskDecision {
  readonly kind: PermissionDecisionKind.AllowForTask
}

export interface DenyDecision {
  readonly kind: PermissionDecisionKind.Deny
  /** Goes back to the agent with the denial. */
  readonly note?: string
}

export type PermissionDecision = AllowOnceDecision | AllowForTaskDecision | DenyDecision

/**
 * A permission rule granted with Allow for this task: it lets the task's agent make the calls it covers without asking,
 * for the rest of the task, across relaunches (`docs/decisions.md`, "Per-call permission review").
 */
export interface TaskPermissionRule {
  readonly taskId: string
  readonly rule: PermissionRule
  readonly createdAt: EpochMs
}

/**
 * The files open in a task's Files tab, as tabs in the order they were opened, and the one showing. Each path is
 * relative to the task's workspace root, with `/` between its parts (`src/date.ts`).
 */
export interface OpenFiles {
  readonly taskId: string
  readonly paths: readonly string[]
  /** The tab showing: one of `paths`, or null when no file is open. */
  readonly activePath: string | null
}

/** What reading a file for the viewer found. */
export enum FileContentKind {
  /** Text, shown as source. */
  Text = 'text',
  /** Not text (it has a NUL byte): the viewer says so instead of showing it. */
  Binary = 'binary',
  /** There's no file at that path (any more), e.g. the agent deleted it. */
  Missing = 'missing',
}

export interface TextFileContent {
  readonly kind: FileContentKind.Text
  /** The file's text, or only its first lines when `truncated`. */
  readonly text: string
  /** Whether the file is too large to show whole. */
  readonly truncated: boolean
  /** The whole file's size, in bytes. */
  readonly size: number
}

export interface BinaryFileContent {
  readonly kind: FileContentKind.Binary
  /** The file's size, in bytes. */
  readonly size: number
}

export interface MissingFileContent {
  readonly kind: FileContentKind.Missing
}

/** A file as the viewer shows it (`files.read`). */
export type FileContent = TextFileContent | BinaryFileContent | MissingFileContent

/**
 * A deliverable of a task: a file in its workspace the agent declared with `add_artifact`, shown in the Artifacts tab.
 * It stays with the task, done or not.
 */
export interface Artifact {
  readonly taskId: string
  /** Relative to the task's workspace root, with `/` between its parts (`docs/releases/2.4.md`). */
  readonly path: string
  /** What the agent called it (`Release notes 2.4`); declaring the same path again renames it. */
  readonly title: string
  /** When the agent first declared it. The tab lists artifacts in this order. */
  readonly addedAt: EpochMs
  /** When the agent last declared it. */
  readonly updatedAt: EpochMs
}

/**
 * What a watcher is: one of the SDK's own ways the agent leaves something running or scheduled that wakes it later
 * (`docs/sdk-notes.md` §13). Glade builds none of them; it only follows the ones the agent starts.
 */
export enum WatcherKind {
  /** A `Monitor` watch: a command whose output lines each wake the agent, until it exits or times out. */
  Monitor = 'monitor',
  /** A command running in the background (`Bash` with `run_in_background`): it wakes the agent when it ends. */
  Command = 'command',
  /** A `ScheduleWakeup`: it wakes the agent once, at its time. */
  Wakeup = 'wakeup',
  /** A `CronCreate` job: it wakes the agent at each time its schedule matches, or once. */
  Cron = 'cron',
}

/** Where a watcher stands. */
export enum WatcherState {
  /** A monitor or command whose process is running. */
  Running = 'running',
  /** A wakeup or cron job waiting for its time. */
  Scheduled = 'scheduled',
  /**
   * A cron job whose session isn't running, after a relaunch: the SDK brings it back when the task's session resumes
   * (`docs/sdk-notes.md` §11), and it's scheduled again.
   */
  Suspended = 'suspended',
  /** It ran its course: a command or monitor that exited, a wakeup or one-off job that fired. */
  Finished = 'finished',
  /** Its command exited with an error. */
  Failed = 'failed',
  /** You or the agent stopped it, it timed out, or it died with its session (a relaunch). */
  Stopped = 'stopped',
}

/** The states a watcher is live in: it can still wake the agent, and Stop applies. */
export const LIVE_WATCHER_STATES: readonly WatcherState[] = [
  WatcherState.Running,
  WatcherState.Scheduled,
  WatcherState.Suspended,
]

/**
 * Something the task's agent left running or scheduled with the SDK's own tools, as the Watchers tab lists it: a
 * `Monitor` watch, a background command, a `ScheduleWakeup` or a `CronCreate` job. Glade follows it from the call
 * that started it to its end, counting each time it wakes the agent.
 */
export interface Watcher {
  readonly id: string
  readonly taskId: string
  readonly kind: WatcherKind
  /** The tool call that started it. */
  readonly toolUseId: string
  /** What the agent called it: the call's description, a wakeup's reason, or a cron job's prompt. */
  readonly label: string
  /** What it runs: the command, or the prompt it wakes the agent with. */
  readonly detail: string
  /** A cron job's schedule, in words where the SDK gives them (`Every minute`); null for the other kinds. */
  readonly schedule: string | null
  /** Whether it can wake the agent more than once: a monitor, or a recurring cron job. */
  readonly recurring: boolean
  readonly state: WatcherState
  /** How many times it has woken the agent. */
  readonly wakes: number
  /** When it last woke the agent; null until it has. */
  readonly lastWokeAt: EpochMs | null
  /** The last thing it reported: a monitor's last event line. Null until there's one. */
  readonly lastOutput: string | null
  /** When it's next due: a wakeup's time, a cron job's next match. Null for the others, and once it has ended. */
  readonly nextDueAt: EpochMs | null
  /** When a monitor times out; null for the other kinds, and a monitor with no timeout. */
  readonly expiresAt: EpochMs | null
  /** How it ended: what the SDK said, or who stopped it. Null while it's live. */
  readonly outcome: string | null
  readonly startedAt: EpochMs
  /** When it ended; null while it's live. */
  readonly endedAt: EpochMs | null
}

/** How long a task's handoff note may be: 32 KB of UTF-8. */
export const MAX_HANDOFF_BYTES = 32 * 1024

/**
 * A task's handoff note (`docs/control-api.md`, "Backfilling past tasks"): Markdown saying what the task was, where it
 * got to, what was decided, what's next and where its notes live, set through the control API when a past task is
 * backfilled. Its agent always has it in its system prompt, and the chat shows it on the Backfilled card. The window
 * never changes it.
 */
export interface TaskHandoff {
  readonly taskId: string
  /** Markdown, at most `MAX_HANDOFF_BYTES` of UTF-8. */
  readonly body: string
  /** When it was last set. */
  readonly addedAt: EpochMs
}

/** What looking at an artifact's file found. */
export enum FileInfoKind {
  /** A text file: its lines are counted. */
  Text = 'text',
  /** Not text (it has a NUL byte), or too large to count its lines cheaply. */
  Other = 'other',
  /** There's no file at that path (any more). */
  Missing = 'missing',
}

export interface TextFileInfo {
  readonly kind: FileInfoKind.Text
  readonly lines: number
  /** When the file last changed. */
  readonly modifiedAt: EpochMs
}

export interface OtherFileInfo {
  readonly kind: FileInfoKind.Other
  /** When the file last changed. */
  readonly modifiedAt: EpochMs
}

export interface MissingFileInfo {
  readonly kind: FileInfoKind.Missing
}

/** An artifact's file, as its card describes it (`files.info`). */
export type FileInfo = TextFileInfo | OtherFileInfo | MissingFileInfo
