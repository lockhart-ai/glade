import { CommandName, isBridgeError, type GladeBridge } from '../../shared/bridge'
import { UiStateKey, type Task, type Workspace } from '../../shared/domain'
import { parseTaskFilter } from '../../shared/attention'
import { DONE_PAGE_SIZE, type DoneCounts } from '../../shared/doneList'
import { withDonePage, withLoadedTasks } from './doneLists'
import { withLiveWatchers, withUiState } from './reducer'
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
 * isn't in the selected workspace. With no workspace selected, shows the most recently opened one, unless the last one
 * shown was closed (Close workspace stores the shown workspace as none); with no workspaces at all, none (the first-run
 * state).
 */
export function restoreSelection(state: GladeData): GladeData {
  const closed = state.uiState[UiStateKey.ActiveWorkspaceId] === ''
  const workspace =
    state.workspaces.find(({ id }) => id === state.selectedWorkspaceId) ??
    (closed ? undefined : lastOpenedWorkspace(state.workspaces))
  const task = state.selectedTaskId === null ? undefined : state.tasks[state.selectedTaskId]
  return {
    ...state,
    selectedWorkspaceId: workspace?.id ?? null,
    selectedTaskId: task !== undefined && task.workspaceId === workspace?.id ? task.id : null,
  }
}

/**
 * Loads main's state: every workspace, each one's tasks outside the Done section and how many are in it, the terminal
 * tabs, every task's live watchers, the UI state, the settings, the models the pickers offer and the account, with the
 * selection restored. The selected task is loaded wherever it is, and the
 * shown workspace's Done section has its first page loaded under the filter chip chosen, so the task list is whole
 * from the first frame.
 */
export async function loadSnapshot(bridge: GladeBridge): Promise<GladeData> {
  const [
    { workspaces },
    { entries },
    { tabs: terminalTabs },
    { settings },
    { watchers },
    { models },
    { status: accountStatus },
  ] = await Promise.all([
    bridge.invoke(CommandName.WorkspacesList, {}),
    bridge.invoke(CommandName.UiStateGetAll, {}),
    bridge.invoke(CommandName.TerminalList, {}),
    bridge.invoke(CommandName.SettingsGet, {}),
    bridge.invoke(CommandName.WatchersListLive, {}),
    bridge.invoke(CommandName.ModelsList, {}),
    bridge.invoke(CommandName.AccountStatus, {}),
  ])
  const lists = await Promise.all(
    workspaces.map((workspace) => bridge.invoke(CommandName.TasksListActive, { workspaceId: workspace.id })),
  )
  const tasks: Record<string, Task> = {}
  const doneCounts: Record<string, DoneCounts> = {}
  for (const [index, list] of lists.entries()) {
    for (const task of list.tasks) tasks[task.id] = task
    const workspace = workspaces[index]
    if (workspace !== undefined) doneCounts[workspace.id] = list.done
  }
  const loaded = entries.reduce(
    withUiState,
    withLiveWatchers(
      {
        ...INITIAL_DATA,
        hydration: { status: HydrationStatus.Ready },
        workspaces,
        tasks,
        doneCounts,
        terminalTabs,
        settings,
        models,
        accountStatus,
      } satisfies GladeData,
      watchers,
    ),
  )
  const selected = loaded.selectedTaskId
  const found =
    selected === null || selected in tasks
      ? loaded
      : withLoadedTasks(loaded, (await bridge.invoke(CommandName.TasksGet, { ids: [selected] })).tasks)
  const restored = restoreSelection(found)
  const workspaceId = restored.selectedWorkspaceId
  if (workspaceId === null) return restored
  const filter = parseTaskFilter(restored.uiState[UiStateKey.TaskFilter])
  const page = await bridge.invoke(CommandName.TasksListDone, {
    workspaceId,
    filter,
    after: null,
    limit: DONE_PAGE_SIZE,
  })
  return withDonePage(restored, workspaceId, filter, page)
}

/** A readable reason for a failed load: a `BridgeError`'s or `Error`'s message, or the value itself. */
export function describeFailure(error: unknown): string {
  if (isBridgeError(error) || error instanceof Error) return error.message
  return String(error)
}
