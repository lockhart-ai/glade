import { useCallback } from 'react'
import { TaskActivity, TaskState, type Task } from '../../shared/domain'
import { useToast } from '../components'
import { describeFailure } from '../store/hydrate'
import { useGladeStore } from '../store/react'

/** The shortcut that compacts the selected task, as the popover shows it (`docs/keymap.md`). */
export const COMPACT_SHORTCUT = '⌘⇧K'

/**
 * Whether a task can be compacted now: it's active, its agent isn't working (Compact now is off while it works, rather
 * than waiting behind its turn) or paused, and its agent has a session, so there's something to compact.
 */
export function canCompact(task: Pick<Task, 'state' | 'activity' | 'sessionId'>): boolean {
  const running = task.activity === TaskActivity.Working || task.activity === TaskActivity.Paused
  return task.state === TaskState.Active && !running && task.sessionId !== null
}

/** Compacts a task's context now, showing a toast if main refuses. Must be used under a `ToastProvider`. */
export function useCompact(): (taskId: string) => Promise<void> {
  const compactTask = useGladeStore((state) => state.compactTask)
  const toast = useToast()
  return useCallback(
    async (taskId: string): Promise<void> => {
      try {
        await compactTask(taskId)
      } catch (error) {
        toast.show({ message: describeFailure(error) })
      }
    },
    [compactTask, toast],
  )
}
