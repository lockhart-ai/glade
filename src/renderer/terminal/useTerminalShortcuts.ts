import { WindowCommandId } from '../../shared/commands'
import { useCommands } from '../commands/hooks'
import { useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'

/**
 * The terminal's commands that work wherever the focus is, registered with the window's key dispatcher, so they follow
 * the keymap: Focus terminal (⌃`) opens the bottom bar, and a tab when there's none, with the focus in it; New terminal
 * tab (⌘T) opens a new one. The ones that act on the tab showing work in the terminal itself (see `Terminal`). A
 * failure shows as a toast, so it must be used under a `ToastProvider`.
 */
export function useTerminalShortcuts(): void {
  const focusTerminal = useGladeStore((state) => state.focusTerminal)
  const createTerminal = useGladeStore((state) => state.createTerminal)
  const { run } = useMenuCommands()
  useCommands({
    [WindowCommandId.FocusTerminal]: () => {
      run(focusTerminal)
    },
    [WindowCommandId.NewTerminalTab]: () => {
      run(createTerminal)
    },
  })
}
