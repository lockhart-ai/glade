import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { useCommand } from '../commands/hooks'
import { collapsedEntry, isCollapsed, Panel } from '../panels'
import { tabForDigit } from '../right-panel/panelModel'
import { useGladeStoreApi } from '../store/react'
import type { UiStateValues } from '../store/state'

/**
 * What picking the right panel's nth tab asks of it, as the UI state to write: that tab, and the panel open if it's
 * collapsed. Null for a digit with no tab.
 */
export function panelTabEntries(digit: number, uiState: UiStateValues): UiStateEntry[] | null {
  const tab = tabForDigit(digit)
  if (tab === undefined) return null
  const entries: UiStateEntry[] = [{ key: UiStateKey.RightPanelTab, value: tab }]
  if (isCollapsed(uiState, Panel.RightPanel)) entries.push(collapsedEntry(Panel.RightPanel, false))
  return entries
}

/** Tool calls · Files · Todos · Artifacts · Subagents (⌘⌥1–5) pick the right panel's tab, wherever the focus is. */
export function useRightPanelShortcuts(): void {
  const store = useGladeStoreApi()
  useCommand(WindowCommandId.ShowPanelTab, ({ digit }) => {
    const { uiState, setUiState } = store.getState()
    for (const entry of panelTabEntries(digit ?? 0, uiState) ?? []) void setUiState(entry)
  })
}
