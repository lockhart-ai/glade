import { useEffect } from 'react'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** Whether the key is ⌘⇧P with no other modifier. */
function isPinKey(event: KeyboardEvent): boolean {
  return event.key.toLowerCase() === 'p' && event.metaKey && event.shiftKey && !event.altKey && !event.ctrlKey
}

/** ⌘⇧P pins the selected task, or unpins it, wherever the focus is. Does nothing when no task is selected. */
export function usePinShortcut(): void {
  const taskId = useGladeStore(({ selectedTaskId, tasks }) =>
    selectedTaskId !== null && selectedTaskId in tasks ? selectedTaskId : null,
  )
  const togglePin = useGladeStore((state) => state.togglePin)
  const toast = useToast()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isPinKey(event)) return
      event.preventDefault()
      if (taskId === null) return
      togglePin(taskId).catch((error: unknown) => {
        toast.show({ message: describeFailure(error) })
      })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [taskId, togglePin, toast])
}
