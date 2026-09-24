import { useEffect } from 'react'
import { useGladeStore } from '../store/react'

/** Whether the key is ⌘⇧U with no other modifier. */
function isMarkUnreadKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'u' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey
}

/**
 * ⌘⇧U marks the selected task unread, wherever the focus is. It stays unread while you view it, until you next open it
 * (see `markUnread`). Does nothing when no task is selected, or when it's already unread.
 */
export function useMarkUnreadShortcut(): void {
  const taskId = useGladeStore(({ selectedTaskId, tasks }) =>
    selectedTaskId === null || tasks[selectedTaskId]?.unread !== false ? null : selectedTaskId,
  )
  const markUnread = useGladeStore((state) => state.markUnread)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isMarkUnreadKey(event)) return
      event.preventDefault()
      if (taskId !== null) void markUnread(taskId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [taskId, markUnread])
}
