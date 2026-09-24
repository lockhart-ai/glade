import { useEffect } from 'react'
import { TaskActivity } from '../../shared/domain'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'

/** Whether the key is ⌘. with no other modifier. */
function isStopKey(event: KeyboardEvent): boolean {
  return event.key === '.' && event.metaKey && !event.altKey && !event.ctrlKey && !event.shiftKey
}

/**
 * ⌘. stops the selected task's agent while it's working, wherever the focus is (typing in the input bar included).
 * A failure to stop shows as a toast. Must be used under a `ToastProvider`.
 */
export function useStopShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const stopTask = useGladeStore((state) => state.stopTask)
  const toast = useToast()
  const workingTaskId = task?.activity === TaskActivity.Working ? task.id : null

  useEffect(() => {
    const stop = async (taskId: string): Promise<void> => {
      try {
        await stopTask(taskId)
      } catch (error) {
        toast.show({ message: describeFailure(error) })
      }
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isStopKey(event)) return
      event.preventDefault()
      if (workingTaskId !== null) void stop(workingTaskId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [workingTaskId, stopTask, toast])
}
