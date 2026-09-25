/**
 * The messages Glade and a plugin's page send each other (`docs/plugin-api.md`, "Talking to Glade" and "Events"). Shared
 * by main, which sends and checks them, and the plugin preload, which only relays them. It imports nothing, so a plugin
 * can copy it whole; `./plugin-api-schema` has zod schemas for the same shapes, checked against these types.
 */

/** The version of the schema every message Glade sends follows. */
export const PLUGIN_API_VERSION = 1

/** The scheme a plugin's files are served under, `glade-plugin://<id>/<path>`, from its own folder only. */
export const PLUGIN_SCHEME = 'glade-plugin'

/** The IPC channel main sends a plugin's page Glade's messages on; its preload posts each to the page. */
export const PLUGIN_MESSAGE_CHANNEL = 'glade:plugin-message'

/** The IPC channel a plugin's preload sends the page's `window.glade.post` messages on. */
export const PLUGIN_POST_CHANNEL = 'glade:plugin-post'

/** The name the bridge has on a plugin page's `window`: `window.glade.post(message)`. */
export const PLUGIN_BRIDGE_KEY = 'glade'

/**
 * The largest message a plugin may post, as JSON. The preload drops anything bigger before it reaches main, and main's
 * schema caps each field as well.
 */
export const MAX_PLUGIN_MESSAGE_BYTES = 16 * 1024

/** The longest status the panel header shows; a longer one is cut. */
export const MAX_PLUGIN_STATUS = 40

/** Free text Glade sends (titles, statuses, notes, names, summaries, prompts) is cut to this many characters. */
export const MAX_PLUGIN_TEXT = 200

/** The kinds of event Glade sends a plugin (`docs/plugin-api.md`, "Events"). */
export enum PluginEventType {
  Hello = 'hello',
  Snapshot = 'snapshot',
  TaskCreated = 'task.created',
  TaskUpdated = 'task.updated',
  TaskDeleted = 'task.deleted',
  AgentToolCall = 'agent.toolCall',
  AgentNote = 'agent.note',
  SubagentStarted = 'subagent.started',
  SubagentUpdated = 'subagent.updated',
  QuestionOpened = 'question.opened',
  QuestionClosed = 'question.closed',
  PermissionOpened = 'permission.opened',
  PermissionClosed = 'permission.closed',
}

/** A task is active or done. */
export enum PluginTaskState {
  Active = 'active',
  Done = 'done',
}

/** What a task's agent is doing. */
export enum PluginTaskActivity {
  /** It isn't running a turn: it's waiting on you. */
  Waiting = 'waiting',
  /** It's running a turn. */
  Working = 'working',
  /** Its last turn failed. */
  Error = 'error',
  /** Its turn is paused (a usage limit, or offline), and resumes on its own. */
  Paused = 'paused',
}

/** What a task's turn is blocked on. */
export enum PluginWaitingOn {
  /** Your answers to questions it asked. */
  Question = 'question',
  /** Your OK for a tool call. */
  Permission = 'permission',
}

/** Where a tool call is. */
export enum PluginToolCallState {
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  /** Cut off, by Glade quitting or the task pausing: not a failure. */
  Interrupted = 'interrupted',
}

/** Where a subagent is. */
export enum PluginSubagentState {
  Running = 'running',
  Done = 'done',
  Failed = 'failed',
  /** Cut off, by Glade quitting or the task pausing: not a failure. */
  Stopped = 'stopped',
}

/** How a task's questions closed. */
export enum PluginQuestionOutcome {
  Answered = 'answered',
  Withdrawn = 'withdrawn',
}

/** How a permission request closed. */
export enum PluginPermissionOutcome {
  Allowed = 'allowed',
  Denied = 'denied',
  Withdrawn = 'withdrawn',
}

/** A task, as the task list sums it up. */
export interface PluginTask {
  readonly id: string
  readonly workspaceId: string
  readonly workspaceName: string
  /** Empty until the agent names the task. */
  readonly title: string
  /** The one-line status summary; the outcome once done. Empty until the agent sets one. */
  readonly status: string
  readonly state: PluginTaskState
  readonly activity: PluginTaskActivity
  /** Whether the task counts under Needs you. */
  readonly needsYou: boolean
  /** What the agent's turn is blocked on, if anything. */
  readonly waitingOn: PluginWaitingOn | null
  readonly createdAt: number
  readonly updatedAt: number
  readonly doneAt: number | null
}

/** A tool call, as the tool log sums it up. */
export interface PluginToolCall {
  /** The SDK's tool_use id. */
  readonly id: string
  readonly taskId: string
  /** The subagent that made it (its `PluginSubagent.id`); null for the task's main agent. */
  readonly subagentId: string | null
  /** The tool's display name, as the tool log shows it (`Bash`, `Edit`, `set_status`). */
  readonly tool: string
  /** What it acts on, as the tool log shows it: a path, a command, a pattern. Empty for other tools. */
  readonly summary: string
  readonly state: PluginToolCallState
  readonly startedAt: number
  readonly endedAt: number | null
}

/** A subagent, as the Subagents tab sums it up. */
export interface PluginSubagent {
  /** The tool_use id of the `Agent` call that started it. */
  readonly id: string
  readonly taskId: string
  /** Its description, as the Subagents tab shows it. */
  readonly name: string
  readonly state: PluginSubagentState
  /** The last thing it said or did: a note, or a tool and its summary. Null before it does anything. */
  readonly latest: string | null
  readonly startedAt: number
  readonly endedAt: number | null
}

/** The questions one `ask` put to you. */
export interface PluginQuestion {
  readonly taskId: string
  readonly questionSetId: string
  /** Each question's prompt, in order. */
  readonly prompts: readonly string[]
  readonly openedAt: number
}

/** A tool call waiting on a permission card. */
export interface PluginPermissionRequest {
  readonly taskId: string
  readonly requestId: string
  /** The subagent whose call it is; null for the task's main agent. */
  readonly subagentId: string | null
  readonly tool: string
  readonly summary: string
  readonly openedAt: number
}

/** Glade's name and version, in `hello`. */
export interface PluginAppInfo {
  readonly name: 'Glade'
  readonly version: string
}

/** First, after each `ready`: which Glade the plugin is talking to. */
export interface PluginHelloEvent {
  readonly type: PluginEventType.Hello
  readonly app: PluginAppInfo
}

/** After `hello`: every active task in every workspace, their running subagents, and what they wait on. */
export interface PluginSnapshotEvent {
  readonly type: PluginEventType.Snapshot
  readonly tasks: readonly PluginTask[]
  readonly subagents: readonly PluginSubagent[]
  readonly questions: readonly PluginQuestion[]
  readonly permissions: readonly PluginPermissionRequest[]
}

export interface PluginTaskCreatedEvent {
  readonly type: PluginEventType.TaskCreated
  readonly task: PluginTask
}

export interface PluginTaskUpdatedEvent {
  readonly type: PluginEventType.TaskUpdated
  readonly task: PluginTask
}

export interface PluginTaskDeletedEvent {
  readonly type: PluginEventType.TaskDeleted
  readonly taskId: string
}

/** A tool call started, or ended. */
export interface PluginToolCallEvent {
  readonly type: PluginEventType.AgentToolCall
  readonly call: PluginToolCall
}

/** The agent's working notes between tool calls. */
export interface PluginNoteEvent {
  readonly type: PluginEventType.AgentNote
  readonly taskId: string
  readonly subagentId: string | null
  readonly text: string
  readonly at: number
}

export interface PluginSubagentStartedEvent {
  readonly type: PluginEventType.SubagentStarted
  readonly subagent: PluginSubagent
}

export interface PluginSubagentUpdatedEvent {
  readonly type: PluginEventType.SubagentUpdated
  readonly subagent: PluginSubagent
}

export interface PluginQuestionOpenedEvent {
  readonly type: PluginEventType.QuestionOpened
  readonly question: PluginQuestion
}

export interface PluginQuestionClosedEvent {
  readonly type: PluginEventType.QuestionClosed
  readonly taskId: string
  readonly questionSetId: string
  readonly outcome: PluginQuestionOutcome
}

export interface PluginPermissionOpenedEvent {
  readonly type: PluginEventType.PermissionOpened
  readonly request: PluginPermissionRequest
}

export interface PluginPermissionClosedEvent {
  readonly type: PluginEventType.PermissionClosed
  readonly taskId: string
  readonly requestId: string
  readonly outcome: PluginPermissionOutcome
}

/** What Glade tells a plugin, discriminated by `type`. */
export type PluginEvent =
  | PluginHelloEvent
  | PluginSnapshotEvent
  | PluginTaskCreatedEvent
  | PluginTaskUpdatedEvent
  | PluginTaskDeletedEvent
  | PluginToolCallEvent
  | PluginNoteEvent
  | PluginSubagentStartedEvent
  | PluginSubagentUpdatedEvent
  | PluginQuestionOpenedEvent
  | PluginQuestionClosedEvent
  | PluginPermissionOpenedEvent
  | PluginPermissionClosedEvent

/** The events that follow the snapshot, as things change: every event but `hello` and `snapshot`. */
export type PluginChangeEvent = Exclude<PluginEvent, PluginHelloEvent | PluginSnapshotEvent>

/** The envelope every message from Glade to a plugin comes in. */
export interface GladeMessage {
  readonly source: 'glade'
  /** The schema version this message follows. */
  readonly apiVersion: typeof PLUGIN_API_VERSION
  /** Counts up from 1 with each message since the last `hello`. */
  readonly seq: number
  readonly event: PluginEvent
}

export enum PluginMessageType {
  /** Asks for `hello` and a `snapshot`. */
  Ready = 'ready',
  /** Sets the short status at the right of the panel header; `''` clears it. */
  Status = 'status',
}

export interface PluginReadyMessage {
  readonly type: PluginMessageType.Ready
}

export interface PluginStatusMessage {
  readonly type: PluginMessageType.Status
  readonly text: string
}

/** What a plugin can post back with `window.glade.post`. Anything else is dropped. */
export type PluginMessage = PluginReadyMessage | PluginStatusMessage

/** What a plugin page's `window.glade` holds: `post`, and nothing else. */
export interface PluginBridge {
  post(message: unknown): void
}
