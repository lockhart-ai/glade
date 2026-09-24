import { useEffect } from 'react'
import { useMenuCommands } from '../context-menus'
import { useGladeStoreApi } from '../store/react'
import { TerminalShortcut, terminalShortcut } from './terminalModel'

/**
 * The terminal's shortcuts that work wherever the focus is (docs/keymap.md): ⌃` focuses the terminal (opening the
 * bottom bar, and a tab when there's none) and ⌘T opens a new tab. The ones that act on the tab showing work in the
 * terminal itself (see `Terminal`). A failure shows as a toast, so it must be used under a `ToastProvider`.
 */
export function useTerminalShortcuts(): void {
  const store = useGladeStoreApi()
  const { run } = useMenuCommands()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { focusTerminal, createTerminal } = store.getState()
      switch (terminalShortcut(event)) {
        case TerminalShortcut.Focus:
          run(focusTerminal)
          break
        case TerminalShortcut.NewTab:
          run(createTerminal)
          break
        case TerminalShortcut.NextTab:
        case TerminalShortcut.PreviousTab:
        case TerminalShortcut.Clear:
        case TerminalShortcut.Close:
        case null:
          return
      }
      event.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store, run])
}
