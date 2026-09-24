import { useGladeStore } from '../store/react'
import { collapsedEntry, isCollapsed, type Panel } from './panels'

/** A panel's persisted collapsed state, and a way to set it. */
export interface PanelState {
  readonly collapsed: boolean
  readonly setCollapsed: (collapsed: boolean) => void
}

/** Whether a panel is collapsed, from UI state, and the setter that stores a change. Use under a `GladeStoreProvider`. */
export function usePanel(panel: Panel): PanelState {
  const collapsed = useGladeStore((state) => isCollapsed(state.uiState, panel))
  const setUiState = useGladeStore((state) => state.setUiState)
  return {
    collapsed,
    setCollapsed: (next) => {
      void setUiState(collapsedEntry(panel, next))
    },
  }
}
