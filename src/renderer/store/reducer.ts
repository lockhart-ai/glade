import { EventType, type GladeEvent } from '../../shared/bridge'
import type { TasksHistoryResponse } from '../../shared/bridge'
import {
  UiStateKey,
  type Artifact,
  type TaskHandoff,
  type EpochMs,
  type Message,
  type PermissionRequest,
  type QuestionSet,
  type TodoList,
  type ToolEvent,
  type UiStateEntry,
  type Workspace,
} from '../../shared/domain'
import { withCountedChange, withoutDoneLists } from './doneLists'
import type { GladeData } from './state'

/** A stored selection id: the empty string means nothing is selected. */
export function idFromUiState(value: string): string | null {
  return value === '' ? null : value
}

/** Records a UI state value, and the selection it holds. */
export function withUiState(state: GladeData, entry: UiStateEntry): GladeData {
  const next = { ...state, uiState: { ...state.uiState, [entry.key]: entry.value } }
  switch (entry.key) {
    case UiStateKey.ActiveWorkspaceId:
      return { ...next, selectedWorkspaceId: idFromUiState(entry.value) }
    case UiStateKey.SelectedTaskId:
      return { ...next, selectedTaskId: idFromUiState(entry.value) }
    case UiStateKey.PinnedSectionCollapsed:
    case UiStateKey.ActiveSectionCollapsed:
    case UiStateKey.DoneSectionCollapsed:
    case UiStateKey.TaskFilter:
    case UiStateKey.RelaunchNotice:
    case UiStateKey.RightPanelTab:
    case UiStateKey.RightPanelWidth:
    case UiStateKey.RightPanelCollapsed:
    case UiStateKey.SidebarCollapsed:
    case UiStateKey.SidebarWidth:
    case UiStateKey.BottomBarCollapsed:
    case UiStateKey.BottomBarHeight:
    case UiStateKey.PluginWidth:
    case UiStateKey.TerminalTab:
      return next
  }
}

function withWorkspace(workspaces: readonly Workspace[], workspace: Workspace): readonly Workspace[] {
  return workspaces.some(({ id }) => id === workspace.id)
    ? workspaces.map((existing) => (existing.id === workspace.id ? workspace : existing))
    : [...workspaces, workspace]
}

/** Something appended to a task's log, identified by its id. */
interface LogEntry {
  readonly id: string
  readonly taskId: string
}

type LogsByTask<T> = Readonly<Record<string, readonly T[]>>

/** Appends an entry to its task's log, unless the log already has it. */
function withAppended<T extends LogEntry>(logs: LogsByTask<T>, entry: T): LogsByTask<T> {
  const log = logs[entry.taskId] ?? []
  return log.some(({ id }) => id === entry.id) ? logs : { ...logs, [entry.taskId]: [...log, entry] }
}

/** Replaces an entry in its task's log. An entry the log doesn't have is left to the next history load. */
function withReplaced<T extends LogEntry>(logs: LogsByTask<T>, entry: T): LogsByTask<T> {
  const log = logs[entry.taskId]
  if (log?.some(({ id }) => id === entry.id) !== true) return logs
  return { ...logs, [entry.taskId]: log.map((existing) => (existing.id === entry.id ? entry : existing)) }
}

/** A task's loaded log, followed by any entries events brought that the load didn't have yet. */
function merged<T extends LogEntry>(loaded: readonly T[], current: readonly T[] = []): readonly T[] {
  const ids = new Set(loaded.map(({ id }) => id))
  return [...loaded, ...current.filter(({ id }) => !ids.has(id))]
}

/** Records a task's chat log and tool log as loaded from main, keeping anything newer events already brought. */
export function withHistory(state: GladeData, taskId: string, history: TasksHistoryResponse): GladeData {
  return {
    ...state,
    messages: { ...state.messages, [taskId]: merged<Message>(history.messages, state.messages[taskId]) },
    toolEvents: { ...state.toolEvents, [taskId]: merged<ToolEvent>(history.toolEvents, state.toolEvents[taskId]) },
    // The queue changes in place, so events can't be merged into it: the loaded one is as new as any event before it.
    queuedMessages: { ...state.queuedMessages, [taskId]: history.queuedMessages },
    questionSets: {
      ...state.questionSets,
      [taskId]: merged<QuestionSet>(history.questionSets, state.questionSets[taskId]),
    },
    permissionRequests: {
      ...state.permissionRequests,
      [taskId]: merged<PermissionRequest>(history.permissionRequests, state.permissionRequests[taskId]),
    },
    // Like the queue, open files change in place: the loaded ones are as new as any event before them.
    openFiles: { ...state.openFiles, [taskId]: history.openFiles },
    // Each change carries the whole list; the one declared in last is the newer.
    artifacts: { ...state.artifacts, [taskId]: newerArtifacts(history.artifacts, state.artifacts[taskId]) },
    todos: { ...state.todos, [taskId]: newerTodos(history.todos, state.todos[taskId]) },
    handoffs: { ...state.handoffs, [taskId]: newerHandoff(history.handoff, state.handoffs[taskId]) },
  }
}

/** The loaded handoff note, unless an event already brought one set after it. */
function newerHandoff(loaded: TaskHandoff | null, current: TaskHandoff | null | undefined): TaskHandoff | null {
  return loaded !== null && current != null && current.addedAt > loaded.addedAt ? current : loaded
}

/** The loaded todo list, unless an event already brought a newer one. */
function newerTodos(loaded: TodoList | null, current: TodoList | null | undefined): TodoList | null {
  if (current === undefined || current === null) return loaded
  return loaded === null || current.updatedAt > loaded.updatedAt ? current : loaded
}

/** When a task's artifacts last changed: the latest time one was declared. */
function lastDeclared(artifacts: readonly Artifact[]): EpochMs {
  return artifacts.reduce((latest, artifact) => Math.max(latest, artifact.updatedAt), 0)
}

/** The loaded artifacts, unless an event already brought newer ones. */
function newerArtifacts(loaded: readonly Artifact[], current: readonly Artifact[] | undefined): readonly Artifact[] {
  return current !== undefined && lastDeclared(current) > lastDeclared(loaded) ? current : loaded
}

/**
 * What `workspaces.open` does, as main broadcasts it: the workspace as it now is, shown, with the task main selected
 * in it (the one last selected there), or none.
 */
export function withOpenedWorkspace(state: GladeData, workspace: Workspace, selectedTaskId: string | null): GladeData {
  const shown = withUiState(
    { ...state, workspaces: withWorkspace(state.workspaces, workspace) },
    { key: UiStateKey.ActiveWorkspaceId, value: workspace.id },
  )
  return shown.selectedTaskId === selectedTaskId
    ? shown
    : withUiState(shown, { key: UiStateKey.SelectedTaskId, value: selectedTaskId ?? '' })
}

/** Drops what the store keeps for one task. */
function without<T>(byTask: Readonly<Record<string, T>>, taskId: string): Readonly<Record<string, T>> {
  return taskId in byTask ? Object.fromEntries(Object.entries(byTask).filter(([id]) => id !== taskId)) : byTask
}

/**
 * Forgets a deleted task: the task, its logs, queue, question sets, permission requests, todos and open files, and any
 * intent that names it.
 */
export function withoutTask(state: GladeData, taskId: string): GladeData {
  return {
    ...state,
    tasks: without(state.tasks, taskId),
    messages: without(state.messages, taskId),
    toolEvents: without(state.toolEvents, taskId),
    queuedMessages: without(state.queuedMessages, taskId),
    questionSets: without(state.questionSets, taskId),
    permissionRequests: without(state.permissionRequests, taskId),
    todos: without(state.todos, taskId),
    openFiles: without(state.openFiles, taskId),
    artifacts: without(state.artifacts, taskId),
    handoffs: without(state.handoffs, taskId),
    fileFocus: state.fileFocus?.taskId === taskId ? null : state.fileFocus,
    toolLogFocus: state.toolLogFocus?.taskId === taskId ? null : state.toolLogFocus,
    renamingTaskId: state.renamingTaskId === taskId ? null : state.renamingTaskId,
    deletingTaskId: state.deletingTaskId === taskId ? null : state.deletingTaskId,
  }
}

/**
 * Forgets a removed workspace: it, and each of its tasks as `withoutTask` forgets one (main sends their `task.deleted`
 * first, but a task the store has is never left without its workspace), and any intent that names it.
 */
export function withoutWorkspace(state: GladeData, workspaceId: string): GladeData {
  const tasks = Object.values(state.tasks).filter((task) => task.workspaceId === workspaceId)
  const forgotten = withoutDoneLists(
    tasks.reduce((next, task) => withoutTask(next, task.id), state),
    workspaceId,
  )
  return {
    ...forgotten,
    workspaces: state.workspaces.filter(({ id }) => id !== workspaceId),
    removingWorkspaceId: state.removingWorkspaceId === workspaceId ? null : state.removingWorkspaceId,
  }
}

/** Applies one event from main to the store's state. Pure: returns the next state and leaves `state` alone. */
export function applyEvent(state: GladeData, event: GladeEvent): GladeData {
  switch (event.type) {
    case EventType.UiStateChanged:
      return withUiState(state, event.entry)
    case EventType.WorkspaceUpdated:
      return { ...state, workspaces: withWorkspace(state.workspaces, event.workspace) }
    case EventType.WorkspaceRemoved:
      return withoutWorkspace(state, event.workspaceId)
    case EventType.TaskUpdated: {
      const counted = withCountedChange(state, state.tasks[event.task.id], event.task)
      return { ...counted, tasks: { ...counted.tasks, [event.task.id]: event.task } }
    }
    case EventType.TaskDeleted:
      return withoutTask(withCountedChange(state, state.tasks[event.taskId], undefined), event.taskId)
    case EventType.MessageAppended:
      return { ...state, messages: withAppended(state.messages, event.message) }
    case EventType.ToolEventAppended:
      return { ...state, toolEvents: withAppended(state.toolEvents, event.toolEvent) }
    case EventType.ToolEventUpdated:
      return { ...state, toolEvents: withReplaced(state.toolEvents, event.toolEvent) }
    case EventType.TaskOpenRequested:
      // Opening a task is an action, not a change of state: the store selects it (see `./store`).
      return state
    case EventType.QueueChanged:
      return { ...state, queuedMessages: { ...state.queuedMessages, [event.taskId]: event.queuedMessages } }
    case EventType.QuestionOpened:
      return { ...state, questionSets: withAppended(state.questionSets, event.questionSet) }
    case EventType.QuestionAnswered:
    case EventType.QuestionWithdrawn:
      return { ...state, questionSets: withReplaced(state.questionSets, event.questionSet) }
    case EventType.PermissionOpened:
      return { ...state, permissionRequests: withAppended(state.permissionRequests, event.permissionRequest) }
    case EventType.PermissionAnswered:
    case EventType.PermissionWithdrawn:
      return { ...state, permissionRequests: withReplaced(state.permissionRequests, event.permissionRequest) }
    case EventType.OpenFilesChanged:
      return { ...state, openFiles: { ...state.openFiles, [event.openFiles.taskId]: event.openFiles } }
    case EventType.FileShown: {
      const { taskId, path, line } = event
      return { ...state, fileFocus: { taskId, path, line, request: (state.fileFocus?.request ?? 0) + 1 } }
    }
    case EventType.TodosChanged:
      return { ...state, todos: { ...state.todos, [event.taskId]: event.todos } }
    case EventType.ArtifactsChanged:
      return { ...state, artifacts: { ...state.artifacts, [event.taskId]: event.artifacts } }
    case EventType.HandoffChanged:
      return { ...state, handoffs: { ...state.handoffs, [event.taskId]: event.handoff } }
    case EventType.TerminalTabsChanged: {
      const { renamingTerminalId } = state
      const renaming = event.tabs.some(({ id }) => id === renamingTerminalId) ? renamingTerminalId : null
      return { ...state, terminalTabs: event.tabs, renamingTerminalId: renaming }
    }
    case EventType.TerminalOutput:
    case EventType.TerminalCleared:
      // A terminal's output goes straight to its terminal (see `subscribeTerminal` in `./store`), not into the store.
      return state
    case EventType.MenuCommand:
      // Running a command is an action, not a change of state: the window runs it (see `./store`).
      return state
    case EventType.SettingsChanged:
      return { ...state, settings: event.settings }
    case EventType.PluginsChanged:
      return { ...state, plugins: event.plugins }
    case EventType.PluginStatusChanged:
      return { ...state, pluginStatuses: { ...state.pluginStatuses, [event.id]: event.text } }
  }
}
