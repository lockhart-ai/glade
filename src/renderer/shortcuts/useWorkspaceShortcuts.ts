import { CommandId } from '../../shared/keymap'
import { useCommands } from '../commands/hooks'
import { useGladeStore } from '../store/react'
import { workspaceAt } from '../workspace-switcher/switcherModel'
import { useWorkspaceActions } from '../workspace-switcher/useWorkspaceActions'

/**
 * The workspace shortcuts, wherever the focus is: Switch workspace (⌘1 – ⌘9) switches to the nth workspace, oldest
 * first (as the switcher lists them); New workspace (⌘⇧N) and Open folder as workspace (⌘O) choose a folder and open it
 * as a workspace. Must be used under a `ToastProvider`.
 */
export function useWorkspaceShortcuts(): void {
  const workspaces = useGladeStore((state) => state.workspaces)
  const { add, open } = useWorkspaceActions()
  useCommands({
    [CommandId.SwitchWorkspace]: ({ digit }) => {
      const workspace = workspaceAt(workspaces, digit ?? 0)
      if (workspace !== undefined) open(workspace.id)
    },
    [CommandId.NewWorkspace]: add,
    [CommandId.OpenFolderAsWorkspace]: add,
  })
}
