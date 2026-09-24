import { parseTaskFilter } from '../../shared/attention'
import { UiStateKey } from '../../shared/domain'
import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useGladeStore } from '../store/react'
import { selectSelectedTask } from '../store/state'
import { collapsedValue, collapseKey, isCollapsed, sectionTasks } from '../task-list/sections'

/**
 * Rename (F2) renames the selected task in its task list row, wherever the focus is: its title becomes a text field
 * (see `TaskRow`). A collapsed section opens to show the row. Does nothing when no task is selected, or when the filter
 * chip hides its row.
 */
export function useRenameShortcut(): void {
  const task = useGladeStore(selectSelectedTask)
  const tasks = useGladeStore((state) => state.tasks)
  const uiState = useGladeStore((state) => state.uiState)
  const startRename = useGladeStore((state) => state.startRename)
  const setUiState = useGladeStore((state) => state.setUiState)
  useCommand(CommandId.RenameTask, () => {
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
  })
}
