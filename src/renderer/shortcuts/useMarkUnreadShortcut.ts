import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useGladeStore } from '../store/react'

/**
 * Mark as unread (⌘⇧U) marks the selected task unread, wherever the focus is. It stays unread while you view it, until
 * you next open it (see `markUnread`). Does nothing when no task is selected, or when it's already unread.
 */
export function useMarkUnreadShortcut(): void {
  const taskId = useGladeStore(({ selectedTaskId, tasks }) =>
    selectedTaskId === null || tasks[selectedTaskId]?.unread !== false ? null : selectedTaskId,
  )
  const markUnread = useGladeStore((state) => state.markUnread)
  useCommand(CommandId.MarkUnread, () => {
    if (taskId !== null) void markUnread(taskId)
  })
}
