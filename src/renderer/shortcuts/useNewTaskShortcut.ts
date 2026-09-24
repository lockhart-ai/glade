import { useEffect } from 'react'
import { useNewTask } from '../task-list/useNewTask'

/** Whether the key is ⌘N with no other modifier. */
function isNewTaskKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'n' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

/**
 * ⌘N creates a new task in the workspace, as the + button does, wherever the focus is. Must be used under a
 * `ToastProvider`.
 */
export function useNewTaskShortcut(workspaceId: string): void {
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

export interface NewTaskShortcutProps {
  /** The workspace ⌘N creates tasks in. */
  readonly workspaceId: string
}

/** Turns on ⌘N while a workspace is open. Renders nothing. */
export function NewTaskShortcut({ workspaceId }: NewTaskShortcutProps): null {
  useNewTaskShortcut(workspaceId)
  return null
}
