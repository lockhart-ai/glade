import { useCallback } from 'react'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/**
 * What + and ⌘N do: create a new task in the workspace, select it and ask the input bar to focus its message field. A
 * failure shows as a toast. Does nothing without a workspace. Must be used under a `ToastProvider`.
 */
export function useNewTask(workspaceId: string | null): () => Promise<void> {
  const createTask = useGladeStore((state) => state.createTask)
  const focusInput = useGladeStore((state) => state.focusInput)
  const toast = useToast()

  return useCallback(async () => {
    if (workspaceId === null) return
    try {
      await createTask(workspaceId)
      focusInput()
    } catch (error) {
      toast.show({ message: describeFailure(error) })
    }
  }, [createTask, focusInput, toast, workspaceId])
}
