import { useCallback } from 'react'
import type { MenuEntry } from '../components'
import { taskMenu, useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
import { useMarkDone } from '../task-header/useMarkDone'
import { taskLink } from '../../shared/taskLink'

/**
 * The entries of a task's context menu (`taskMenu`), for the task list's rows and anything else that lists tasks, such
 * as search results. Each item does what its button or shortcut does: Mark done shows the toast with Undo, and Delete
 * task… asks you to confirm first. None for a task that's gone. Must be used under a `ToastProvider`.
 */
export function useTaskMenu(): (taskId: string) => readonly MenuEntry[] {
  const tasks = useGladeStore((state) => state.tasks)
  const selectTask = useGladeStore((state) => state.selectTask)
  const togglePin = useGladeStore((state) => state.togglePin)
  const startRename = useGladeStore((state) => state.startRename)
  const markUnread = useGladeStore((state) => state.markUnread)
  const reopenTask = useGladeStore((state) => state.reopenTask)
  const requestDelete = useGladeStore((state) => state.requestDelete)
  const markDone = useMarkDone()
  const { run, copy } = useMenuCommands()

  return useCallback(
    (taskId: string) => {
      const task = tasks[taskId]
      if (task === undefined) return []
      return taskMenu(task, {
        open: () => {
          run(() => selectTask(taskId))
        },
        togglePin: () => {
          run(() => togglePin(taskId))
        },
        rename: () => {
          startRename(taskId)
        },
        markUnread: () => {
          run(() => markUnread(taskId))
        },
        markDone: () => void markDone(taskId),
        reopen: () => {
          run(() => reopenTask(taskId))
        },
        copyLink: () => {
          copy(taskLink(taskId))
        },
        copyOutcome: () => {
          copy(task.status)
        },
        delete: () => {
          requestDelete(taskId)
        },
      })
    },
    [tasks, selectTask, togglePin, startRename, markUnread, reopenTask, requestDelete, markDone, run, copy],
  )
}
