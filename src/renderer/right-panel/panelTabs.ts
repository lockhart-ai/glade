import { faListCheck, faSitemap } from '@fortawesome/free-solid-svg-icons'
import { faFolder } from '@fortawesome/free-regular-svg-icons'
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'
import { agentCount } from '../agents/agentsModel'
import type { GladeData } from '../store/state'
import { todoProgress } from '../todos'
import { PanelTab, type PanelCount } from './panelModel'

/** What the tab bar needs to know about one tab, with its count, read from the store. */
export interface PanelTabDefinition {
  readonly tab: PanelTab
  readonly label: string
  /** The tab's icon, ahead of its label (#777), from the Font Awesome sets the app already ships. */
  readonly icon: IconDefinition
  /** The task's count for this tab, from the store. A count of zero shows none. */
  readonly count: (state: GladeData, taskId: string) => PanelCount
}

/**
 * The right panel's tabs (P16, #491), in tab bar order: Todos · Agents · Files. Todos counts how many of the task's
 * todos are done; Agents, the task's agents, Main included (50-agents.png: "Agents 4" over Main and three
 * subagents); Files, the files open in the tab (08-open-file.png: "Files 3" over three open files). Icons (option C
 * of the icons sheet, #777): the todo list, the sitemap that marks subagents on sidebar rows, and the regular-weight
 * folder the Browse tree draws.
 */
export const PANEL_TAB_DEFINITIONS: readonly PanelTabDefinition[] = [
  {
    tab: PanelTab.Todos,
    label: 'Todos',
    icon: faListCheck,
    count: (state, taskId) => {
      const { done, total } = todoProgress(state.todos[taskId])
      return { done, total }
    },
  },
  {
    tab: PanelTab.Agents,
    label: 'Agents',
    icon: faSitemap,
    count: (state, taskId) => agentCount(state.toolEvents[taskId]),
  },
  {
    tab: PanelTab.Files,
    label: 'Files',
    icon: faFolder,
    count: (state, taskId) => state.openFiles[taskId]?.paths.length ?? 0,
  },
]
