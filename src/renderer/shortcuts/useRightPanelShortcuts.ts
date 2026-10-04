import type { UiStateEntry } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { useCommand } from '../commands/hooks'
import { collapsedEntry, isCollapsed, Panel } from '../panels'
import { panelTabEntry, tabForDigit } from '../right-panel/panelModel'
import { useGladeStoreApi } from '../store/react'
import type { UiStateValues } from '../store/state'

/**
 * What picking the right panel's nth tab asks of it, as the UI state to write: that tab for `workspaceId`, and the
 * panel open if it's collapsed. Null for a digit with no tab: with the todo hub on (`hub`) the panel has three.
 */
export function panelTabEntries(
  digit: number,
  uiState: UiStateValues,
  workspaceId: string,
  hub = false,
): UiStateEntry[] | null {
  const tab = tabForDigit(digit, hub)
  if (tab === undefined) return null
  const entries: UiStateEntry[] = [panelTabEntry(uiState, workspaceId, tab)]
  if (isCollapsed(uiState, Panel.RightPanel)) entries.push(collapsedEntry(Panel.RightPanel, false))
  return entries
}

/**
 * Tool calls · Files · Todos · Artifacts · Subagents · Watchers · Changes (⌘⌥1–7) pick the right panel's tab, wherever
 * the focus is, in the workspace shown. With the todo hub on (P16, the hidden `todoHubEnabled` setting) the panel's
 * tabs are Agents · Files · Todos, which ⌘⌥1–3 pick; ⌘⌥4–7 then pick nothing.
 */
export function useRightPanelShortcuts(): void {
  const store = useGladeStoreApi()
  useCommand(WindowCommandId.ShowPanelTab, ({ digit }) => {
    const { uiState, selectedWorkspaceId, setUiState, settings } = store.getState()
    if (selectedWorkspaceId === null) return
    const entries = panelTabEntries(digit ?? 0, uiState, selectedWorkspaceId, settings.todoHubEnabled)
    for (const entry of entries ?? []) void setUiState(entry)
  })
}
