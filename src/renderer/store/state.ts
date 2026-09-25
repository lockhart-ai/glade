/**
 * The shape of the renderer's store: a mirror of main's state, hydrated on launch and kept current by bridge events.
 * Main (and SQLite behind it) stays the source of truth; nothing here is kept only in memory.
 */
import type {
  TaskUserPatch,
  TerminalAttachResponse,
  TerminalClearedEvent,
  TerminalOutputEvent,
  Unsubscribe,
  WorkspaceUserPatch,
} from '../../shared/bridge'
import { DEFAULT_SETTINGS, type Settings, type SettingsPatch } from '../../shared/settings'
import type { SettingsSection } from '../settings/sections'
import type { Command, MenuState } from '../../shared/commands'
import type {
  Artifact,
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
} from '../../shared/domain'
import type { ImageData } from '../../shared/images'
import type { SearchResult } from '../../shared/search'
import type { TerminalTab } from '../../shared/terminal'

export enum HydrationStatus {
  Loading = 'loading',
  Ready = 'ready',
  Failed = 'failed',
}

export interface HydrationLoading {
  readonly status: HydrationStatus.Loading
}

export interface HydrationReady {
  readonly status: HydrationStatus.Ready
}

export interface HydrationFailed {
  readonly status: HydrationStatus.Failed
  /** Why loading from main failed. */
  readonly message: string
}

/** Where the store is in loading its first snapshot from main. */
export type Hydration = HydrationLoading | HydrationReady | HydrationFailed

/** The persisted UI state values that have been set, by key. */
export type UiStateValues = Readonly<Partial<Record<UiStateKey, string>>>

/**
 * A request to show one turn in the tool log, made by a chat reply's tool-call chip and acted on by the tool log.
 * `request` goes up by one with every request, so asking for the same turn again is still a new request.
 */
export interface ToolLogFocus {
  readonly taskId: string
  readonly turn: number
  readonly request: number
}

/**
 * A request to show a file in the Files tab, at a line: made by the agent's `show_file`, and acted on by the Files tab.
 * `request` goes up by one with every request, like `ToolLogFocus`'s.
 */
export interface FileFocus {
  readonly taskId: string
  /** Relative to the task's workspace root. */
  readonly path: string
  /** From 1; null for the top of the file. */
  readonly line: number | null
  readonly request: number
}

/**
 * A request to add text to a task's message field (Quote in reply, Ask agent about this), made by a context menu and
 * acted on by the input bar, which adds it to its draft and focuses the field. `request` goes up by one with every
 * request, like `ToolLogFocus`'s.
 */
export interface InputInsertion {
  readonly taskId: string
  readonly text: string
  readonly request: number
}

/**
 * A request to put text at a terminal tab's prompt (Run again in terminal), made by a tool call's menu and acted on by
 * the tab's terminal, which pastes it without running it and takes the focus. `request` goes up by one with every
 * request, like `ToolLogFocus`'s.
 */
export interface TerminalPaste {
  readonly tabId: string
  readonly text: string
  readonly request: number
}

/** What a terminal tab's terminal hears from main: its output, and that it was cleared. */
export type TerminalEvent = TerminalOutputEvent | TerminalClearedEvent

/** A terminal's size, in character cells. */
export interface TerminalSize {
  readonly cols: number
  readonly rows: number
}

/** Everything the store holds. `applyEvent` maps one of these to the next. */
export interface GladeData {
  readonly hydration: Hydration
  /** Every workspace, oldest first. */
  readonly workspaces: readonly Workspace[]
  /** Every workspace's tasks, by task id. */
  readonly tasks: Readonly<Record<string, Task>>
  readonly selectedWorkspaceId: string | null
  readonly selectedTaskId: string | null
  /** Each task's chat messages, by task id: loaded when the task is selected, then kept current by events. */
  readonly messages: Readonly<Record<string, readonly Message[]>>
  /** Each task's tool log, by task id: loaded when the task is selected, then kept current by events. */
  readonly toolEvents: Readonly<Record<string, readonly ToolEvent[]>>
  /** Each task's message queue, in order, by task id: loaded with its logs, then kept current by events. */
  readonly queuedMessages: Readonly<Record<string, readonly QueuedMessage[]>>
  /**
   * Each task's question sets (`ask`), in the order the agent asked them, by task id: loaded with its logs, then kept
   * current by events.
   */
  readonly questionSets: Readonly<Record<string, readonly QuestionSet[]>>
  /** The files open in each task's Files tab, by task id: loaded with its logs, then kept current by events. */
  readonly openFiles: Readonly<Record<string, OpenFiles>>
  /** Each task's artifacts (the Artifacts tab), by task id: loaded with its logs, then kept current by events. */
  readonly artifacts: Readonly<Record<string, readonly Artifact[]>>
  /**
   * Each task's todo list (the Todos tab), by task id, null when the agent has kept none: loaded with its logs, then
   * kept current by events.
   */
  readonly todos: Readonly<Record<string, TodoList | null>>
  readonly uiState: UiStateValues
  /**
   * The latest request to show a turn in the tool log; null until one is made. A one-off UI intent, so it's the one
   * thing here that isn't mirrored from main: nothing is lost if a relaunch forgets it.
   */
  readonly toolLogFocus: ToolLogFocus | null
  /**
   * How many times something has asked for the input bar's message field to take the focus (a new task, for one); 0
   * until the first. The input bar focuses its field each time this changes. A one-off UI intent, like `toolLogFocus`.
   */
  readonly inputFocusRequest: number
  /**
   * The latest request to show a file in the Files tab (the agent's `show_file`); null until one is made. A one-off UI
   * intent, like `toolLogFocus`: the file it opened is kept in `openFiles`.
   */
  readonly fileFocus: FileFocus | null
  /**
   * The task whose title is being renamed in its task list row (F2); null when none is. A one-off UI intent, like
   * `toolLogFocus`.
   */
  readonly renamingTaskId: string | null
  /** The task Delete task… asks you to confirm deleting; null when it isn't asking. A one-off UI intent. */
  readonly deletingTaskId: string | null
  /** The workspace Remove from list… asks you to confirm removing; null when it isn't asking. A one-off UI intent. */
  readonly removingWorkspaceId: string | null
  /** The app's settings, as main last broadcast them. */
  readonly settings: Settings
  /** The section the Settings modal shows; null while it's closed. A one-off UI intent. */
  readonly settingsSection: SettingsSection | null
  /** The latest request to add text to a task's message field; null until one is made. A one-off UI intent. */
  readonly inputInsertion: InputInsertion | null
  /**
   * What's typed in the sidebar's search field; empty while not searching. While it isn't blank, the sidebar lists the
   * search's results instead of the tasks, and the selected task's header and chat highlight its matches. Not mirrored
   * from main, like `toolLogFocus`: a relaunch starts with no search.
   */
  readonly searchText: string
  /** How many times something has asked for the search field to take the focus (⌘F); 0 until the first. */
  readonly searchFocusRequest: number
  /**
   * How many times a search result has been opened; 0 until the first. The chat scrolls to its first marked match each
   * time this changes, if it's off screen. A one-off UI intent, like `inputFocusRequest`.
   */
  readonly matchRevealRequest: number
  /** Every terminal tab, in the tab row's order: loaded on launch, then kept current by events. */
  readonly terminalTabs: readonly TerminalTab[]
  /** The terminal tab being renamed in the tab row (Rename…); null when none is. A one-off UI intent. */
  readonly renamingTerminalId: string | null
  /**
   * How many times something has asked for the terminal to take the focus (⌃`, a new tab); 0 until the first. The tab
   * showing focuses its terminal each time this changes. A one-off UI intent, like `inputFocusRequest`.
   */
  readonly terminalFocusRequest: number
  /** The latest request to put text at a terminal tab's prompt; null until one is made. A one-off UI intent. */
  readonly terminalPaste: TerminalPaste | null
}

/**
 * What the renderer can do to the store. Every change to UI state is applied at once and written back to main through
 * `uiState.set`. A change to a task is made in main, and reaches the store through main's `task.updated` event. Each
 * action's promise rejects with the `BridgeError` when main refuses the command.
 */
export interface GladeActions {
  /** Subscribes to main's events (once) and loads a fresh snapshot of main's state. Never rejects. */
  hydrate: () => Promise<void>
  /**
   * Adds a workspace rooted at `rootPath` (or finds the one already there) and opens it. Rejects with the
   * `BridgeError` when the root isn't an existing folder.
   */
  createWorkspace: (rootPath: string) => Promise<Workspace>
  /** Asks for a folder with the native dialog, which can also create one. Resolves with its path, or null if cancelled. */
  chooseFolder: () => Promise<string | null>
  /**
   * Renames a workspace or moves it to another root folder (Settings › Workspace). Rejects with the `BridgeError` for a
   * root that isn't a folder or is another workspace's.
   */
  updateWorkspace: (workspaceId: string, patch: WorkspaceUserPatch) => Promise<void>
  /** Changes settings; each saves at once (`settings.update`). */
  updateSettings: (patch: SettingsPatch) => Promise<void>
  /** Opens the Settings modal (⌘,) at a section, or moves it there if it's open. */
  openSettings: (section?: SettingsSection) => void
  /** Closes the Settings modal. */
  closeSettings: () => void
  /**
   * Asks for a folder with the native dialog and adds it as a workspace (or finds the one already there) and opens it:
   * New workspace… and Open folder as workspace…. Resolves with the workspace, or null if the dialog was cancelled.
   */
  addWorkspace: () => Promise<Workspace | null>
  /**
   * Opens a workspace: records it as last opened and shows it, with the task last selected in it (whose logs it loads),
   * or none. This is how you switch workspaces.
   */
  openWorkspace: (workspaceId: string) => Promise<void>
  /** Shows a workspace's root folder in Finder (Reveal root in Finder). */
  revealWorkspace: (workspaceId: string) => Promise<void>
  /**
   * Closes the shown workspace (Close workspace): shows the most recently opened of the others, with its selection, or
   * the first-run window when there's no other. The workspace stays in the list, as do its tasks, and opening it again
   * brings back its selection. Does nothing for a workspace that isn't shown.
   */
  closeWorkspace: (workspaceId: string) => Promise<void>
  /** Asks you to confirm removing a workspace (Remove from list…): see `removingWorkspaceId`. */
  requestRemoveWorkspace: (workspaceId: string) => void
  /** Stops asking: the workspace stays. */
  cancelRemoveWorkspace: () => void
  /**
   * Removes a workspace from the list, once you've confirmed it (`workspaces.remove`): its tasks' agents are stopped,
   * and it and its tasks go from Glade; its folder stays on disk. When it was shown, shows another as closing it would.
   */
  removeWorkspace: (workspaceId: string) => Promise<void>
  /** Closes the window (`window.close`). */
  closeWindow: () => Promise<void>
  /** Tells main what the menu bar shows (`menu.update`). */
  updateMenu: (state: MenuState) => Promise<void>
  /**
   * Calls `listener` with each command main sends from the menu bar (`menu.command`), until unsubscribed. The window
   * runs them (see `src/renderer/commands`).
   */
  onCommand: (listener: (command: Command) => void) => () => void
  /**
   * Selects a task, or none, and loads its chat log and tool log. Selecting a task in another workspace shows that
   * workspace too.
   */
  selectTask: (taskId: string | null) => Promise<void>
  /** Loads a task's chat log and tool log from main. */
  loadHistory: (taskId: string) => Promise<void>
  setUiState: (entry: UiStateEntry) => Promise<void>
  /** Creates an active, empty task in the workspace and selects it. Resolves with the new task. */
  createTask: (workspaceId: string) => Promise<Task>
  /** Marks an active task done. */
  markTaskDone: (taskId: string) => Promise<void>
  /** Reopens a done task. Straight after `markTaskDone`, this is Undo: it restores every field but `updatedAt`. */
  reopenTask: (taskId: string) => Promise<void>
  /** Changes the user's fields of a task: its title, pin, unread flag, model or effort. */
  updateTask: (taskId: string, patch: TaskUserPatch) => Promise<void>
  /**
   * Marks a task unread. The task you're viewing stays unread until you next open it: only opening a task (selecting
   * it) marks it read.
   */
  markUnread: (taskId: string) => Promise<void>
  /** Pins a task, or unpins it (⌘⇧P, or the header's pin toggle). */
  togglePin: (taskId: string) => Promise<void>
  /** Starts renaming a task in its task list row (F2): see `renamingTaskId`. */
  startRename: (taskId: string) => void
  /** Stops renaming, leaving the title as it was. */
  cancelRename: () => void
  /**
   * Renames a task to `title`, trimmed, and stops renaming. Resolves false, and keeps renaming, when the title is blank:
   * a task can't be renamed to nothing. Renaming touches nothing on disk.
   */
  renameTask: (taskId: string, title: string) => Promise<boolean>
  /** Asks you to confirm deleting a task (Delete task…): see `deletingTaskId`. Nothing is deleted until you confirm. */
  requestDelete: (taskId: string) => void
  /** Stops asking: the task stays. */
  cancelDelete: () => void
  /**
   * Deletes a task, once you've confirmed it (`tasks.delete`): its agent is stopped and its rows removed; files on disk
   * are left alone. When it was the selected task, the next task in the list is selected (or the one before, when it
   * was the last), else none.
   */
  deleteTask: (taskId: string) => Promise<void>
  /**
   * Sends the user's message, and the images pasted into it, to the task's agent. Resolves once main has saved it; the
   * message and the turn arrive as events. Rejects with `busy` while the agent is working.
   */
  sendMessage: (taskId: string, text: string, images?: readonly ImageData[]) => Promise<void>
  /**
   * Queues the user's message, and the images pasted into it, for the task's agent, which gets it after its current
   * step. Resolves once main has saved it; the queue arrives as an event.
   */
  queueMessage: (taskId: string, text: string, images?: readonly ImageData[]) => Promise<void>
  /**
   * A stored image's type and bytes, by id (`images.get`), to show it. Each image is fetched once and kept, since an
   * image never changes; one that failed to load is fetched again next time.
   */
  loadImage: (id: string) => Promise<ImageData>
  /**
   * Answers an open question set with the card's answers, keyed by question index (`questions.answer`). Resolves once
   * main has them; the answered set arrives as an event. Rejects with `invalid_request` for answers that don't fit.
   */
  answerQuestions: (id: string, answers: QuestionAnswers) => Promise<void>
  /** Changes a queued message's text. Rejects with `not_found` once it has been delivered or removed. */
  editQueuedMessage: (id: string, text: string) => Promise<void>
  /** Removes a queued message. Rejects with `not_found` once it has been delivered or removed. */
  removeQueuedMessage: (id: string) => Promise<void>
  /**
   * Stops the task's agent: interrupts its running turn. Resolves once the turn has ended; the task, back to waiting on
   * you, arrives as an event. Does nothing when the agent isn't working.
   */
  stopTask: (taskId: string) => Promise<void>
  /** Retries the turn an error stopped, on `model` if given (`tasks.retry`). */
  retryTask: (taskId: string, model?: string) => Promise<void>
  /**
   * Compacts the task's context now (Compact now, ⌘⇧K). Resolves once compaction has started; the task, working while
   * it compacts, and the Compact row arrive as events. Rejects with `busy` while the agent is working.
   */
  compactTask: (taskId: string) => Promise<void>
  /**
   * Asks the tool log to show a task's turn (see `ToolLogFocus`). For the selected task, it also opens the right panel
   * at Tool calls, so the turn shows even when the panel was collapsed or on another tab.
   */
  focusTurn: (taskId: string, turn: number) => void
  /** Asks the input bar to focus its message field (see `inputFocusRequest`). */
  focusInput: () => void
  /** Opens a file in a task's Files tab and shows it (`files.open`). */
  openFile: (taskId: string, path: string) => Promise<void>
  /** Closes a file's tab in a task's Files tab (`files.close`). */
  closeFile: (taskId: string, path: string) => Promise<void>
  /** Reads a file of a task's workspace for the viewer (`files.read`). Not kept in the store: the viewer holds it. */
  readFile: (taskId: string, path: string) => Promise<FileContent>
  /** Opens a file of a task's workspace in the app macOS opens its kind of file with (`files.openInEditor`). */
  openInEditor: (taskId: string, path: string) => Promise<void>
  /** Describes a file of a task's workspace for its artifact card (`files.info`). Not kept in the store. */
  fileInfo: (taskId: string, path: string) => Promise<FileInfo>
  /** Copies a text file of a task's workspace to the clipboard (`files.copy`). */
  copyFile: (taskId: string, path: string) => Promise<void>
  /** Shows a file of a task's workspace in Finder, selected in its folder (`files.reveal`). */
  revealFile: (taskId: string, path: string) => Promise<void>
  /**
   * Opens a file in a task's Files tab and shows it there (a tool call's Open file): for the selected task, the right
   * panel opens at Files too, even when it was collapsed or on another tab.
   */
  showFile: (taskId: string, path: string) => Promise<void>
  /** Takes a file off a task's artifacts (`artifacts.remove`); the file stays. */
  removeArtifact: (taskId: string, path: string) => Promise<void>
  /** Stops one of a task's running subagents, by the `Agent` call that started it (`subagents.stop`). */
  stopSubagent: (taskId: string, toolUseId: string) => Promise<void>
  /** Puts text on the clipboard (`clipboard.writeText`). */
  copyText: (text: string) => Promise<void>
  /** Asks the input bar to add text to a task's message field and focus it (see `inputInsertion`). */
  insertIntoInput: (taskId: string, text: string) => void
  /** Sets the sidebar's search text (see `searchText`); an empty string ends the search. */
  setSearchText: (text: string) => void
  /** Asks the sidebar's search field to take the focus (see `searchFocusRequest`). */
  focusSearch: () => void
  /** Searches a workspace's tasks (`search.query`): one result per matching task, best first. */
  searchTasks: (workspaceId: string, text: string) => Promise<readonly SearchResult[]>
  /** Opens a search result: selects its task, loads its logs, then asks the chat to show the first match. */
  openSearchResult: (taskId: string) => Promise<void>
  /**
   * Adds a terminal tab at the end whose shell starts in the root of the workspace you're looking at (your home folder
   * with none), and shows it, opening the bottom bar if it's collapsed, with the focus in it. Resolves with the tab.
   */
  createTerminal: () => Promise<TerminalTab>
  /** Shows a terminal tab, with the focus in it. */
  selectTerminal: (tabId: string) => Promise<void>
  /** Shows the next terminal tab (1) or the one before (-1), going round. */
  cycleTerminal: (step: 1 | -1) => Promise<void>
  /** Adds a tab after a terminal tab, with its name and folder, and shows it (Duplicate). */
  duplicateTerminal: (tabId: string) => Promise<void>
  /** Ends a terminal tab's shell and closes it; closing the tab showing shows the next (or the one before). */
  closeTerminal: (tabId: string) => Promise<void>
  /** Starts renaming a terminal tab in the tab row: see `renamingTerminalId`. */
  startTerminalRename: (tabId: string) => void
  /** Stops renaming, leaving the name as it was. */
  cancelTerminalRename: () => void
  /** Names a terminal tab and stops renaming. Resolves false, and keeps renaming, when the name is blank. */
  renameTerminal: (tabId: string, name: string) => Promise<boolean>
  /** Clears a terminal tab's output (⌘K), here and in what a relaunch restores. */
  clearTerminal: (tabId: string) => Promise<void>
  /** Sends SIGINT to what's running in a terminal tab (Kill process). */
  interruptTerminal: (tabId: string) => Promise<void>
  /** Starts a terminal tab's shell, if it hasn't, at `size`, and loads its output so far. */
  attachTerminal: (tabId: string, size: TerminalSize) => Promise<TerminalAttachResponse>
  /** Types into a terminal tab's shell. */
  writeTerminal: (tabId: string, data: string) => Promise<void>
  resizeTerminal: (tabId: string, size: TerminalSize) => Promise<void>
  /** Calls `listener` with a terminal tab's output, and when it's cleared, until unsubscribed. */
  subscribeTerminal: (tabId: string, listener: (event: TerminalEvent) => void) => Unsubscribe
  /**
   * Asks for the terminal to take the focus (⌃`): opens the bottom bar if it's collapsed, and adds a tab if there's
   * none (see `terminalFocusRequest`).
   */
  focusTerminal: () => Promise<void>
  /**
   * Puts a command at the prompt of the terminal tab showing, or of a new tab when there's none, without running it
   * (Run again in terminal): opens the bottom bar if it's collapsed (see `terminalPaste`).
   */
  runInTerminal: (command: string) => Promise<void>
  /** Marks a request to put text at a terminal's prompt as done, once the terminal has pasted it. */
  takeTerminalPaste: (request: number) => void
}

export interface GladeState extends GladeData, GladeActions {}

export const INITIAL_DATA: GladeData = {
  hydration: { status: HydrationStatus.Loading },
  workspaces: [],
  tasks: {},
  selectedWorkspaceId: null,
  selectedTaskId: null,
  messages: {},
  toolEvents: {},
  queuedMessages: {},
  questionSets: {},
  openFiles: {},
  artifacts: {},
  todos: {},
  uiState: {},
  toolLogFocus: null,
  inputFocusRequest: 0,
  fileFocus: null,
  renamingTaskId: null,
  deletingTaskId: null,
  removingWorkspaceId: null,
  settings: DEFAULT_SETTINGS,
  settingsSection: null,
  inputInsertion: null,
  searchText: '',
  searchFocusRequest: 0,
  matchRevealRequest: 0,
  terminalTabs: [],
  renamingTerminalId: null,
  terminalFocusRequest: 0,
  terminalPaste: null,
}

export function selectSelectedWorkspace(state: GladeData): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
}

export function selectSelectedTask(state: GladeData): Task | undefined {
  return state.selectedTaskId === null ? undefined : state.tasks[state.selectedTaskId]
}
