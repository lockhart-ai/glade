import { useCallback } from 'react'
import { taskLink } from '../../shared/taskLink'
import type { TaskMenuActions } from '../context-menus'
import { useMenuCommands } from '../context-menus/useMenuCommands'
import { useGladeStore } from '../store/react'
import type { GladeData } from '../store/state'
import { useMarkDone } from '../task-header/useMarkDone'
import { isSearching } from './TaskListToolbar'
import { collapsedValue, collapseKey, isCollapsed, listSections, type SectionId } from './sections'

/**
 * The task list section whose row shows a task, where it can be renamed; undefined when there's none: the task is
 * gone, the filter chip hides it, or the sidebar lists search results instead.
 */
export function renameSection(
  state: Pick<GladeData, 'tasks' | 'doneLists' | 'searchText' | 'uiState'>,
  taskId: string,
): SectionId | undefined {
  const task = state.tasks[taskId]
  if (task === undefined || isSearching(state.searchText)) return undefined
  return listSections(state, task.workspaceId).find((section) => section.tasks.includes(task))?.id
}

/**
 * What can be done to a task, as its context menu and the menu bar's Task menu do it: Mark done shows the toast with
 * Undo, Rename… opens the section its row is in, if collapsed, and Delete task… asks you to confirm first. Failures show
 * as toasts. Null for a task that's gone. Must be used under a `ToastProvider`.
 */
export function useTaskActions(): (taskId: string) => TaskMenuActions | null {
  const tasks = useGladeStore((state) => state.tasks)
  const doneLists = useGladeStore((state) => state.doneLists)
  const searchText = useGladeStore((state) => state.searchText)
  const uiState = useGladeStore((state) => state.uiState)
  const selectTask = useGladeStore((state) => state.selectTask)
  const togglePin = useGladeStore((state) => state.togglePin)
  const startRename = useGladeStore((state) => state.startRename)
  const setUiState = useGladeStore((state) => state.setUiState)
  const markUnread = useGladeStore((state) => state.markUnread)
  const reopenTask = useGladeStore((state) => state.reopenTask)
  const requestDelete = useGladeStore((state) => state.requestDelete)
  const markDone = useMarkDone()
  const { run, copy } = useMenuCommands()

  return useCallback(
    (taskId: string) => {
      const task = tasks[taskId]
      if (task === undefined) return null
      return {
        open: () => {
          run(() => selectTask(taskId))
        },
        togglePin: () => {
          run(() => togglePin(taskId))
        },
        rename: () => {
          const section = renameSection({ tasks, doneLists, searchText, uiState }, taskId)
          if (section !== undefined && isCollapsed(uiState, section)) {
            run(() => setUiState({ key: collapseKey(section), value: collapsedValue(false) }))
          }
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
      }
    },
    [
      tasks,
      doneLists,
      searchText,
      uiState,
      selectTask,
      togglePin,
      startRename,
      setUiState,
      markUnread,
      reopenTask,
      requestDelete,
      markDone,
      run,
      copy,
    ],
  )
}
