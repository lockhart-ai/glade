import { EventType, type GladeEvent } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry, type Workspace } from '../../shared/domain'
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
  }
}

function withWorkspace(workspaces: readonly Workspace[], workspace: Workspace): readonly Workspace[] {
  return workspaces.some(({ id }) => id === workspace.id)
    ? workspaces.map((existing) => (existing.id === workspace.id ? workspace : existing))
    : [...workspaces, workspace]
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
  }
}
