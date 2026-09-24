import { EMPTY_MENU_STATE, type MenuState, type MenuTask } from '../../shared/commands'
import { TaskState, type Task } from '../../shared/domain'
import { HydrationStatus, selectSelectedTask, selectSelectedWorkspace, type GladeData } from '../store/state'
import { canMarkDone } from '../task-header/headerModel'
import { renameSection } from '../task-list/useTaskActions'

/** What the Task menu can do to the selected task now: the same as its header, row and shortcuts can. */
function menuTask(state: GladeData, task: Task): MenuTask {
  const done = task.state === TaskState.Done
  return {
    id: task.id,
    pinned: task.pinned,
    canRename: renameSection(state, task.id) !== undefined,
    canMarkUnread: !done && !task.unread,
    canMarkDone: canMarkDone(task),
    canReopen: done,
    canCopyOutcome: done,
  }
}

/**
 * What the menu bar shows for the window's state: every workspace, the one shown and the selected task. With a
 * workspace shown, every panel can be toggled; the first-run window only has the bottom bar. Nothing to act on until
 * the store has loaded.
 */
export function menuStateOf(state: GladeData): MenuState {
  if (state.hydration.status !== HydrationStatus.Ready) return EMPTY_MENU_STATE
  const shown = selectSelectedWorkspace(state)
  const task = shown === undefined ? undefined : selectSelectedTask(state)
  return {
    workspaces: state.workspaces.map(({ id, name }) => ({ id, name })),
    shownWorkspaceId: shown?.id ?? null,
    task: task === undefined ? null : menuTask(state, task),
    panels: { sidebar: shown !== undefined, rightPanel: shown !== undefined, bottomBar: true },
    keyBindings: state.settings.keyBindings,
  }
}
