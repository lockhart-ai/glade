import { agentCount } from '../agents/agentsModel'
import type { GladeData } from '../store/state'
import { subagentCount } from '../subagents/subagentsModel'
import { toolCallCount } from '../tool-log/toolLogModel'
import { todoProgress } from '../todos'
import { liveWatcherCount } from '../watchers/watchersModel'
import { PanelTab, type PanelCount } from './panelModel'

/** What the tab bar needs to know about one tab, with its count, read from the store. */
export interface PanelTabDefinition {
  readonly tab: PanelTab
  readonly label: string
  /** The task's count for this tab, from the store. A count of zero shows none. */
  readonly count: (state: GladeData, taskId: string) => PanelCount
}

// The files open in the tab, as in 08-open-file.png: "Files 3" over three open files.
const FILES: PanelTabDefinition = {
  tab: PanelTab.Files,
  label: 'Files',
  count: (state, taskId) => state.openFiles[taskId]?.paths.length ?? 0,
}

const TODOS: PanelTabDefinition = {
  tab: PanelTab.Todos,
  label: 'Todos',
  count: (state, taskId) => {
    const { done, total } = todoProgress(state.todos[taskId])
    return { done, total }
  },
}

/** The right panel's tabs with the todo hub off, in tab bar order. */
export const PANEL_TAB_DEFINITIONS: readonly PanelTabDefinition[] = [
  {
    tab: PanelTab.ToolCalls,
    label: 'Tool calls',
    count: (state, taskId) => toolCallCount(state.toolEvents[taskId] ?? []),
  },
  FILES,
  TODOS,
  { tab: PanelTab.Artifacts, label: 'Artifacts', count: (state, taskId) => state.artifacts[taskId]?.length ?? 0 },
  {
    tab: PanelTab.Subagents,
    label: 'Subagents',
    count: (state, taskId) => subagentCount(state.toolEvents[taskId] ?? []),
  },
  // What's still live: running, or waiting to wake the agent (28-watchers.png: "Watchers 3").
  { tab: PanelTab.Watchers, label: 'Watchers', count: (state, taskId) => liveWatcherCount(state.watchers[taskId]) },
  // The commits the task made (24-changes.png: "Changes 4").
  { tab: PanelTab.Changes, label: 'Changes', count: (state, taskId) => state.commits[taskId]?.length ?? 0 },
]

/**
 * The right panel's tabs with the todo hub on (P16, #491; the hidden `todoHubEnabled` setting), in tab bar order:
 * Agents · Files · Todos. Agents counts the task's agents, Main included (50-agents.png: "Agents 4" over Main and three
 * subagents).
 */
export const HUB_PANEL_TAB_DEFINITIONS: readonly PanelTabDefinition[] = [
  { tab: PanelTab.Agents, label: 'Agents', count: (state, taskId) => agentCount(state.toolEvents[taskId]) },
  FILES,
  TODOS,
]

/** The tabs the tab bar shows, in order: three with the todo hub on, today's seven with it off. */
export function panelTabDefinitions(hub: boolean): readonly PanelTabDefinition[] {
  return hub ? HUB_PANEL_TAB_DEFINITIONS : PANEL_TAB_DEFINITIONS
}
