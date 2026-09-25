import { useGladeStore } from '../store/react'
import { collapsedEntry, isCollapsed, type Panel } from './panels'
import { panelSize, parsePanelSize, type SizedPanel } from './panelSize'

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

/** A panel's persisted size, and a way to keep a new one. */
export interface PanelSizeState {
  /** Its width (the sidebar, the right panel and the plugin card) or height (the bottom bar), in CSS pixels. */
  readonly size: number
  /** Stores a size you chose, unless it's the one already stored. */
  readonly setSize: (size: number) => void
}

/**
 * A panel's size, from UI state, and the setter that stores a change. Collapsing a panel leaves its size stored, so it
 * reopens at the size you left it. Use under a `GladeStoreProvider`.
 */
export function usePanelSize(panel: SizedPanel): PanelSizeState {
  const { key } = panelSize(panel)
  const size = useGladeStore((state) => parsePanelSize(panel, state.uiState[key]))
  const setUiState = useGladeStore((state) => state.setUiState)
  return {
    size,
    setSize: (next) => {
      if (next !== size) void setUiState({ key, value: String(next) })
    },
  }
}
