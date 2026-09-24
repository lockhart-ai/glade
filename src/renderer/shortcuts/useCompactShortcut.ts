import { useEffect } from 'react'
import { canCompact, useCompact } from '../context-meter/compact'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'

/** Whether the key is ⌘⇧K with no other modifier. */
function isCompactKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'k' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey
}

/**
 * ⌘⇧K compacts the selected task's context, as the context meter's Compact now does, wherever the focus is. It does
 * nothing when Compact now is off: a done task, one whose agent is working, or one with no session yet. Must be used
 * under a `ToastProvider`.
 */
export function useCompactShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const compact = useCompact()
  const taskId = task !== undefined && canCompact(task) ? task.id : null

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isCompactKey(event)) return
      event.preventDefault()
      if (taskId !== null) void compact(taskId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [taskId, compact])
}
