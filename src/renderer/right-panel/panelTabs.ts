import type { GladeData } from '../store/state'
import { subagentCount } from '../subagents/subagentsModel'
import { toolCallCount } from '../tool-log/toolLogModel'
import { todoProgress } from '../todos'
import { PanelTab, type PanelCount } from './panelModel'

/** What the tab bar needs to know about one tab, with its count, read from the store. */
export interface PanelTabDefinition {
  readonly tab: PanelTab
  readonly label: string
  /** The task's count for this tab, from the store. A count of zero shows none. */
  readonly count: (state: GladeData, taskId: string) => PanelCount
}

/** The right panel's tabs, in tab bar order. */
export const PANEL_TAB_DEFINITIONS: readonly PanelTabDefinition[] = [
  {
    tab: PanelTab.ToolCalls,
    label: 'Tool calls',
    count: (state, taskId) => toolCallCount(state.toolEvents[taskId] ?? []),
  },
  // The files open in the tab, as in 08-open-file.png: "Files 3" over three open files.
  { tab: PanelTab.Files, label: 'Files', count: (state, taskId) => state.openFiles[taskId]?.paths.length ?? 0 },
  {
    tab: PanelTab.Todos,
    label: 'Todos',
    count: (state, taskId) => {
      const { done, total } = todoProgress(state.todos[taskId])
      return { done, total }
    },
  },
  { tab: PanelTab.Artifacts, label: 'Artifacts', count: (state, taskId) => state.artifacts[taskId]?.length ?? 0 },
  {
    tab: PanelTab.Subagents,
    label: 'Subagents',
    count: (state, taskId) => subagentCount(state.toolEvents[taskId] ?? []),
  },
]
