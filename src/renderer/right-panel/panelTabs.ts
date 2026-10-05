import { agentCount } from '../agents/agentsModel'
import type { GladeData } from '../store/state'
import { todoProgress } from '../todos'
import { PanelTab, type PanelCount } from './panelModel'

/** What the tab bar needs to know about one tab, with its count, read from the store. */
export interface PanelTabDefinition {
  readonly tab: PanelTab
  readonly label: string
  /** The task's count for this tab, from the store. A count of zero shows none. */
  readonly count: (state: GladeData, taskId: string) => PanelCount
}

/**
 * The right panel's tabs (P16, #491), in tab bar order: Agents · Files · Todos. Agents counts the task's agents, Main
 * included (50-agents.png: "Agents 4" over Main and three subagents); Files, the files open in the tab (08-open-file.png:
 * "Files 3" over three open files); Todos, how many of the task's todos are done.
 */
export const PANEL_TAB_DEFINITIONS: readonly PanelTabDefinition[] = [
  { tab: PanelTab.Agents, label: 'Agents', count: (state, taskId) => agentCount(state.toolEvents[taskId]) },
  { tab: PanelTab.Files, label: 'Files', count: (state, taskId) => state.openFiles[taskId]?.paths.length ?? 0 },
  {
    tab: PanelTab.Todos,
    label: 'Todos',
    count: (state, taskId) => {
      const { done, total } = todoProgress(state.todos[taskId])
      return { done, total }
    },
  },
]
