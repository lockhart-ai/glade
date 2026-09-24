import type { GladeData } from '../store/state'
import { toolCallCount } from '../tool-log/toolLogModel'
import { PanelTab, type PanelCount } from './panelModel'

/**
 * What the tab bar needs to know about one tab. Each tab provides its own count here: a tab that isn't built yet
 * counts nothing, and its ticket replaces that with a count read from the store.
 */
export interface PanelTabDefinition {
  readonly tab: PanelTab
  readonly label: string
  /** The task's count for this tab, from the store. A count of zero shows none. */
  readonly count: (state: GladeData, taskId: string) => PanelCount
}

const NOTHING_YET = (): PanelCount => 0

/** The right panel's tabs, in tab bar order. */
export const PANEL_TAB_DEFINITIONS: readonly PanelTabDefinition[] = [
  {
    tab: PanelTab.ToolCalls,
    label: 'Tool calls',
    count: (state, taskId) => toolCallCount(state.toolEvents[taskId] ?? []),
  },
  { tab: PanelTab.Files, label: 'Files', count: NOTHING_YET },
  { tab: PanelTab.Todos, label: 'Todos', count: NOTHING_YET },
  { tab: PanelTab.Artifacts, label: 'Artifacts', count: NOTHING_YET },
  { tab: PanelTab.Subagents, label: 'Subagents', count: NOTHING_YET },
]
