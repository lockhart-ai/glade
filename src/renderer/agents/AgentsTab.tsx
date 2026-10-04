import { memo, useCallback, useEffect, useMemo } from 'react'
import type { PermissionLines } from '../permissions/permissionLineModel'
import { useGladeStore } from '../store/react'
import { ToolLog, type TurnFocus } from '../tool-log'
import { AgentLine } from './AgentLine'
import { AGENT_PANEL_ID, AgentStrip, agentTabId } from './AgentStrip'
import { PinnedWatchers } from './PinnedWatchers'
import { agentEventsSelector, selectShownAgent, type AgentId } from './agentsModel'
import { logWatchersSelector } from './agentWatchersModel'
import styles from './AgentsTab.module.css'

interface AgentLogProps {
  readonly taskId: string
  readonly agentId: AgentId
  readonly rootPath: string | undefined
  readonly permissions: PermissionLines | undefined
  readonly focus: TurnFocus | null | undefined
  readonly onFocusShown: (() => void) | undefined
  readonly onOpenAgent: (agentId: string) => void
}

/**
 * One agent's tool calls: the tool log's own list (`ToolLog`), over that agent's events alone. It reads them from the
 * store as a list that only changes when one of them does (`agentEventsSelector`), so what another agent of the task
 * does doesn't render it. Its watchers that have ended are rows among them (#537), read the same way
 * (`logWatchersSelector`): what a live watcher reports doesn't render it either.
 */
function AgentLog({
  taskId,
  agentId,
  rootPath,
  permissions,
  focus,
  onFocusShown,
  onOpenAgent,
}: AgentLogProps): React.JSX.Element {
  const select = useMemo(() => agentEventsSelector(taskId, agentId), [taskId, agentId])
  const events = useGladeStore(select)
  const selectWatchers = useMemo(() => logWatchersSelector(taskId, agentId), [taskId, agentId])
  const watchers = useGladeStore(selectWatchers)
  return (
    <ToolLog
      taskId={taskId}
      events={events}
      watchers={watchers}
      agentId={agentId}
      rootPath={rootPath}
      permissions={permissions}
      focus={focus}
      onFocusShown={onFocusShown}
      onOpenAgent={onOpenAgent}
    />
  )
}

export interface AgentsTabProps {
  readonly taskId: string
  /** The workspace root, so file arguments show relative to it. */
  readonly rootPath?: string | undefined
  /** Each call's permission line, by its `tool_use` id (`permissionLinesByToolUse`). None by default. */
  readonly permissions?: PermissionLines | undefined
  /** A turn of the task's own agent to scroll to and highlight, on Main's tab (the chat's tool-calls chip). */
  readonly focus?: TurnFocus | null | undefined
  /** Called once Main's list has scrolled to `focus`, so its owner can clear it. */
  readonly onFocusShown?: (() => void) | undefined
}

/**
 * The Agents tab (P16, #536; `docs/design/html/50-agents.html` to `54-agents-overflow.html`), shown in place of the
 * Tool calls and Subagents tabs while the hidden `todoHubEnabled` setting is on: a strip with a tab for every agent in
 * the task (`AgentStrip`), and under it that agent's tool calls, its notes between them and their output, exactly as
 * the Tool calls tab draws them (`ToolLog`). Main's list shows each subagent it started as an `Agent` call, live while
 * the subagent runs; clicking it goes to that subagent's tab. A subagent's tab says which todo it's working on in a
 * line under the strip (`AgentLine`).
 *
 * What the agent showing is watching is pinned under its tool calls, outside their scroll (`PinnedWatchers`, #537), and
 * takes the place of the Watchers tab: each watcher is on the tab of the agent that started it, a subagent's on that
 * subagent's, where it stays after the subagent finishes. Once a watcher ends it's a row of the list instead.
 *
 * Which agent's tab a task is on is remembered for the task (`selectAgentTab`), across tasks and relaunches; one
 * that's no longer among the task's subagents falls back to Main.
 *
 * Only the list of the agent showing is mounted, and each part reads its own slice of the store: picking an agent
 * renders the two tabs that changed and the new list, not the strip; an event of another agent renders at most that
 * agent's tab.
 */
export const AgentsTab = memo(function AgentsTab({
  taskId,
  rootPath,
  permissions,
  focus,
  onFocusShown,
}: AgentsTabProps): React.JSX.Element {
  const agentId = useGladeStore((state) => selectShownAgent(state, taskId))
  const selectAgentTab = useGladeStore((state) => state.selectAgentTab)
  const loadTodoHub = useGladeStore((state) => state.loadTodoHub)

  // The task's filings, which say which todo each subagent was started for, read as the tab shows the task;
  // `filings.changed` keeps them current from then on. A failed read leaves the subagents' tabs with no todo line.
  useEffect(() => {
    loadTodoHub(taskId).catch(() => undefined)
  }, [taskId, loadTodoHub])

  const openAgent = useCallback(
    (id: string): void => {
      // It shows at once; one main couldn't remember is only forgotten on the next launch.
      selectAgentTab(taskId, id).catch(() => undefined)
    },
    [selectAgentTab, taskId],
  )

  return (
    <div className={styles.agents}>
      <AgentStrip taskId={taskId} rootPath={rootPath} />
      <div role="tabpanel" id={AGENT_PANEL_ID} aria-labelledby={agentTabId(agentId)} className={styles.panel}>
        {agentId !== null && <AgentLine taskId={taskId} agentId={agentId} />}
        {/* Keyed by its agent, so each agent's list starts at its own end, and keeps to it as it grows. */}
        <AgentLog
          key={agentId ?? ''}
          taskId={taskId}
          agentId={agentId}
          rootPath={rootPath}
          permissions={permissions}
          focus={agentId === null ? focus : null}
          onFocusShown={onFocusShown}
          onOpenAgent={openAgent}
        />
        <PinnedWatchers taskId={taskId} agentId={agentId} />
      </div>
    </div>
  )
})
