/**
 * The shape of the renderer's store: a mirror of main's state, hydrated on launch and kept current by bridge events.
 * Main (and SQLite behind it) stays the source of truth; nothing here is kept only in memory.
 */
import type { TaskUserPatch } from '../../shared/bridge'
import type {
  FileContent,
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
import type { SearchResult } from '../../shared/search'

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
  /**
   * What's typed in the sidebar's search field; empty while not searching. While it isn't blank, the sidebar lists the
   * search's results instead of the tasks, and the selected task's header and chat highlight its matches. Not mirrored
   * from main, like `toolLogFocus`: a relaunch starts with no search.
   */
  readonly searchText: string
  /** How many times something has asked for the search field to take the focus (⌘F); 0 until the first. */
  readonly searchFocusRequest: number
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
  /** Opens a workspace: records it as last opened and shows it, deselecting a task in another workspace. */
  openWorkspace: (workspaceId: string) => Promise<void>
  /** Shows a workspace, or none. Deselects the selected task if it's in another workspace. */
  selectWorkspace: (workspaceId: string | null) => Promise<void>
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
   * Sends the user's message to the task's agent. Resolves once main has saved it; the message and the turn arrive as
   * events. Rejects with `busy` while the agent is working.
   */
  sendMessage: (taskId: string, text: string) => Promise<void>
  /**
   * Queues the user's message for the task's agent, which gets it after its current step. Resolves once main has
   * saved it; the queue arrives as an event.
   */
  queueMessage: (taskId: string, text: string) => Promise<void>
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
  /** Sets the sidebar's search text (see `searchText`); an empty string ends the search. */
  setSearchText: (text: string) => void
  /** Asks the sidebar's search field to take the focus (see `searchFocusRequest`). */
  focusSearch: () => void
  /** Searches a workspace's tasks (`search.query`): one result per matching task, best first. */
  searchTasks: (workspaceId: string, text: string) => Promise<readonly SearchResult[]>
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
  todos: {},
  uiState: {},
  toolLogFocus: null,
  inputFocusRequest: 0,
  fileFocus: null,
  renamingTaskId: null,
  deletingTaskId: null,
  searchText: '',
  searchFocusRequest: 0,
}

export function selectSelectedWorkspace(state: GladeData): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
}

export function selectSelectedTask(state: GladeData): Task | undefined {
  return state.selectedTaskId === null ? undefined : state.tasks[state.selectedTaskId]
}
