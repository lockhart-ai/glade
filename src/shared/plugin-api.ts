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
  /** Only to a plugin with the `machine` capability on. */
  MachineReading = 'machine.reading',
  /** Only to a plugin whose manifest declares `settings`. */
  SettingsChanged = 'settings.changed',
}

/**
 * A plugin's own settings, as its manifest declares them: each setting's `key` to its value, with every declared
 * setting present (what you chose in Settings › Plugins, or its default). Nothing of Glade's settings or another
 * plugin's.
 */
export type PluginSettings = Readonly<Record<string, string>>

/** How many readings a snapshot's `machine` holds at most: the latest, about two minutes of them. */
export const MAX_PLUGIN_MACHINE_HISTORY = 60

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
  /**
   * What the agent is doing: its own turn, not what it left running. `waiting` is a turn that's over, whether the
   * task is idle or still waits on something it started: `watchers`, with the subagent events, says which.
   */
  readonly activity: PluginTaskActivity
  /**
   * Whether the task counts under Needs you: it's asking a question, waiting on a permission card, stopped on an
   * error, or its turn ended with a reply you haven't read. Background work it left running doesn't change this
   * (#461): an unread reply counts whether or not the task still has subagents or watchers running after its turn
   * (`activity` says `waiting` either way: `activity` is the agent's own turn, not what it left running). Once
   * you've read the reply it is false; a task that still has background work running then counts as working rather
   * than idle.
   */
  readonly needsYou: boolean
  /** What the agent's turn is blocked on, if anything. */
  readonly waitingOn: PluginWaitingOn | null
  /**
   * How many watchers the task has running: the `Monitor` watches and background commands (a `Bash` call with
   * `run_in_background`, or one that ran past its timeout and was moved to the background) whose process is still
   * running, started by the task's agent or by one of its subagents. 0 when none. One counts from when it starts,
   * during the agent's turn or after it, until it finishes, fails, is stopped, or dies with its session (Glade
   * quitting, or the session failing).
   *
   * Not counted: a wakeup or cron job, which the Agents tab pins too but which runs nothing until it fires, and
   * subagents, which have their own events. Only the count: nothing of a watcher's command, name or output.
   *
   * With the running subagents, it's everything Glade itself counts as the task's background work: a task whose turn
   * is over (`activity` is `waiting`) is waiting on something exactly when `watchers` is over 0 or one of its
   * subagents is running, and idle otherwise.
   */
  readonly watchers: number
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

/** A subagent, as its tab in the Agents tab sums it up. */
export interface PluginSubagent {
  /** The tool_use id of the `Agent` call that started it. */
  readonly id: string
  readonly taskId: string
  /** Its description, as its tab in the Agents tab shows it. */
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

/** A running Docker container's load, as `docker stats` reports it. */
export interface PluginContainer {
  /** Its name (`acme-api-db-1`), not its id, image or command. */
  readonly name: string
  /** Its CPU, in percent of one core: 100 is one whole core, so a busy container can pass 100. */
  readonly cpu: number
  /** The memory it uses, in bytes. */
  readonly memory: number
}

/**
 * The Mac's load at one moment, for a plugin with the `machine` capability on. Coarse numbers only: never a process's
 * name, command or path. Cores are in cores (`2.5` is two and a half cores busy), to two decimal places.
 */
export interface PluginMachineReading {
  /** When it was read, in epoch milliseconds. */
  readonly t: number
  /** The Mac's logical CPU cores. */
  readonly cpuCount: number
  /** Cores in use by every process. */
  readonly total: number
  /** Cores in use by Claude Code (every `claude` process, Glade's tasks' and your terminals' alike) and its children. */
  readonly claude: number
  /** Cores in use by Docker's containers: the sum of their `cpu`, over 100. */
  readonly docker: number
  /** The GPU's utilisation, in percent; null when it can't be read. */
  readonly gpu: number | null
  /** The running containers, busiest first; empty when Docker isn't installed or isn't running. */
  readonly containers: readonly PluginContainer[]
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
  /**
   * Only for a plugin with the `machine` capability on (absent otherwise): the latest readings, oldest first, up to
   * `MAX_PLUGIN_MACHINE_HISTORY`. Empty until the first one is taken.
   */
  readonly machine?: readonly PluginMachineReading[]
  /** Only for a plugin whose manifest declares `settings` (absent otherwise): each one's value, by key. */
  readonly settings?: PluginSettings
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

/** The Mac's load, about every 2 s while the plugin is showing: only to a plugin with the `machine` capability on. */
export interface PluginMachineReadingEvent {
  readonly type: PluginEventType.MachineReading
  readonly reading: PluginMachineReading
}

/**
 * You changed one of the plugin's settings in Settings › Plugins while its page was running: all of them as they now
 * are, not only the one that changed. Only to a plugin whose manifest declares `settings`.
 */
export interface PluginSettingsChangedEvent {
  readonly type: PluginEventType.SettingsChanged
  readonly settings: PluginSettings
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
  | PluginMachineReadingEvent
  | PluginSettingsChangedEvent

/**
 * The task and agent events that follow the snapshot, as things change: every event but `hello`, `snapshot`, the
 * machine's readings and the plugin's settings, which come from Glade itself rather than the tasks.
 */
export type PluginChangeEvent = Exclude<
  PluginEvent,
  PluginHelloEvent | PluginSnapshotEvent | PluginMachineReadingEvent | PluginSettingsChangedEvent
>

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
  /**
   * Opens a task the plugin can see, as clicking its row does, and with `subagentId` that subagent in the Subagents
   * tab. Only right after a click or key press in the plugin's own view.
   */
  OpenTask = 'openTask',
}

export interface PluginReadyMessage {
  readonly type: PluginMessageType.Ready
}

export interface PluginStatusMessage {
  readonly type: PluginMessageType.Status
  readonly text: string
}

export interface PluginOpenTaskMessage {
  readonly type: PluginMessageType.OpenTask
  /** A task the plugin has been told of (its snapshot or later events) that's still active. */
  readonly taskId: string
  /** One of that task's subagents the plugin has been told of (`PluginSubagent.id`), to show on its own tab of the Agents tab. */
  readonly subagentId?: string | null | undefined
}

/** What a plugin can post back with `window.glade.post`. Anything else is dropped. */
export type PluginMessage = PluginReadyMessage | PluginStatusMessage | PluginOpenTaskMessage

/** What a plugin page's `window.glade` holds: `post`, and nothing else. */
export interface PluginBridge {
  post(message: unknown): void
}
