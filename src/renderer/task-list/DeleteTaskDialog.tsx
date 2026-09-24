import { ConfirmDialog, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'
import { UNTITLED } from './TaskRow'

/** What the confirmation says deleting does, and what it leaves alone (`docs/decisions.md`). */
export const DELETE_TASK_MESSAGE =
  "Its chat, tool log and queued messages are removed from Glade, and its agent is stopped. Files on disk aren't touched."

/** The question the confirmation asks about a task. */
export function deleteTaskQuestion(title: string): string {
  return `Delete “${title === '' ? UNTITLED : title}”?`
}

/**
 * The confirmation Delete task… asks for (`requestDelete`): nothing is deleted until you choose Delete. Cancel, Esc or a
 * click outside keeps the task.
 */
export function DeleteTaskDialog(): React.JSX.Element | null {
  const task = useGladeStore((state) => (state.deletingTaskId === null ? undefined : state.tasks[state.deletingTaskId]))
  const cancelDelete = useGladeStore((state) => state.cancelDelete)
  const deleteTask = useGladeStore((state) => state.deleteTask)
  const toast = useToast()
  if (task === undefined) return null

  const confirm = async (): Promise<void> => {
    try {
      await deleteTask(task.id)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }

  return (
    <ConfirmDialog
      open
      title={deleteTaskQuestion(task.title)}
      message={DELETE_TASK_MESSAGE}
      confirmLabel="Delete"
      destructive
      onConfirm={() => void confirm()}
      onCancel={cancelDelete}
    />
  )
}
