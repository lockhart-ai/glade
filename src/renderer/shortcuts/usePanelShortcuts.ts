import { useCommands, type CommandHandler } from '../commands/hooks'
import { panelDefinition, toggledEntry, type Panel } from '../panels'
import { useGladeStoreApi } from '../store/react'

/**
 * The panel shortcuts (Toggle task list ⌘B, Toggle right panel ⌘⌥B, Toggle bottom bar ⌘J), wherever the focus is, for the panels this window shows (the first-run window has no task list
 * or right panel to toggle). Each flips the panel's persisted state, as its button does.
 */
export function usePanelShortcuts(panels: readonly Panel[]): void {
  const store = useGladeStoreApi()
  const toggle =
    (panel: Panel): CommandHandler =>
    () => {
      const { uiState, setUiState } = store.getState()
      void setUiState(toggledEntry(uiState, panel))
    }
  useCommands(Object.fromEntries(panels.map((panel) => [panelDefinition(panel).command, toggle(panel)])))
}
