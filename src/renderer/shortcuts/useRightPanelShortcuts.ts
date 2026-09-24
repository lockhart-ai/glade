import { useEffect } from 'react'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { collapsedEntry, isCollapsed, Panel } from '../panels'
import { tabForDigit } from '../right-panel/panelModel'
import { useGladeStoreApi } from '../store/react'
import type { UiStateValues } from '../store/state'

/** Whether ⌘⌥ are held with no other modifier. */
function isCommandOption(event: KeyboardEvent): boolean {
  return event.metaKey && event.altKey && !event.shiftKey && !event.ctrlKey
}

/**
 * What a key press asks of the right panel, as the UI state to write: ⌘⌥1–5 picks a tab (opening the panel if it's
 * collapsed). Null for any other key, ⌘⌥B included (a panel shortcut; see `usePanelShortcuts`). It reads the physical
 * key (`code`), since ⌥ changes the character a key types on a Mac (⌥2 types ™).
 */
export function rightPanelShortcut(event: KeyboardEvent, uiState: UiStateValues): UiStateEntry[] | null {
  if (!isCommandOption(event)) return null
  const digit = /^Digit(\d)$/.exec(event.code)?.[1]
  const tab = digit === undefined ? undefined : tabForDigit(Number(digit))
  if (tab === undefined) return null
  const entries: UiStateEntry[] = [{ key: UiStateKey.RightPanelTab, value: tab }]
  if (isCollapsed(uiState, Panel.RightPanel)) entries.push(collapsedEntry(Panel.RightPanel, false))
  return entries
}

/** ⌘⌥1–5 pick the right panel's tab (see docs/keymap.md), wherever the focus is. */
export function useRightPanelShortcuts(): void {
  const store = useGladeStoreApi()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const { uiState, setUiState } = store.getState()
      const entries = rightPanelShortcut(event, uiState)
      if (entries === null) return
      event.preventDefault()
      for (const entry of entries) void setUiState(entry)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [store])
}
