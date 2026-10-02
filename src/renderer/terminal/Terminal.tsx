import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { WindowCommandId } from '../../shared/commands'
import { CLOSE_REQUEST_EVENT } from '../commands/closeRequest'
import { isCommandKey, useKeymap } from '../commands/hooks'
import { useMenuCommands } from '../context-menus'
import { useGladeStore } from '../store/react'
import { loadTerminalFont } from './screen'
import { activeTerminalTab } from './terminalModel'
import { TerminalView } from './TerminalView'
import styles from './Terminal.module.css'

/**
 * The terminal card's body: every tab's screen, the one showing on top. Every workspace's tabs keep their screens in
 * the page, hidden while another workspace shows, so switching back shows each as it was, with what its shell output
 * meanwhile; the workspace showing picks the tab on top. With the focus in it, Next tab and Previous tab (⌃⇥, ⌃⇧⇥)
 * pick another tab and Clear (⌘K) clears the tab showing, as the keymap binds them; Close (⌘W, the menu bar's) closes
 * it. ⌃C goes to the shell, as in any terminal. The screens wait for the terminal's font, so each measures its cell in
 * it (#412).
 */
export function Terminal(): React.JSX.Element {
  const tabs = useGladeStore((state) => state.terminalTabs)
  const active = useGladeStore((state) =>
    activeTerminalTab(state.terminalTabs, state.uiState, state.selectedWorkspaceId),
  )
  const cycleTerminal = useGladeStore((state) => state.cycleTerminal)
  const clearTerminal = useGladeStore((state) => state.clearTerminal)
  const closeTerminal = useGladeStore((state) => state.closeTerminal)
  const keymap = useKeymap()
  const { run } = useMenuCommands()
  const screens = useRef<HTMLDivElement>(null)
  const activeId = active?.id
  const [fontLoaded, setFontLoaded] = useState(false)

  useEffect(() => {
    let mounted = true
    void loadTerminalFont().then(() => {
      if (mounted) setFontLoaded(true)
    })
    return () => {
      mounted = false
    }
  }, [])

  // Close (⌘W) with the focus in the terminal closes the tab showing, rather than the window.
  useEffect(() => {
    const element = screens.current
    if (element === null || activeId === undefined) return
    const onCloseRequest = (event: Event): void => {
      event.preventDefault()
      run(() => closeTerminal(activeId))
    }
    element.addEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
    return () => {
      element.removeEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
    }
  }, [activeId, closeTerminal, run])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (active === undefined) return
    if (isCommandKey(WindowCommandId.NextTerminalTab, keymap, event)) {
      run(() => cycleTerminal(1))
    } else if (isCommandKey(WindowCommandId.PreviousTerminalTab, keymap, event)) {
      run(() => cycleTerminal(-1))
    } else if (isCommandKey(WindowCommandId.ClearTerminal, keymap, event)) {
      run(() => clearTerminal(active.id))
    } else {
      return
    }
    event.preventDefault()
  }

  return (
    <div ref={screens} className={styles.screens} onKeyDown={onKeyDown}>
      {fontLoaded && tabs.map((tab) => <TerminalView key={tab.id} tabId={tab.id} active={tab.id === activeId} />)}
      {active === undefined && <p className={styles.empty}>No terminal open. Start one with + or ⌘T.</p>}
    </div>
  )
}
