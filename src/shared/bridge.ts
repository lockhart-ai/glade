/**
 * The typed bridge between the main process and the renderer: one command API and one event stream.
 *
 * - **Commands** are request/response calls from the renderer to main. `CommandMap` is the single source of truth: the
 *   preload's `invoke`, the main-side handler registry and the request validators are all typed from it, so changing a
 *   command's request or response on one side without the other fails the typecheck.
 * - **Events** flow from main to every window. `GladeEvent` is a discriminated union on `type`.
 * - **Errors**: main answers every command with a `BridgeResult`. The preload unwraps it, resolving with the value or
 *   rejecting with a `BridgeError`. `BridgeError` is a plain object, not an `Error`: `contextBridge` copies an `Error`
 *   thrown into the renderer's world but drops its extra properties, so `code` wouldn't survive.
 */
import type {
  Artifact,
  Effort,
  FileContent,
  FileInfo,
  Message,
  OpenFiles,
  QuestionAnswers,
  QuestionSet,
  QueuedMessage,
  Task,
  TodoList,
  ToolEvent,
  UiStateEntry,
  UiStateKey,
  Workspace,
} from './domain'
import type { Settings, SettingsPatch } from './settings'

/** The name the bridge is exposed under on `window`. */
export const BRIDGE_KEY = 'glade'

/** The IPC channel every command is invoked on (`ipcRenderer.invoke` → `ipcMain.handle`). */
export const COMMAND_CHANNEL = 'glade:command'

/** The IPC channel main sends every event on (`webContents.send` → `ipcRenderer.on`). */
export const EVENT_CHANNEL = 'glade:event'

// Commands

export enum CommandName {
  WorkspacesList = 'workspaces.list',
  WorkspacesCreate = 'workspaces.create',
  WorkspacesOpen = 'workspaces.open',
  WorkspacesUpdate = 'workspaces.update',
  DialogChooseFolder = 'dialog.chooseFolder',
  TasksList = 'tasks.list',
  TasksCreate = 'tasks.create',
  TasksMarkDone = 'tasks.markDone',
  TasksReopen = 'tasks.reopen',
  TasksUpdate = 'tasks.update',
  TasksDelete = 'tasks.delete',
  TasksSend = 'tasks.send',
  TasksStop = 'tasks.stop',
  TasksRetry = 'tasks.retry',
  TasksCompact = 'tasks.compact',
  TasksHistory = 'tasks.history',
  QueueAdd = 'queue.add',
  QueueEdit = 'queue.edit',
  QueueRemove = 'queue.remove',
  QuestionsAnswer = 'questions.answer',
  FilesRead = 'files.read',
  FilesOpen = 'files.open',
  FilesClose = 'files.close',
  FilesOpenInEditor = 'files.openInEditor',
  FilesInfo = 'files.info',
  FilesCopy = 'files.copy',
  FilesReveal = 'files.reveal',
  UiStateGet = 'uiState.get',
  UiStateGetAll = 'uiState.getAll',
  UiStateSet = 'uiState.set',
  SettingsGet = 'settings.get',
  SettingsUpdate = 'settings.update',
}

/** The request of a command that takes no arguments: pass `{}`. */
export type EmptyRequest = Record<string, never>

export interface WorkspacesListResponse {
  /** Every workspace, oldest first. */
  readonly workspaces: readonly Workspace[]
}

/**
 * Adds a workspace rooted at an existing folder, named after the folder. If a workspace already has that root, answers
 * with it instead of adding another. Writes a starter `CLAUDE.md` into a new workspace's root when it has none.
 * Broadcasts `workspace.updated` when a workspace is added. Fails with `invalid_root_path` when the root isn't an
 * existing directory.
 */
export interface WorkspacesCreateRequest {
  /** An absolute path to an existing directory. */
  readonly rootPath: string
}

export interface WorkspacesCreateResponse {
  readonly workspace: Workspace
  /** False when a workspace with that root already existed and is the one answered with. */
  readonly created: boolean
}

/**
 * Opens a workspace: records it as last opened and makes it the window's workspace (deselecting a task in another
 * workspace). Broadcasts `workspace.updated` and `uiState.changed`. Fails with `not_found` for an unknown id.
 */
export interface WorkspacesOpenRequest {
  readonly id: string
}

export interface WorkspacesOpenResponse {
  readonly workspace: Workspace
}

/** The workspace fields you can change, in Settings › Workspace. */
export interface WorkspaceUserPatch {
  /** Not blank; saved trimmed. */
  readonly name?: string
  /** An absolute path to an existing directory, which no other workspace has as its root. */
  readonly rootPath?: string
}

/**
 * Renames a workspace or moves it to another root folder. Nothing on disk changes: the folders stay as they are, and no
 * starter `CLAUDE.md` is written. A task's agent session started before the move keeps running in the old root until it
 * ends; sessions started after it run in the new one. Broadcasts `workspace.updated`. Fails with `not_found` for an
 * unknown id, and `invalid_root_path` when the root isn't an existing directory or is another workspace's root.
 */
export interface WorkspacesUpdateRequest {
  readonly id: string
  readonly patch: WorkspaceUserPatch
}

export interface WorkspacesUpdateResponse {
  readonly workspace: Workspace
}

/** Shows the native open-folder dialog, which can also create a new folder. */
export interface DialogChooseFolderResponse {
  /** The chosen folder's absolute path; null when the dialog was cancelled. */
  readonly path: string | null
}

export interface TasksListRequest {
  readonly workspaceId: string
}

export interface TasksListResponse {
  /** The workspace's tasks, most recently updated first. */
  readonly tasks: readonly Task[]
}

/** Creates an active task with an empty title, objective and status, and the default model and effort. */
export interface TasksCreateRequest {
  readonly workspaceId: string
}

/** Names one task. */
export interface TaskIdRequest {
  readonly id: string
}

/**
 * The task fields the user can change. The title, objective and status the agent sets go through main's task service,
 * not this command; the state changes only through `tasks.markDone` and `tasks.reopen`.
 */
export interface TaskUserPatch {
  readonly title?: string
  readonly pinned?: boolean
  readonly unread?: boolean
  readonly model?: string
  readonly effort?: Effort
}

export interface TasksUpdateRequest {
  readonly id: string
  /** A `title` must not be blank. */
  readonly patch: TaskUserPatch
}

/**
 * Deletes a task (Delete task…, once you've confirmed it). Its agent's session is closed first, if it has one live,
 * stopping any turn it's running; then the task's rows go from the database: the task, its chat log, tool log, queue
 * and question sets. Nothing on disk is touched. When it's the selected task, it's deselected. Broadcasts
 * `task.deleted`. Fails with `not_found` when there's no such task.
 */
export type TasksDeleteRequest = TaskIdRequest

/**
 * What every task command answers with: the task as it now is. Each also broadcasts `task.updated` with it.
 *
 * - `tasks.markDone`: an active task becomes done and `doneAt` is set; its status is its outcome.
 * - `tasks.reopen`: a done task becomes active and `doneAt` is cleared. Straight after `tasks.markDone`, it restores
 *   every field but `updatedAt`, so it's also how Undo works.
 * - Either one on a task already in the target state fails with `invalid_transition`; any task command on a task that
 *   doesn't exist fails with `not_found`.
 */
export interface TaskResponse {
  readonly task: Task
}

/**
 * Sends the user's message to a task's agent, starting a turn. A done task is reopened by it: it becomes active, its
 * `doneAt` is cleared, and the tool log gets marked done (stamped with the old `doneAt`) and reopened dividers before
 * the new turn's. Answers once the message is saved and handed to the agent, not when the turn ends: the turn's
 * progress arrives as `message.appended`, `toolEvent.appended`, `toolEvent.updated` and `task.updated` events.
 *
 * Messages waiting in the task's queue (a turn that was stopped or failed leaves them there) go first, in order, then
 * this one: all of them start the turn, and each is saved to the chat log.
 *
 * While the agent waits on answers to questions it asked (`task.asking`), the message answers them instead, in your own
 * words: it's saved to the chat log as your reply, in the turn that asked, and the agent gets it as the answer
 * (`{ "freeText": … }`). It starts no turn, and the queue stays as it is. Broadcasts `question.answered`.
 *
 * Fails with `busy` while the agent is working on a turn or the task is paused (queue the message with `queue.add`
 * instead), and `not_found` when there's no such task.
 */
export interface TasksSendRequest {
  readonly id: string
  /** Markdown. Not blank. */
  readonly text: string
}

export interface TasksSendResponse {
  /** The user's message, as saved to the chat log. */
  readonly message: Message
}

/**
 * Stops the task's agent: interrupts its running turn, and answers with the task once the turn has ended, back to
 * waiting on you. The session stays alive, so the next `tasks.send` carries on in it. What the turn already saved
 * stays; its unfinished tool calls end as errors, and the tool log notes that you stopped it.
 *
 * On a task whose agent isn't working it does nothing and answers with the task. Fails with `not_found` when there's
 * no such task.
 */
export type TasksStopRequest = TaskIdRequest

/**
 * Retries the turn an error stopped or a pause holds: the turn's last message goes to the agent again, in the same
 * session, and the task is working again, with its error or pause cleared. With a `model`, the task changes to it
 * first, and the retry runs on it (the usage limit banner's Switch model). Answers with the task, working. Nothing new
 * goes to the chat log: the turn's progress arrives as events, as it does after `tasks.send`, and a turn that fails
 * again stops (or pauses) the task on the new error.
 *
 * Fails with `invalid_transition` for a task whose agent isn't stopped by an error or paused, `busy` while the agent
 * is working on a turn, and `not_found` when there's no such task.
 */
export interface TasksRetryRequest {
  readonly id: string
  /** The model to retry on, as the SDK names it; the task's own when left out. */
  readonly model?: string
}

/**
 * Compacts the task's context now (Compact now, ⌘⇧K): sends its session `/compact` (`docs/sdk-notes.md` §5), which
 * replaces older turns with a summary for the agent. Nothing goes to the chat log. The agent works while it compacts,
 * so messages sent meanwhile are queued. The tool log gets a running Compact row, filled in with the tokens before and
 * after when the SDK reports it done, and the task's context usage drops to the tokens after. Answers with the task
 * once compaction has started, not when it ends.
 *
 * Fails with `busy` while the agent is working, `invalid_transition` for a done task or one whose agent has no session
 * yet (nothing to compact), and `not_found` when there's no such task.
 */
export type TasksCompactRequest = TaskIdRequest

/** A task's chat log and tool log, each in the order they were appended, its message queue, and its questions. */
export interface TasksHistoryResponse {
  readonly messages: readonly Message[]
  readonly toolEvents: readonly ToolEvent[]
  /** The messages waiting to be delivered, in the order they will be. */
  readonly queuedMessages: readonly QueuedMessage[]
  /** Every question set the agent asked, open or closed, in the order it asked them. */
  readonly questionSets: readonly QuestionSet[]
  /** The files open in its Files tab. */
  readonly openFiles: OpenFiles
  /** The agent's todo list (the Todos tab), as its tool log leaves it; null when it has kept none. */
  readonly todos: TodoList | null
  /** The files the agent declared as its deliverables (the Artifacts tab), in the order it first declared them. */
  readonly artifacts: readonly Artifact[]
}

/**
 * Adds the user's message to the end of a task's queue, for the agent to get after its current step: when the running
 * turn's current tool calls have their results, or when the turn ends. Until then it can be edited or removed. When
 * the task's agent isn't working (the turn ended just before the message arrived), the queue is delivered at once,
 * starting a turn, as `tasks.send` would, unless the task is paused: then it waits until the task resumes. Broadcasts
 * `queue.changed`. Fails with `not_found` when there's no such task.
 */
export interface QueueAddRequest {
  readonly taskId: string
  /** Markdown. Not blank. */
  readonly text: string
}

/** Changes the text of a message still waiting in its queue. Broadcasts `queue.changed`. */
export interface QueueEditRequest {
  readonly id: string
  /** Markdown. Not blank. */
  readonly text: string
}

/** Removes a message still waiting in its queue. Broadcasts `queue.changed`. */
export interface QueueRemoveRequest {
  readonly id: string
}

/**
 * `queue.add` and `queue.edit` answer with the queued message as it now is. `queue.edit` and `queue.remove` fail with
 * `not_found` when the message isn't queued any more: it was delivered or removed.
 */
export interface QueuedMessageResponse {
  readonly queuedMessage: QueuedMessage
}

/**
 * Answers the open question set the agent asked (`ask`) with the card: an answer for each question, keyed by its index
 * from 0 (see `checkAnswers` in `./questions` for what each kind of question takes). The agent's turn carries on with
 * the answers as the tool's result, and the task is working again. Broadcasts `question.answered` and `task.updated`.
 *
 * If the app quit while the question was open, the agent's call is gone: its session is resumed, and the answers go to
 * it as a message, with a resumed divider in the tool log (see the runner).
 *
 * Replying in words instead is `tasks.send`: a message sent while a question is open answers it.
 *
 * Fails with `invalid_request` for answers that don't fit the questions, `not_found` when there's no such set, and
 * `invalid_transition` for one that isn't open any more.
 */
export interface QuestionsAnswerRequest {
  /** The question set's id. */
  readonly id: string
  readonly answers: QuestionAnswers
}

export interface QuestionSetResponse {
  /** The question set as it now is: answered, with its answers tidied (text trimmed, empty optional text dropped). */
  readonly questionSet: QuestionSet
}

/**
 * Names a file in a task's workspace, by its path relative to the workspace root (`src/date.ts`). Every `files.*`
 * command only reaches files inside the root: a path that isn't relative and normalized (`../secrets`, `/etc/hosts`)
 * fails with `invalid_request`, and one that a symlink takes outside the root with `outside_workspace`. Each fails with
 * `not_found` when there's no such task.
 */
export interface FileRequest {
  readonly taskId: string
  /** Relative to the task's workspace root, normalized: no `.` or `..` parts, no leading or trailing `/`. */
  readonly path: string
}

/**
 * Reads a file for the Files tab's viewer. A file larger than the viewer shows (`MAX_FILE_BYTES` or `MAX_FILE_LINES` in
 * `./files`) comes back truncated to its first lines; a binary one, or one that isn't there, comes back as such rather
 * than failing.
 */
export type FilesReadRequest = FileRequest

export interface FilesReadResponse {
  readonly content: FileContent
}

/**
 * Opens a file in the task's Files tab, as a new tab at the end (or the tab it already has), and shows it. The file
 * needn't exist. Broadcasts `openFiles.changed`.
 */
export type FilesOpenRequest = FileRequest

/**
 * Closes a file's tab in the task's Files tab. Closing the tab showing shows the next one (or the one before, if it was
 * last). Closing a file that isn't open does nothing. Broadcasts `openFiles.changed`.
 */
export type FilesCloseRequest = FileRequest

/** `files.open` and `files.close` answer with the task's open files as they now are. */
export interface OpenFilesResponse {
  readonly openFiles: OpenFiles
}

/**
 * Opens a file in the app macOS opens its kind of file with (Open in editor, ⌘⇧E). Fails with `not_found` when there's
 * no such file, and `internal` when macOS can't open it.
 */
export type FilesOpenInEditorRequest = FileRequest

/**
 * Describes a file for its artifact card: its line count (from a cheap read) and when it last changed, or that it's
 * missing. Never fails for a file that isn't there.
 */
export type FilesInfoRequest = FileRequest

export interface FilesInfoResponse {
  readonly info: FileInfo
}

/**
 * Copies a text file's contents to the clipboard (an artifact's Copy). Fails with `not_found` when there's no such
 * file, and `invalid_request` when it isn't text or is too large to copy.
 */
export type FilesCopyRequest = FileRequest

/** Shows a file in Finder, selected (an artifact's Reveal in folder). Fails with `not_found` when there's no such file. */
export type FilesRevealRequest = FileRequest

export interface UiStateGetRequest {
  readonly key: UiStateKey
}

export interface UiStateGetResponse {
  /** Null when the key has never been set. */
  readonly value: string | null
}

export interface UiStateGetAllResponse {
  /** Every UI state value that has been set. */
  readonly entries: readonly UiStateEntry[]
}

/** Sets one UI state value. Broadcasts `uiState.changed`. */
export type UiStateSetRequest = UiStateEntry

/** `settings.get` and `settings.update` answer with the settings as they now are. */
export interface SettingsResponse {
  readonly settings: Settings
}

/** Changes the settings in `patch` (Settings saves each change at once). Broadcasts `settings.changed`. */
export interface SettingsUpdateRequest {
  readonly patch: SettingsPatch
}

/** One command's request and response types. */
export interface CommandSpec<Request, Response> {
  readonly request: Request
  readonly response: Response
}

/** Each command's request and response. Add a command here and the handler registry won't typecheck until it has one. */
export interface CommandMap {
  [CommandName.WorkspacesList]: CommandSpec<EmptyRequest, WorkspacesListResponse>
  [CommandName.WorkspacesCreate]: CommandSpec<WorkspacesCreateRequest, WorkspacesCreateResponse>
  [CommandName.WorkspacesOpen]: CommandSpec<WorkspacesOpenRequest, WorkspacesOpenResponse>
  [CommandName.WorkspacesUpdate]: CommandSpec<WorkspacesUpdateRequest, WorkspacesUpdateResponse>
  [CommandName.DialogChooseFolder]: CommandSpec<EmptyRequest, DialogChooseFolderResponse>
  [CommandName.TasksList]: CommandSpec<TasksListRequest, TasksListResponse>
  [CommandName.TasksCreate]: CommandSpec<TasksCreateRequest, TaskResponse>
  [CommandName.TasksMarkDone]: CommandSpec<TaskIdRequest, TaskResponse>
  [CommandName.TasksReopen]: CommandSpec<TaskIdRequest, TaskResponse>
  [CommandName.TasksUpdate]: CommandSpec<TasksUpdateRequest, TaskResponse>
  [CommandName.TasksDelete]: CommandSpec<TasksDeleteRequest, null>
  [CommandName.TasksSend]: CommandSpec<TasksSendRequest, TasksSendResponse>
  [CommandName.TasksStop]: CommandSpec<TasksStopRequest, TaskResponse>
  [CommandName.TasksRetry]: CommandSpec<TasksRetryRequest, TaskResponse>
  [CommandName.TasksCompact]: CommandSpec<TasksCompactRequest, TaskResponse>
  [CommandName.TasksHistory]: CommandSpec<TaskIdRequest, TasksHistoryResponse>
  [CommandName.QueueAdd]: CommandSpec<QueueAddRequest, QueuedMessageResponse>
  [CommandName.QueueEdit]: CommandSpec<QueueEditRequest, QueuedMessageResponse>
  [CommandName.QueueRemove]: CommandSpec<QueueRemoveRequest, null>
  [CommandName.QuestionsAnswer]: CommandSpec<QuestionsAnswerRequest, QuestionSetResponse>
  [CommandName.FilesRead]: CommandSpec<FilesReadRequest, FilesReadResponse>
  [CommandName.FilesOpen]: CommandSpec<FilesOpenRequest, OpenFilesResponse>
  [CommandName.FilesClose]: CommandSpec<FilesCloseRequest, OpenFilesResponse>
  [CommandName.FilesOpenInEditor]: CommandSpec<FilesOpenInEditorRequest, null>
  [CommandName.FilesInfo]: CommandSpec<FilesInfoRequest, FilesInfoResponse>
  [CommandName.FilesCopy]: CommandSpec<FilesCopyRequest, null>
  [CommandName.FilesReveal]: CommandSpec<FilesRevealRequest, null>
  [CommandName.UiStateGet]: CommandSpec<UiStateGetRequest, UiStateGetResponse>
  [CommandName.UiStateGetAll]: CommandSpec<EmptyRequest, UiStateGetAllResponse>
  [CommandName.UiStateSet]: CommandSpec<UiStateSetRequest, null>
  [CommandName.SettingsGet]: CommandSpec<EmptyRequest, SettingsResponse>
  [CommandName.SettingsUpdate]: CommandSpec<SettingsUpdateRequest, SettingsResponse>
}

export type CommandRequest<C extends CommandName> = CommandMap[C]['request']
export type CommandResponse<C extends CommandName> = CommandMap[C]['response']

// Events

export enum EventType {
  UiStateChanged = 'uiState.changed',
  WorkspaceUpdated = 'workspace.updated',
  TaskUpdated = 'task.updated',
  TaskDeleted = 'task.deleted',
  MessageAppended = 'message.appended',
  ToolEventAppended = 'toolEvent.appended',
  ToolEventUpdated = 'toolEvent.updated',
  TaskOpenRequested = 'task.openRequested',
  QueueChanged = 'queue.changed',
  QuestionOpened = 'question.opened',
  QuestionAnswered = 'question.answered',
  QuestionWithdrawn = 'question.withdrawn',
  OpenFilesChanged = 'openFiles.changed',
  FileShown = 'file.shown',
  TodosChanged = 'todos.changed',
  ArtifactsChanged = 'artifacts.changed',
  SettingsChanged = 'settings.changed',
}

export interface UiStateChangedEvent {
  readonly type: EventType.UiStateChanged
  readonly entry: UiStateEntry
}

/** A workspace was added or changed. Carries the whole workspace as it now is. */
export interface WorkspaceUpdatedEvent {
  readonly type: EventType.WorkspaceUpdated
  readonly workspace: Workspace
}

/** A task was created or changed. Carries the whole task as it now is. */
export interface TaskUpdatedEvent {
  readonly type: EventType.TaskUpdated
  readonly task: Task
}

/** A task was deleted, and with it its logs, queue and question sets. */
export interface TaskDeletedEvent {
  readonly type: EventType.TaskDeleted
  readonly taskId: string
}

/** A message was appended to a task's chat log. */
export interface MessageAppendedEvent {
  readonly type: EventType.MessageAppended
  readonly message: Message
}

/** An entry was appended to a task's tool log. */
export interface ToolEventAppendedEvent {
  readonly type: EventType.ToolEventAppended
  readonly toolEvent: ToolEvent
}

/** A tool log entry changed: a tool call's result arrived, or a compaction finished. Carries the whole entry as it now is. */
export interface ToolEventUpdatedEvent {
  readonly type: EventType.ToolEventUpdated
  readonly toolEvent: ToolEvent
}

/**
 * Main asks the window to open a task, as clicking its row does: selecting it (and its workspace), which reads it, and
 * loading its logs. Sent when you click the task's notification.
 */
export interface TaskOpenRequestedEvent {
  readonly type: EventType.TaskOpenRequested
  readonly taskId: string
}

/**
 * A task's message queue changed: a message was added, edited or removed, or the queue was delivered. Carries the
 * whole queue as it now is, in order.
 */
export interface QueueChangedEvent {
  readonly type: EventType.QueueChanged
  readonly taskId: string
  readonly queuedMessages: readonly QueuedMessage[]
}

/** The agent asked questions (`ask`) and waits on the answers: the chat shows the open set's card. */
export interface QuestionOpenedEvent {
  readonly type: EventType.QuestionOpened
  readonly questionSet: QuestionSet
}

/** You answered a question set, with the card or in words. Carries the set as it now is, with its reply. */
export interface QuestionAnsweredEvent {
  readonly type: EventType.QuestionAnswered
  readonly questionSet: QuestionSet
}

/** The turn that asked a question set ended without an answer (it was stopped, or failed): the card closes. */
export interface QuestionWithdrawnEvent {
  readonly type: EventType.QuestionWithdrawn
  readonly questionSet: QuestionSet
}

/** A task's open files changed: a file was opened or closed. Carries them as they now are. */
export interface OpenFilesChangedEvent {
  readonly type: EventType.OpenFilesChanged
  readonly openFiles: OpenFiles
}

/**
 * The agent asked to show you a file (`show_file`): it's open in its task's Files tab, and the window shows it there,
 * at `line`, if that task is the one you're viewing. Sent after the `openFiles.changed` that opened it.
 */
export interface FileShownEvent {
  readonly type: EventType.FileShown
  readonly taskId: string
  /** Relative to the task's workspace root. */
  readonly path: string
  /** The line to scroll to and mark, from 1; null for the top of the file. */
  readonly line: number | null
}

/** A todo tool call of the agent's finished, which changed its todo list. Carries the whole list as it now is. */
export interface TodosChangedEvent {
  readonly type: EventType.TodosChanged
  readonly taskId: string
  readonly todos: TodoList | null
}

/** The agent declared an artifact, or declared one again with a new title. Carries the task's artifacts as they now are. */
export interface ArtifactsChangedEvent {
  readonly type: EventType.ArtifactsChanged
  readonly taskId: string
  readonly artifacts: readonly Artifact[]
}

/** The settings changed. Carries them all as they now are. */
export interface SettingsChangedEvent {
  readonly type: EventType.SettingsChanged
  readonly settings: Settings
}

/** Everything main broadcasts to the windows. */
export type GladeEvent =
  | UiStateChangedEvent
  | WorkspaceUpdatedEvent
  | TaskUpdatedEvent
  | TaskDeletedEvent
  | MessageAppendedEvent
  | ToolEventAppendedEvent
  | ToolEventUpdatedEvent
  | TaskOpenRequestedEvent
  | QueueChangedEvent
  | QuestionOpenedEvent
  | QuestionAnsweredEvent
  | QuestionWithdrawnEvent
  | OpenFilesChangedEvent
  | FileShownEvent
  | TodosChangedEvent
  | ArtifactsChangedEvent
  | SettingsChangedEvent

export type EventListener = (event: GladeEvent) => void

/** Stops a subscription. Calling it again does nothing. */
export type Unsubscribe = () => void

// Errors

export enum BridgeErrorCode {
  /** The command name isn't in `CommandMap`. */
  UnknownCommand = 'unknown_command',
  /** The request doesn't match the command's request type. */
  InvalidRequest = 'invalid_request',
  /** The command names something that doesn't exist, such as a deleted task or workspace. */
  NotFound = 'not_found',
  /** The command asks for a state change the thing's current state doesn't allow, such as reopening an active task. */
  InvalidTransition = 'invalid_transition',
  /** The agent is working on a turn, so it can't take another message yet. */
  Busy = 'busy',
  /** A workspace root that isn't an existing directory. */
  InvalidRootPath = 'invalid_root_path',
  /** A file path outside the task's workspace root, or one a symlink takes outside it. */
  OutsideWorkspace = 'outside_workspace',
  /** The handler threw. */
  Internal = 'internal',
}

/** Why a command failed. What a rejected `invoke` promise rejects with. */
export interface BridgeError {
  readonly name: 'BridgeError'
  readonly code: BridgeErrorCode
  readonly message: string
}

/** How main answers a command across IPC. */
export type BridgeResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: BridgeError }

export function bridgeError(code: BridgeErrorCode, message: string): BridgeError {
  return { name: 'BridgeError', code, message }
}

/** Whether a rejection from `invoke` is a `BridgeError`. */
export function isBridgeError(value: unknown): value is BridgeError {
  return (
    typeof value === 'object' &&
    value !== null &&
    Reflect.get(value, 'name') === 'BridgeError' &&
    Object.values<unknown>(BridgeErrorCode).includes(Reflect.get(value, 'code')) &&
    typeof Reflect.get(value, 'message') === 'string'
  )
}

// The bridge

/** The API the preload exposes to the renderer as `window.glade`. */
export interface GladeBridge {
  /** Runs a command in main. Rejects with a `BridgeError` when it fails. */
  invoke<C extends CommandName>(command: C, request: CommandRequest<C>): Promise<CommandResponse<C>>
  /** Calls `listener` with every event main broadcasts, until unsubscribed. */
  subscribe(listener: EventListener): Unsubscribe
}
