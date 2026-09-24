import { CommandName, isBridgeError, type GladeBridge } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { withUiState } from './reducer'
import { HydrationStatus, INITIAL_DATA, type GladeData } from './state'

/**
 * Drops a restored selection that no longer points at anything: a workspace that's gone, or a task that's gone or
 * isn't in the selected workspace.
 */
export function restoreSelection(state: GladeData): GladeData {
  const workspace = state.workspaces.find(({ id }) => id === state.selectedWorkspaceId)
  const task = state.selectedTaskId === null ? undefined : state.tasks[state.selectedTaskId]
  return {
    ...state,
    selectedWorkspaceId: workspace?.id ?? null,
    selectedTaskId: task !== undefined && task.workspaceId === workspace?.id ? task.id : null,
  }
}

/** Loads main's state: every workspace, every workspace's tasks and the UI state, with the selection restored. */
export async function loadSnapshot(bridge: GladeBridge): Promise<GladeData> {
  const [{ workspaces }, { entries }] = await Promise.all([
    bridge.invoke(CommandName.WorkspacesList, {}),
    bridge.invoke(CommandName.UiStateGetAll, {}),
  ])
  const lists = await Promise.all(
    workspaces.map((workspace) => bridge.invoke(CommandName.TasksList, { workspaceId: workspace.id })),
  )
  const tasks: Record<string, Task> = {}
  for (const task of lists.flatMap((list) => list.tasks)) tasks[task.id] = task
  const loaded: GladeData = { ...INITIAL_DATA, hydration: { status: HydrationStatus.Ready }, workspaces, tasks }
  return restoreSelection(entries.reduce(withUiState, loaded))
}

/** A readable reason for a failed load: a `BridgeError`'s or `Error`'s message, or the value itself. */
export function describeFailure(error: unknown): string {
  if (isBridgeError(error) || error instanceof Error) return error.message
  return String(error)
}
