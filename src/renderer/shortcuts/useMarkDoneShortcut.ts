import { useEffect } from 'react'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { canMarkDone } from '../task-header/headerModel'
import { useMarkDone } from '../task-header/useMarkDone'

/** Whether the key is ⌘⇧D with no other modifier. */
function isMarkDoneKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'd' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey
}

/**
 * ⌘⇧D marks the selected task done, as the header's Mark done does, wherever the focus is. It does nothing when the
 * header wouldn't let you: a done or new task, or one whose agent is working. Must be used under a `ToastProvider`.
 */
export function useMarkDoneShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const markDone = useMarkDone()
  const taskId = task !== undefined && canMarkDone(task) ? task.id : null

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isMarkDoneKey(event)) return
      event.preventDefault()
      if (taskId !== null) void markDone(taskId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [taskId, markDone])
}
