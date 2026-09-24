import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { useCallback } from 'react'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** What the toast says once a task is marked done, from docs/design/html/05-mark-done.html. */
export const MARKED_DONE_MESSAGE = 'Marked done. The latest status is kept as the outcome.'

/** The toast's button that puts the task back as it was. */
export const UNDO_LABEL = 'Undo'

/**
 * Marks a task done with no dialog, then shows a toast with Undo for a few seconds. Undo reopens the task, which
 * restores every field but `updatedAt`. A failure either way shows as a toast. Must be used under a `ToastProvider`.
 */
export function useMarkDone(): (taskId: string) => Promise<void> {
  const markTaskDone = useGladeStore((state) => state.markTaskDone)
  const reopenTask = useGladeStore((state) => state.reopenTask)
  const toast = useToast()

  return useCallback(
    async (taskId: string): Promise<void> => {
      const undo = async (): Promise<void> => {
        try {
          await reopenTask(taskId)
        } catch (error) {
          toast.show({ message: describeFailure(error) })
        }
      }
      try {
        await markTaskDone(taskId)
      } catch (error) {
        toast.show({ message: describeFailure(error) })
        return
      }
      toast.show({
        message: MARKED_DONE_MESSAGE,
        icon: faCheck,
        action: { label: UNDO_LABEL, onAction: () => void undo() },
      })
    },
    [markTaskDone, reopenTask, toast],
  )
}
