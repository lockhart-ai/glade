import { useEffect } from 'react'
import { parseTaskFilter } from '../../shared/attention'
import { UiStateKey } from '../../shared/domain'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { collapsedValue, collapseKey, isCollapsed, sectionTasks } from '../task-list/sections'

/** Whether the key is F2 with no modifier. */
function isRenameKey(event: KeyboardEvent): boolean {
  return event.key === 'F2' && !event.metaKey && !event.shiftKey && !event.altKey && !event.ctrlKey
}

/**
 * F2 renames the selected task in its task list row, wherever the focus is: its title becomes a text field (see
 * `TaskRow`). A collapsed section opens to show the row. Does nothing when no task is selected, or when the filter
 * chip hides its row.
 */
export function useRenameShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const tasks = useGladeStore((state) => state.tasks)
  const uiState = useGladeStore((state) => state.uiState)
  const startRename = useGladeStore((state) => state.startRename)
  const setUiState = useGladeStore((state) => state.setUiState)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!isRenameKey(event)) return
      event.preventDefault()
      if (task === undefined) return
      const filter = parseTaskFilter(uiState[UiStateKey.TaskFilter])
      const section = sectionTasks(Object.values(tasks), task.workspaceId, filter).find((candidate) =>
        candidate.tasks.includes(task),
      )
      if (section === undefined) return
      if (isCollapsed(uiState, section.id)) {
        void setUiState({ key: collapseKey(section.id), value: collapsedValue(false) })
      }
      startRename(task.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [task, tasks, uiState, startRename, setUiState])
}
