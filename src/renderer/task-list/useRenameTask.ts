import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** What a task row that can be renamed (F2, or its menu's Rename…) needs. */
export interface RenameTask {
  /** The task being renamed, if any. */
  readonly renamingTaskId: string | null
  /** Saves a new title: false when it's refused (blank), so the field stays; a failure shows a toast and stops. */
  readonly rename: (taskId: string, title: string) => Promise<boolean>
  readonly cancelRename: () => void
}

/** Renaming a task in its row, for the task list and the search results. Must be used under a `ToastProvider`. */
export function useRenameTask(): RenameTask {
  const renamingTaskId = useGladeStore((state) => state.renamingTaskId)
  const renameTask = useGladeStore((state) => state.renameTask)
  const cancelRename = useGladeStore((state) => state.cancelRename)
  const toast = useToast()

  const rename = async (taskId: string, title: string): Promise<boolean> => {
    try {
      return await renameTask(taskId, title)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
      cancelRename()
      return true
    }
  }
  return { renamingTaskId, rename, cancelRename }
}
