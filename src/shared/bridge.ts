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
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
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
import type { Command, MenuState } from './commands'
import type { ImageData } from './images'
import type { Settings, SettingsPatch } from './settings'
import type { SearchResult } from './search'
import type { DoneCounts, DonePage, DonePageRequest } from './doneList'
import type { TerminalTab } from './terminal'
import type { InstalledPlugin } from './plugins'

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
  WorkspacesReveal = 'workspaces.reveal',
  WorkspacesRemove = 'workspaces.remove',
  DialogChooseFolder = 'dialog.chooseFolder',
  TasksList = 'tasks.list',
  TasksListActive = 'tasks.listActive',
  TasksListDone = 'tasks.listDone',
  TasksGet = 'tasks.get',
  TasksCreate = 'tasks.create',
  TasksMarkDone = 'tasks.markDone',
  TasksReopen = 'tasks.reopen',
  TasksUpdate = 'tasks.update',
  TasksDelete = 'tasks.delete',
  TasksSend = 'tasks.send',
  TasksStop = 'tasks.stop',
  TasksRetry = 'tasks.retry',
  TasksCompact = 'tasks.compact',
  SubagentsStop = 'subagents.stop',
  TasksHistory = 'tasks.history',
  QueueAdd = 'queue.add',
  QueueEdit = 'queue.edit',
  QueueRemove = 'queue.remove',
  ImagesGet = 'images.get',
  QuestionsAnswer = 'questions.answer',
  PermissionsAnswer = 'permissions.answer',
  FilesRead = 'files.read',
  FilesOpen = 'files.open',
  FilesClose = 'files.close',
  FilesOpenInEditor = 'files.openInEditor',
  ClipboardWriteText = 'clipboard.writeText',
  FilesInfo = 'files.info',
  FilesCopy = 'files.copy',
  FilesReveal = 'files.reveal',
  ArtifactsRemove = 'artifacts.remove',
  UiStateGet = 'uiState.get',
  UiStateGetAll = 'uiState.getAll',
  UiStateSet = 'uiState.set',
  SettingsGet = 'settings.get',
  SettingsUpdate = 'settings.update',
  SearchQuery = 'search.query',
  PluginsList = 'plugins.list',
  PluginsSetEnabled = 'plugins.setEnabled',
  PluginsOpenFolder = 'plugins.openFolder',
  PluginsPlaceView = 'plugins.placeView',
  TerminalList = 'terminal.list',
  TerminalCreate = 'terminal.create',
  TerminalDuplicate = 'terminal.duplicate',
  TerminalAttach = 'terminal.attach',
  TerminalWrite = 'terminal.write',
  TerminalResize = 'terminal.resize',
  TerminalRename = 'terminal.rename',
  TerminalClear = 'terminal.clear',
  TerminalInterrupt = 'terminal.interrupt',
  TerminalClose = 'terminal.close',
  MenuUpdate = 'menu.update',
  WindowClose = 'window.close',
  LogRendererError = 'log.rendererError',
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
 * Opens a workspace: records it as last opened and makes it the window's workspace, selecting the task last selected
 * in it (or none). Broadcasts `workspace.updated` and `uiState.changed`. Fails with `not_found` for an unknown id.
 */
export interface WorkspacesOpenRequest {
  readonly id: string
}

export interface WorkspacesOpenResponse {
  readonly workspace: Workspace
  /** The task selected now: the one last selected in the workspace, or null for none. */
  readonly selectedTaskId: string | null
}

/** Shows a workspace's root folder in Finder (Reveal root in Finder). Fails with `not_found` for an unknown id. */
export interface WorkspacesRevealRequest {
  readonly id: string
}

/**
 * Removes a workspace from the list (Remove from list…, once you've confirmed it): its tasks' agents are stopped, then
 * the workspace and its tasks, with their logs, queues and question sets, go from the database. Nothing on disk is
 * touched: the root folder and its files stay. When it's the workspace the window shows, the window shows none (and
 * no task) until another is opened. Broadcasts `task.deleted` for each of its tasks, then `workspace.removed`. Fails
 * with `not_found` for an unknown id.
 */
export interface WorkspacesRemoveRequest {
  readonly id: string
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

/**
 * A workspace's tasks outside the Done section, which the window loads whole: its active tasks and its pinned ones,
 * whatever their state. The Done section can grow to thousands, so it comes a page at a time (`tasks.listDone`), and
 * this answers only how many it holds (see `src/shared/doneList.ts`).
 */
export type TasksListActiveRequest = TasksListRequest

export interface TasksListActiveResponse {
  /** Its active and pinned tasks, most recently updated first. */
  readonly tasks: readonly Task[]
  /** How many tasks its Done section holds. */
  readonly done: DoneCounts
}

/** A page of a workspace's Done section under a filter chip, starting just after the page before's last task. */
export type TasksListDoneRequest = DonePageRequest

export type TasksListDoneResponse = DonePage

/** Tasks by id, e.g. a done task a search found that the window hasn't loaded a page of yet. */
export interface TasksGetRequest {
  readonly ids: readonly string[]
}

export interface TasksGetResponse {
  /** The ones that exist, in no particular order. */
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
  /** Takes effect from the agent's next tool call, even mid-turn; a request already open stays open. */
  readonly permissionMode?: PermissionMode
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
 * instead), `invalid_request` for images sent as an answer to questions (an answer is words), and `not_found` when
 * there's no such task.
 */
export interface TasksSendRequest {
  readonly id: string
  /** Markdown. Blank only when there are images. */
  readonly text: string
  /**
   * The images pasted into the message, in order: each goes to the agent as an image content block, before the text.
   * None when left out.
   */
  readonly images?: readonly ImageData[]
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

/**
 * Stops one of a task's running subagents (Stop subagent), by the `Agent` tool call that started it, leaving the task's
 * turn running: the call gets its result as though the subagent had finished, and the tool log shows it ended. Answers
 * once the SDK has been asked. Fails with `invalid_transition` for a subagent that isn't running, and `not_found` when
 * there's no such task.
 */
export interface SubagentsStopRequest {
  readonly taskId: string
  /** The `tool_use` id of the `Agent` call that started the subagent. */
  readonly toolUseId: string
}

/**
 * A task's chat log and tool log, each in the order they were appended, its message queue, its questions and its
 * permission requests.
 */
export interface TasksHistoryResponse {
  readonly messages: readonly Message[]
  readonly toolEvents: readonly ToolEvent[]
  /** The messages waiting to be delivered, in the order they will be. */
  readonly queuedMessages: readonly QueuedMessage[]
  /** Every question set the agent asked, open or closed, in the order it asked them. */
  readonly questionSets: readonly QuestionSet[]
  /** Every permission request its agent's tool calls made, open or closed, in the order they were made. */
  readonly permissionRequests: readonly PermissionRequest[]
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
  /** Markdown. Blank only when there are images. */
  readonly text: string
  /** The images pasted into the message, in order, which wait in the queue with it. None when left out. */
  readonly images?: readonly ImageData[]
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

/** Fetches a stored image's bytes by id (`ImageRef.id`), to show it. Fails with `not_found` when there's no such image. */
export interface ImagesGetRequest {
  readonly id: string
}

export interface ImagesGetResponse {
  readonly image: ImageData
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
 * Answers an open permission request (the permission card): Allow once runs the call, and Deny doesn't, telling the
 * agent, with your note if you gave one; either way the agent's turn carries on, and the task is working again unless
 * something else still waits on you. Broadcasts `permission.answered` and `task.updated`.
 *
 * Fails with `not_found` when there's no such request, and `invalid_transition` for one that isn't open any more
 * (answered already, or withdrawn).
 */
export interface PermissionsAnswerRequest {
  /** The permission request's id. */
  readonly id: string
  readonly decision: PermissionDecision
}

export interface PermissionRequestResponse {
  /** The permission request as it now is: allowed or denied. */
  readonly permissionRequest: PermissionRequest
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
 * Copies a text file's contents to the clipboard (an artifact's Copy contents). Fails with `not_found` when there's no
 * such file, and `invalid_request` when it isn't text or is too large to copy.
 */
export type FilesCopyRequest = FileRequest

/**
 * Shows a file in Finder, selected (Reveal in Finder, for a file tab or an artifact). Fails with `not_found` when there's
 * no such file.
 */
export type FilesRevealRequest = FileRequest

/**
 * Takes a file off a task's artifacts (Remove from artifacts); the file itself stays. Broadcasts `artifacts.changed`.
 * Fails with `not_found` when the file isn't one of the task's artifacts.
 */
export interface ArtifactsRemoveRequest {
  readonly taskId: string
  /** Relative to the task's workspace root, as the artifact has it. */
  readonly path: string
}

/** Puts text on the clipboard (the context menus' Copy items). */
export interface ClipboardWriteTextRequest {
  readonly text: string
}

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

/**
 * Searches a workspace's tasks: their titles, objectives, statuses (outcomes once done) and chat messages, yours and
 * the agent's. What you type is plain text, never query syntax (see `src/shared/search.ts`): every word must appear
 * in the same field or message, each matching as a prefix, so results come as you type.
 */
export interface SearchQueryRequest {
  readonly workspaceId: string
  readonly text: string
}

export interface SearchQueryResponse {
  /** One per matching task, best match first; empty when the text has no words. */
  readonly results: readonly SearchResult[]
}

/**
 * The plugins in the plugins folder (`<userData>/plugins`, `docs/plugin-api.md`), which is read again for it, and
 * created if it's missing: each one's manifest and whether it's on, or why it's invalid, in order of folder name. A
 * plugin found for the first time is turned on. Broadcasts `plugins.changed` when the list differs from the last time
 * the folder was read. Settings › Plugins asks for it each time it opens.
 */
export interface PluginsResponse {
  readonly plugins: readonly InstalledPlugin[]
}

/**
 * Turns a plugin on or off; the state is saved, and kept if its folder is removed, in case it comes back. Answers with
 * the plugins as they now are, and broadcasts `plugins.changed`. Fails with `not_found` for a plugin that wasn't valid
 * the last time the folder was read.
 */
export interface PluginsSetEnabledRequest {
  /** The plugin's id (its folder's name). */
  readonly id: string
  readonly enabled: boolean
}

/** Opens the plugins folder in Finder (Open plugins folder), creating it if it's missing. */
export type PluginsOpenFolderRequest = EmptyRequest

/** Where a plugin's view goes in the window, in the page's CSS pixels from its top left: the plugin card's body. */
export interface PluginViewBounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/**
 * Puts the shown plugin's view over the plugin card's body, creating it (and loading the plugin) the first time, or
 * hides it with `bounds: null` while the card's body isn't showing. Only an enabled plugin has a view; one at a time,
 * so placing another destroys the last. Fails with `not_found` for a plugin that isn't enabled.
 */
export interface PluginsPlaceViewRequest {
  /** The plugin's id (its folder's name). */
  readonly id: string
  readonly bounds: PluginViewBounds | null
}

export interface PluginsPlaceViewResponse {
  /** The status the plugin last set for its header; `''` for none. */
  readonly status: string
}

export interface TerminalListResponse {
  /** Every terminal tab, in the tab row's order. */
  readonly tabs: readonly TerminalTab[]
}

/**
 * Adds a terminal tab at the end of the tab row (+, ⌘T), whose shell, your login shell, will start in the workspace's
 * root, or your home folder with none. The shell starts when a window first shows the tab (`terminal.attach`).
 * Broadcasts `terminal.tabsChanged`. Fails with `not_found` for an unknown workspace.
 */
export interface TerminalCreateRequest {
  /** The workspace whose root the shell starts in; null for none. */
  readonly workspaceId: string | null
}

/** `terminal.create` and `terminal.duplicate` answer with the new tab. */
export interface TerminalTabResponse {
  readonly tab: TerminalTab
}

/** Names one terminal tab. Every `terminal.*` command that does fails with `not_found` when there's no such tab. */
export interface TerminalIdRequest {
  readonly id: string
}

/** A terminal's size, in character cells. */
export interface TerminalSizeRequest {
  readonly id: string
  readonly cols: number
  readonly rows: number
}

/**
 * Starts a terminal tab's shell at the terminal's size, if it hasn't started, and answers with the tab's output so far
 * (after a relaunch, its old output and a divider saying processes didn't survive): what a window shows when it first
 * shows the tab. The shell's output from then on arrives as `terminal.output` events.
 */
export type TerminalAttachRequest = TerminalSizeRequest

export interface TerminalAttachResponse {
  /** The tab's recent output, as the terminal received it. */
  readonly output: string
  /** The `offset` the next `terminal.output` event for the tab has: events before it are already in `output`. */
  readonly end: number
}

/**
 * Types into a terminal tab's shell: what you type in the terminal, or paste (Run again in terminal pastes the command,
 * without Enter). What's typed before the shell shows its prompt waits for it.
 */
export interface TerminalWriteRequest {
  readonly id: string
  /** At most `MAX_TERMINAL_WRITE` characters. */
  readonly data: string
}

/** Resizes a terminal tab's terminal, as its window lays it out. */
export type TerminalResizeRequest = TerminalSizeRequest

/** Names a terminal tab (Rename…). Broadcasts `terminal.tabsChanged`. */
export interface TerminalRenameRequest {
  readonly id: string
  /** Not blank; at most `MAX_TERMINAL_NAME` characters. */
  readonly name: string
}

/**
 * Tells main what the menu bar shows (`MenuState`): the window sends it whenever it changes, and main rebuilds the menu
 * bar from it. Choosing one of its items comes back as a `menu.command` event.
 */
export type MenuUpdateRequest = MenuState

/**
 * Closes the focused window (Close, ⌘W, when nothing in it has a tab to close). On macOS the app keeps running, and
 * clicking its Dock icon opens the window again.
 */
export type WindowCloseRequest = EmptyRequest

/** Where in the window an error was caught, for the main log. */
export enum RendererErrorKind {
  /** An uncaught error (`window`'s `error` event). */
  Error = 'error',
  /** A promise rejected with nothing to handle it (`unhandledrejection`). */
  UnhandledRejection = 'unhandled_rejection',
  /** React unmounted the app over an error no error boundary caught. */
  ReactUncaught = 'react_uncaught',
  /** An error boundary caught an error while rendering. */
  ReactCaught = 'react_caught',
  /** React recovered from an error by itself (e.g. by rendering again). */
  ReactRecoverable = 'react_recoverable',
}

/** At most this many characters of a renderer error's message, stack or component stack reach main. */
export const MAX_RENDERER_ERROR_TEXT = 10_000

/**
 * An error in the window, forwarded to the main log (`docs/logs.md`), since the renderer's console goes nowhere once
 * the app is packaged.
 */
export interface LogRendererErrorRequest {
  readonly kind: RendererErrorKind
  readonly message: string
  /** The error's stack; null when it has none (a rejection with a string, say). */
  readonly stack: string | null
  /** React's component stack, for an error React reports; null otherwise. */
  readonly componentStack: string | null
  /** The script and line it came from, for an uncaught error; null otherwise. */
  readonly source: string | null
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
  [CommandName.WorkspacesReveal]: CommandSpec<WorkspacesRevealRequest, null>
  [CommandName.WorkspacesRemove]: CommandSpec<WorkspacesRemoveRequest, null>
  [CommandName.DialogChooseFolder]: CommandSpec<EmptyRequest, DialogChooseFolderResponse>
  [CommandName.TasksList]: CommandSpec<TasksListRequest, TasksListResponse>
  [CommandName.TasksListActive]: CommandSpec<TasksListActiveRequest, TasksListActiveResponse>
  [CommandName.TasksListDone]: CommandSpec<TasksListDoneRequest, TasksListDoneResponse>
  [CommandName.TasksGet]: CommandSpec<TasksGetRequest, TasksGetResponse>
  [CommandName.TasksCreate]: CommandSpec<TasksCreateRequest, TaskResponse>
  [CommandName.TasksMarkDone]: CommandSpec<TaskIdRequest, TaskResponse>
  [CommandName.TasksReopen]: CommandSpec<TaskIdRequest, TaskResponse>
  [CommandName.TasksUpdate]: CommandSpec<TasksUpdateRequest, TaskResponse>
  [CommandName.TasksDelete]: CommandSpec<TasksDeleteRequest, null>
  [CommandName.TasksSend]: CommandSpec<TasksSendRequest, TasksSendResponse>
  [CommandName.TasksStop]: CommandSpec<TasksStopRequest, TaskResponse>
  [CommandName.TasksRetry]: CommandSpec<TasksRetryRequest, TaskResponse>
  [CommandName.TasksCompact]: CommandSpec<TasksCompactRequest, TaskResponse>
  [CommandName.SubagentsStop]: CommandSpec<SubagentsStopRequest, null>
  [CommandName.TasksHistory]: CommandSpec<TaskIdRequest, TasksHistoryResponse>
  [CommandName.QueueAdd]: CommandSpec<QueueAddRequest, QueuedMessageResponse>
  [CommandName.QueueEdit]: CommandSpec<QueueEditRequest, QueuedMessageResponse>
  [CommandName.QueueRemove]: CommandSpec<QueueRemoveRequest, null>
  [CommandName.ImagesGet]: CommandSpec<ImagesGetRequest, ImagesGetResponse>
  [CommandName.QuestionsAnswer]: CommandSpec<QuestionsAnswerRequest, QuestionSetResponse>
  [CommandName.PermissionsAnswer]: CommandSpec<PermissionsAnswerRequest, PermissionRequestResponse>
  [CommandName.FilesRead]: CommandSpec<FilesReadRequest, FilesReadResponse>
  [CommandName.FilesOpen]: CommandSpec<FilesOpenRequest, OpenFilesResponse>
  [CommandName.FilesClose]: CommandSpec<FilesCloseRequest, OpenFilesResponse>
  [CommandName.FilesOpenInEditor]: CommandSpec<FilesOpenInEditorRequest, null>
  [CommandName.ClipboardWriteText]: CommandSpec<ClipboardWriteTextRequest, null>
  [CommandName.FilesInfo]: CommandSpec<FilesInfoRequest, FilesInfoResponse>
  [CommandName.FilesCopy]: CommandSpec<FilesCopyRequest, null>
  [CommandName.FilesReveal]: CommandSpec<FilesRevealRequest, null>
  [CommandName.ArtifactsRemove]: CommandSpec<ArtifactsRemoveRequest, null>
  [CommandName.UiStateGet]: CommandSpec<UiStateGetRequest, UiStateGetResponse>
  [CommandName.UiStateGetAll]: CommandSpec<EmptyRequest, UiStateGetAllResponse>
  [CommandName.UiStateSet]: CommandSpec<UiStateSetRequest, null>
  [CommandName.SettingsGet]: CommandSpec<EmptyRequest, SettingsResponse>
  [CommandName.SettingsUpdate]: CommandSpec<SettingsUpdateRequest, SettingsResponse>
  [CommandName.SearchQuery]: CommandSpec<SearchQueryRequest, SearchQueryResponse>
  [CommandName.PluginsList]: CommandSpec<EmptyRequest, PluginsResponse>
  [CommandName.PluginsSetEnabled]: CommandSpec<PluginsSetEnabledRequest, PluginsResponse>
  [CommandName.PluginsOpenFolder]: CommandSpec<PluginsOpenFolderRequest, null>
  [CommandName.PluginsPlaceView]: CommandSpec<PluginsPlaceViewRequest, PluginsPlaceViewResponse>
  [CommandName.TerminalList]: CommandSpec<EmptyRequest, TerminalListResponse>
  [CommandName.TerminalCreate]: CommandSpec<TerminalCreateRequest, TerminalTabResponse>
  /** Adds a tab after a terminal tab, with its name and folder, and a new shell. Broadcasts `terminal.tabsChanged`. */
  [CommandName.TerminalDuplicate]: CommandSpec<TerminalIdRequest, TerminalTabResponse>
  [CommandName.TerminalAttach]: CommandSpec<TerminalAttachRequest, TerminalAttachResponse>
  [CommandName.TerminalWrite]: CommandSpec<TerminalWriteRequest, null>
  [CommandName.TerminalResize]: CommandSpec<TerminalResizeRequest, null>
  [CommandName.TerminalRename]: CommandSpec<TerminalRenameRequest, null>
  /** Forgets a terminal tab's output (Clear, ⌘K), so a relaunch won't bring it back. Broadcasts `terminal.cleared`. */
  [CommandName.TerminalClear]: CommandSpec<TerminalIdRequest, null>
  /** Sends SIGINT to what's running in a terminal tab's foreground (Kill process, ⌃C). */
  [CommandName.TerminalInterrupt]: CommandSpec<TerminalIdRequest, null>
  /** Ends a terminal tab's shell and removes the tab (Close, ⌘W). Broadcasts `terminal.tabsChanged`. */
  [CommandName.TerminalClose]: CommandSpec<TerminalIdRequest, null>
  [CommandName.MenuUpdate]: CommandSpec<MenuUpdateRequest, null>
  [CommandName.WindowClose]: CommandSpec<EmptyRequest, null>
  /** Writes an error in the window to the main log. */
  [CommandName.LogRendererError]: CommandSpec<LogRendererErrorRequest, null>
}

export type CommandRequest<C extends CommandName> = CommandMap[C]['request']
export type CommandResponse<C extends CommandName> = CommandMap[C]['response']

// Events

export enum EventType {
  UiStateChanged = 'uiState.changed',
  WorkspaceUpdated = 'workspace.updated',
  WorkspaceRemoved = 'workspace.removed',
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
  PermissionOpened = 'permission.opened',
  PermissionAnswered = 'permission.answered',
  PermissionWithdrawn = 'permission.withdrawn',
  OpenFilesChanged = 'openFiles.changed',
  FileShown = 'file.shown',
  TodosChanged = 'todos.changed',
  ArtifactsChanged = 'artifacts.changed',
  TerminalTabsChanged = 'terminal.tabsChanged',
  TerminalOutput = 'terminal.output',
  TerminalCleared = 'terminal.cleared',
  MenuCommand = 'menu.command',
  SettingsChanged = 'settings.changed',
  PluginsChanged = 'plugins.changed',
  PluginStatusChanged = 'plugin.statusChanged',
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

/** A workspace was removed from the list (`workspaces.remove`). Its tasks' `task.deleted` events came first. */
export interface WorkspaceRemovedEvent {
  readonly type: EventType.WorkspaceRemoved
  readonly workspaceId: string
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

/** A tool call of the agent's waits on your OK: the chat shows the request's permission card. */
export interface PermissionOpenedEvent {
  readonly type: EventType.PermissionOpened
  readonly permissionRequest: PermissionRequest
}

/** You allowed or denied a permission request. Carries it as it now is. */
export interface PermissionAnsweredEvent {
  readonly type: EventType.PermissionAnswered
  readonly permissionRequest: PermissionRequest
}

/**
 * A permission request closed without an answer: its turn was stopped, failed or ended, its session closed, or the SDK
 * cancelled the call. The card closes.
 */
export interface PermissionWithdrawnEvent {
  readonly type: EventType.PermissionWithdrawn
  readonly permissionRequest: PermissionRequest
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

/**
 * The terminal tabs changed: one was added, closed or renamed, or what's running in one changed (its running dot and
 * default name). Carries every tab as it now is, in order. A tab whose shell exits closes.
 */
export interface TerminalTabsChangedEvent {
  readonly type: EventType.TerminalTabsChanged
  readonly tabs: readonly TerminalTab[]
}

/** A terminal tab's shell output something. */
export interface TerminalOutputEvent {
  readonly type: EventType.TerminalOutput
  readonly tabId: string
  /** Where `data` starts, counted in characters of everything the tab has output since the app started. */
  readonly offset: number
  readonly data: string
}

/** A terminal tab's output was cleared (Clear, ⌘K): the windows clear its terminal. */
export interface TerminalClearedEvent {
  readonly type: EventType.TerminalCleared
  readonly tabId: string
}

/** You chose a menu bar item, or pressed its key: the window runs its command. */
export interface MenuCommandEvent {
  readonly type: EventType.MenuCommand
  readonly command: Command
}

/** The settings changed. Carries them all as they now are. */
export interface SettingsChangedEvent {
  readonly type: EventType.SettingsChanged
  readonly settings: Settings
}

/**
 * The plugins changed: one was turned on or off, or reading the plugins folder found it changed (a plugin added,
 * removed or edited). Carries them all as they now are.
 */
export interface PluginsChangedEvent {
  readonly type: EventType.PluginsChanged
  readonly plugins: readonly InstalledPlugin[]
}

/** A plugin set the status its panel header shows (`status`, cut to 40 characters), or its view was destroyed (`''`). */
export interface PluginStatusChangedEvent {
  readonly type: EventType.PluginStatusChanged
  /** The plugin's id. */
  readonly id: string
  readonly text: string
}

/** Everything main broadcasts to the windows. */
export type GladeEvent =
  | UiStateChangedEvent
  | WorkspaceUpdatedEvent
  | WorkspaceRemovedEvent
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
  | PermissionOpenedEvent
  | PermissionAnsweredEvent
  | PermissionWithdrawnEvent
  | OpenFilesChangedEvent
  | FileShownEvent
  | TodosChangedEvent
  | ArtifactsChangedEvent
  | TerminalTabsChangedEvent
  | TerminalOutputEvent
  | TerminalClearedEvent
  | MenuCommandEvent
  | SettingsChangedEvent
  | PluginsChangedEvent
  | PluginStatusChangedEvent

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
