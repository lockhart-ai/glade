import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { useCallback } from 'react'
import { TaskState } from '../../shared/domain'
import { DEFAULT_TOAST_TIMEOUT, useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import type { GladeState } from '../store/state'
import { useGladeStore, useGladeStoreApi } from '../store/react'
import { revealDone } from '../task-list/sections'

/** What the toast says once a task is marked done, from docs/design/html/05-mark-done.html. */
export const MARKED_DONE_MESSAGE = 'Marked done. The latest status is kept as the outcome.'

/** The toast's button that puts the task back as it was. */
export const UNDO_LABEL = 'Undo'

function isDone(state: GladeState, taskId: string): boolean {
  return state.tasks[taskId]?.state === TaskState.Done
}

/**
 * Marks a task done with no dialog, then shows a toast with Undo for a few seconds. Undo reopens the task, which
 * restores every field but `updatedAt`. The toast goes as soon as the task stops being done some other way (e.g. a
 * message reopens it), and Undo does nothing on a task that is no longer done. The Done section expands so the task's
 * row stays in view (and stays expanded after Undo, as a manual expand would). A failure shows as a toast. Must be
 * used under a `ToastProvider`.
 */
export function useMarkDone(): (taskId: string) => Promise<void> {
  const markTaskDone = useGladeStore((state) => state.markTaskDone)
  const reopenTask = useGladeStore((state) => state.reopenTask)
  const setUiState = useGladeStore((state) => state.setUiState)
  const tasks = useGladeStore((state) => state.tasks)
  const uiState = useGladeStore((state) => state.uiState)
  const store = useGladeStoreApi()
  const toast = useToast()

  return useCallback(
    async (taskId: string): Promise<void> => {
      const undo = async (): Promise<void> => {
        if (!isDone(store.getState(), taskId)) return
        try {
          await reopenTask(taskId)
        } catch (error) {
          toast.show({ message: describeFailure(error) })
        }
      }
      const task = tasks[taskId]
      const reveal = task === undefined ? null : revealDone(task, uiState)
      try {
        await markTaskDone(taskId)
      } catch (error) {
        toast.show({ message: describeFailure(error) })
        return
      }
      const toastId = toast.show({
        message: MARKED_DONE_MESSAGE,
        icon: faCheck,
        action: { label: UNDO_LABEL, onAction: () => void undo() },
      })
      // Watch the task while the toast is up: once it stops being done, the toast's Undo no longer applies.
      const unsubscribe = store.subscribe((state, previous) => {
        if (isDone(previous, taskId) && !isDone(state, taskId)) {
          toast.dismiss(toastId)
          stopWatching()
        }
      })
      const timer = setTimeout(unsubscribe, DEFAULT_TOAST_TIMEOUT)
      const stopWatching = (): void => {
        clearTimeout(timer)
        unsubscribe()
      }
      if (reveal === null) return
      try {
        await setUiState(reveal)
      } catch (error) {
        toast.show({ message: describeFailure(error) })
      }
    },
    [markTaskDone, reopenTask, setUiState, store, tasks, uiState, toast],
  )
}
