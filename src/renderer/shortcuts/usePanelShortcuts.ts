import { useEffect } from 'react'
import { Panel, toggledEntry } from '../panels'
import { useGladeStoreApi } from '../store/react'

/**
 * The panel a key press toggles (docs/keymap.md): ⌘B the task list, ⌘⌥B the right panel, ⌘J the bottom bar. Undefined
 * for any other key. ⌘⌥B reads the physical key (`code`), since ⌥ changes the character a key types on a Mac (⌥B
 * types ∫); the others read the character, as ⌘N does.
 */
export function panelShortcut(event: KeyboardEvent): Panel | undefined {
  if (!event.metaKey || event.ctrlKey || event.shiftKey) return undefined
  if (event.altKey) return event.code === 'KeyB' ? Panel.RightPanel : undefined
  switch (event.key.toLowerCase()) {
    case 'b':
      return Panel.Sidebar
    case 'j':
      return Panel.BottomBar
    default:
      return undefined
  }
}

/**
 * The panel shortcuts, wherever the focus is, for the panels this window shows (the first-run window has no task list
 * or right panel to toggle). Each flips the panel's persisted state, as its button does.
 */
export function usePanelShortcuts(panels: readonly Panel[]): void {
  const store = useGladeStoreApi()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const panel = panelShortcut(event)
      if (panel === undefined || !panels.includes(panel)) return
      event.preventDefault()
      const { uiState, setUiState } = store.getState()
      void setUiState(toggledEntry(uiState, panel))
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store, panels])
}
