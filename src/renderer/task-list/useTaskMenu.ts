import { useCallback } from 'react'
import type { MenuEntry } from '../components'
import { taskMenu } from '../context-menus'
import { useGladeStore } from '../store/react'
import { useTaskActions } from './useTaskActions'

/**
 * The entries of a task's context menu (`taskMenu`), for the task list's rows and anything else that lists tasks, such
 * as search results. Each item does what its button or shortcut does (`useTaskActions`). None for a task that's gone.
 * Must be used under a `ToastProvider`.
 */
export function useTaskMenu(): (taskId: string) => readonly MenuEntry[] {
  const tasks = useGladeStore((state) => state.tasks)
  const actionsFor = useTaskActions()

  return useCallback(
    (taskId: string) => {
      const task = tasks[taskId]
      const actions = actionsFor(taskId)
      return task === undefined || actions === null ? [] : taskMenu(task, actions)
    },
    [tasks, actionsFor],
  )
}
