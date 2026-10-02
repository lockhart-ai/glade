import { useCallback } from 'react'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/**
 * What + and ⌘N do: create a new task in the workspace and select it; the input bar focuses its message field once
 * it's selected (`InputBar`, #415). A failure shows as a toast. Does nothing without a workspace, or when you'd
 * rather stay with the unsaved edits of the task you're on. Must be used under a `ToastProvider`.
 */
export function useNewTask(workspaceId: string | null): () => Promise<void> {
  const createTask = useGladeStore((state) => state.createTask)
  const toast = useToast()

  return useCallback(async () => {
    if (workspaceId === null) return
    try {
      await createTask(workspaceId)
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }, [createTask, toast, workspaceId])
}
