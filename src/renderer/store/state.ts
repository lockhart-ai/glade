/**
 * The shape of the renderer's store: a mirror of main's state, hydrated on launch and kept current by bridge events.
 * Main (and SQLite behind it) stays the source of truth; nothing here is kept only in memory.
 */
import type { TaskUserPatch } from '../../shared/bridge'
import type { Message, Task, ToolEvent, UiStateEntry, UiStateKey, Workspace } from '../../shared/domain'

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
   * Sends the user's message to the task's agent. Resolves once main has saved it; the message and the turn arrive as
   * events. Rejects with `busy` while the agent is working.
   */
  sendMessage: (taskId: string, text: string) => Promise<void>
  /**
   * Stops the task's agent: interrupts its running turn. Resolves once the turn has ended; the task, back to waiting on
   * you, arrives as an event. Does nothing when the agent isn't working.
   */
  stopTask: (taskId: string) => Promise<void>
  /** Asks the tool log to show a task's turn (see `ToolLogFocus`). */
  focusTurn: (taskId: string, turn: number) => void
  /** Asks the input bar to focus its message field (see `inputFocusRequest`). */
  focusInput: () => void
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
  uiState: {},
  toolLogFocus: null,
  inputFocusRequest: 0,
}

export function selectSelectedWorkspace(state: GladeData): Workspace | undefined {
  return state.workspaces.find((workspace) => workspace.id === state.selectedWorkspaceId)
}

export function selectSelectedTask(state: GladeData): Task | undefined {
  return state.selectedTaskId === null ? undefined : state.tasks[state.selectedTaskId]
}
