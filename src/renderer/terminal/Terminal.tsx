import type { KeyboardEvent } from 'react'
import { useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
import { activeTerminalTab, TerminalShortcut, terminalShortcut } from './terminalModel'
import { TerminalView } from './TerminalView'
import styles from './Terminal.module.css'

/**
 * The terminal card's body: every tab's screen, the one showing on top. With the focus in it, ⌃⇥ and ⌃⇧⇥ pick the next
 * and previous tab, ⌘K clears the tab showing and ⌘W closes it. ⌃C goes to the shell, as in any terminal.
 */
export function Terminal(): React.JSX.Element {
  const tabs = useGladeStore((state) => state.terminalTabs)
  const active = useGladeStore((state) => activeTerminalTab(state.terminalTabs, state.uiState))
  const cycleTerminal = useGladeStore((state) => state.cycleTerminal)
  const clearTerminal = useGladeStore((state) => state.clearTerminal)
  const closeTerminal = useGladeStore((state) => state.closeTerminal)
  const { run } = useMenuCommands()

  if (active === undefined) {
    return <p className={styles.empty}>No terminal open. Start one with + or ⌘T.</p>
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    switch (terminalShortcut(event)) {
      case TerminalShortcut.NextTab:
        run(() => cycleTerminal(1))
        break
      case TerminalShortcut.PreviousTab:
        run(() => cycleTerminal(-1))
        break
      case TerminalShortcut.Clear:
        run(() => clearTerminal(active.id))
        break
      case TerminalShortcut.Close:
        run(() => closeTerminal(active.id))
        break
      case TerminalShortcut.Focus:
      case TerminalShortcut.NewTab:
      case null:
        return
    }
    event.preventDefault()
  }

  return (
    <div className={styles.screens} onKeyDown={onKeyDown}>
      {tabs.map((tab) => (
        <TerminalView key={tab.id} tabId={tab.id} active={tab.id === active.id} />
      ))}
    </div>
  )
}
