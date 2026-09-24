import { useEffect } from 'react'
import { useGladeStore } from '../store/react'
import { useNewTask } from '../task-list/useNewTask'

/** Whether the key is ⌘N with no other modifier. */
function isNewTaskKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'n' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

/**
 * ⌘N creates a new task in the selected workspace, as the + button does, wherever the focus is. It does nothing while
 * no workspace is open. Must be used under a `ToastProvider`.
 */
export function useNewTaskShortcut(): void {
  const workspaceId = useGladeStore((state) => state.selectedWorkspaceId)
  const newTask = useNewTask(workspaceId)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isNewTaskKey(event)) return
      event.preventDefault()
      void newTask()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [newTask])
}
