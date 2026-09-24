import { CommandName, isBridgeError, type GladeBridge } from '../../shared/bridge'
import type { Task, Workspace } from '../../shared/domain'
import { withUiState } from './reducer'
import { HydrationStatus, INITIAL_DATA, type GladeData } from './state'

/** The most recently opened workspace (the oldest of a tie), or undefined when there are none. */
export function lastOpenedWorkspace(workspaces: readonly Workspace[]): Workspace | undefined {
  return workspaces.reduce<Workspace | undefined>(
    (latest, workspace) => (latest === undefined || workspace.lastOpenedAt > latest.lastOpenedAt ? workspace : latest),
    undefined,
  )
}

/**
 * Drops a restored selection that no longer points at anything: a workspace that's gone, or a task that's gone or
 * isn't in the selected workspace. With no workspace selected, shows the most recently opened one; with no workspaces
 * at all, none (the first-run state).
 */
export function restoreSelection(state: GladeData): GladeData {
  const workspace =
    state.workspaces.find(({ id }) => id === state.selectedWorkspaceId) ?? lastOpenedWorkspace(state.workspaces)
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
