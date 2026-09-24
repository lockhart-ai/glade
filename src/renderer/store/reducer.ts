import { EventType, type GladeEvent } from '../../shared/bridge'
import type { TasksHistoryResponse } from '../../shared/bridge'
import {
  UiStateKey,
  type Artifact,
  type EpochMs,
  type Message,
  type QuestionSet,
  type TodoList,
  type ToolEvent,
  type UiStateEntry,
  type Workspace,
} from '../../shared/domain'
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
    // Like the queue, open files change in place: the loaded ones are as new as any event before them.
    openFiles: { ...state.openFiles, [taskId]: history.openFiles },
    // Each change carries the whole list; the one declared in last is the newer.
    artifacts: { ...state.artifacts, [taskId]: newerArtifacts(history.artifacts, state.artifacts[taskId]) },
    todos: { ...state.todos, [taskId]: newerTodos(history.todos, state.todos[taskId]) },
  }
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
 * What `workspaces.open` does, as main broadcasts it: the workspace as it now is, shown, and the selected task
 * deselected if it's in another workspace.
 */
export function withOpenedWorkspace(state: GladeData, workspace: Workspace): GladeData {
  const shown = withUiState(
    { ...state, workspaces: withWorkspace(state.workspaces, workspace) },
    { key: UiStateKey.ActiveWorkspaceId, value: workspace.id },
  )
  const task = shown.selectedTaskId === null ? undefined : shown.tasks[shown.selectedTaskId]
  return task !== undefined && task.workspaceId !== workspace.id
    ? withUiState(shown, { key: UiStateKey.SelectedTaskId, value: '' })
    : shown
}

/** Applies one event from main to the store's state. Pure: returns the next state and leaves `state` alone. */
export function applyEvent(state: GladeData, event: GladeEvent): GladeData {
  switch (event.type) {
    case EventType.UiStateChanged:
      return withUiState(state, event.entry)
    case EventType.WorkspaceUpdated:
      return { ...state, workspaces: withWorkspace(state.workspaces, event.workspace) }
    case EventType.TaskUpdated:
      return { ...state, tasks: { ...state.tasks, [event.task.id]: event.task } }
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
  }
}
