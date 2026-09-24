/**
 * The unread rule (`docs/product.md`, "Attention"): a task becomes unread when its agent posts a reply while you aren't
 * viewing it, and opening it makes it read again.
 *
 * "Viewing" is the selected task, which the window persists as the `SelectedTaskId` UI state. Main writes that value and
 * the agent's replies one at a time, so a reply is always judged against the selection as it stood when it arrived:
 * the selected task never becomes unread, and a task you switch away from mid-turn does.
 *
 * Opening a task is selecting it: each `uiState.set` of `SelectedTaskId` to a task (clicking its row, ⌥↑ / ⌥↓, a new
 * task) marks it read. Marking a task unread (⌘⇧U) doesn't select it, so the task you're viewing stays unread until
 * you next open it. A relaunch restores the selection without opening anything, so it clears nothing.
 *
 * The same replies, the ones in a task you aren't viewing, send a native notification (`../notifications`).
 */
import { EventType } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { getTask } from '../db/repositories/tasks'
import { getUiState, setUiState } from '../db/repositories/ui-state'
import { noteSelection } from '../workspaces/workspaces'
import { setTaskUnread, type TaskServiceContext } from './service'

/**
 * The agent posted a reply in a task: it becomes unread unless it's the task being viewed. Returns whether it wasn't
 * being viewed, so the reply needs a notification.
 */
export function noteAgentReply(context: TaskServiceContext, taskId: string): boolean {
  if (getUiState(context.db, UiStateKey.SelectedTaskId) === taskId) return false
  if (getTask(context.db, taskId)?.unread === false) setTaskUnread(context, taskId, true)
  return true
}

/** A UI state value was just stored: if it selected a task, that task has been opened, so it's read. */
export function noteUiStateSet(context: TaskServiceContext, entry: UiStateEntry): void {
  if (entry.key !== UiStateKey.SelectedTaskId) return
  if (getTask(context.db, entry.value)?.unread === true) setTaskUnread(context, entry.value, false)
}

/**
 * Opens a task from main, for when there's no window to do it (its notification was clicked with every window closed):
 * stores the selection that clicking its row would, its workspace and then the task, so it's read, and the next window
 * opens on it. Does nothing for a task that doesn't exist.
 */
export function openTaskWithoutWindow(context: TaskServiceContext, taskId: string): void {
  const task = getTask(context.db, taskId)
  if (task === undefined) return
  const entries: UiStateEntry[] = [
    { key: UiStateKey.ActiveWorkspaceId, value: task.workspaceId },
    { key: UiStateKey.SelectedTaskId, value: task.id },
  ]
  for (const entry of entries) {
    noteSelection(context.db, entry)
    setUiState(context.db, entry)
    context.emit({ type: EventType.UiStateChanged, entry })
    noteUiStateSet(context, entry)
  }
}
