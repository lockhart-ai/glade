import type { UiStateEntry } from '../../shared/domain'
import { WindowCommandId } from '../../shared/commands'
import { useCommand } from '../commands/hooks'
import { collapsedEntry, isCollapsed, Panel } from '../panels'
import { panelTabEntry, tabForDigit } from '../right-panel/panelModel'
import { useGladeStoreApi } from '../store/react'
import type { UiStateValues } from '../store/state'

/**
 * What picking the right panel's nth tab asks of it, as the UI state to write: that tab for `taskId`, and the
 * panel open if it's collapsed. Null for a digit with no tab: the panel has three.
 */
export function panelTabEntries(digit: number, uiState: UiStateValues, taskId: string): UiStateEntry[] | null {
  const tab = tabForDigit(digit)
  if (tab === undefined) return null
  const entries: UiStateEntry[] = [panelTabEntry(uiState, taskId, tab)]
  if (isCollapsed(uiState, Panel.RightPanel)) entries.push(collapsedEntry(Panel.RightPanel, false))
  return entries
}

/** Todos · Agents · Files (⌘⌥1–3) pick the selected task's right panel tab, wherever the focus is (#689). */
export function useRightPanelShortcuts(): void {
  const store = useGladeStoreApi()
  useCommand(WindowCommandId.ShowPanelTab, ({ digit }) => {
    const { uiState, selectedTaskId, setUiState } = store.getState()
    if (selectedTaskId === null) return
    const entries = panelTabEntries(digit ?? 0, uiState, selectedTaskId)
    for (const entry of entries ?? []) void setUiState(entry)
  })
}
