import { CommandId } from '../../shared/keymap'
import { useCommands, type CommandHandler } from '../commands/hooks'
import { Panel, toggledEntry } from '../panels'
import { useGladeStoreApi } from '../store/react'

/** The command that toggles each panel (docs/keymap.md): ⌘B the task list, ⌘⌥B the right panel, ⌘J the bottom bar. */
export const PANEL_COMMANDS: Readonly<Record<Panel, CommandId>> = {
  [Panel.Sidebar]: CommandId.ToggleTaskList,
  [Panel.RightPanel]: CommandId.ToggleRightPanel,
  [Panel.BottomBar]: CommandId.ToggleBottomBar,
}

/**
 * The panel shortcuts, wherever the focus is, for the panels this window shows (the first-run window has no task list
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
  useCommands(Object.fromEntries(panels.map((panel) => [PANEL_COMMANDS[panel], toggle(panel)])))
}
