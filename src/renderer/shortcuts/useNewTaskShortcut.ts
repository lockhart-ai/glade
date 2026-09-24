import { CommandId } from '../../shared/keymap'
import { useCommand } from '../commands/hooks'
import { useGladeStore } from '../store/react'
import { useNewTask } from '../task-list/useNewTask'

/**
 * New task (⌘N) creates a new task in the selected workspace, as the + button does, wherever the focus is. It does
 * nothing while no workspace is open. Must be used under a `ToastProvider`.
 */
export function useNewTaskShortcut(): void {
  const workspaceId = useGladeStore((state) => state.selectedWorkspaceId)
  const newTask = useNewTask(workspaceId)
  useCommand(CommandId.NewTask, () => {
    void newTask()
  })
}
