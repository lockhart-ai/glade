import { faTableColumns } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useState } from 'react'
import type { ToolEvent } from '../../shared/domain'
import { Button, ButtonVariant, TabPanel, Tabs, type TabItem } from '../components'
import { RightPanel } from '../layout'
import { selectSelectedTask, selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import { ToolLog, type TurnFocus } from './ToolLog'
import { toolCallCount } from './toolLogModel'
import styles from './TaskPanel.module.css'

/** The right panel's tabs. */
export enum PanelTab {
  ToolCalls = 'tool-calls',
  Files = 'files',
  Todos = 'todos',
  Artifacts = 'artifacts',
  Subagents = 'subagents',
}

const TABS_ID = 'task-panel'

/** What each tab not built yet shows. */
const EMPTY_STATES: Readonly<Record<Exclude<PanelTab, PanelTab.ToolCalls>, string>> = {
  [PanelTab.Files]: 'No files yet.',
  [PanelTab.Todos]: 'No todos yet.',
  [PanelTab.Artifacts]: 'No artifacts yet.',
  [PanelTab.Subagents]: 'No subagents yet.',
}

const NO_TOOL_EVENTS: readonly ToolEvent[] = []

/**
 * The right panel of the task card: the tab bar (Tool calls, Files, Todos, Artifacts, Subagents) and the selected tab.
 * Only Tool calls is built so far; the others show an empty state, and the collapse button does nothing yet. When the
 * chat asks to show a turn of the selected task (its tool-call chip), the panel switches to Tool calls and the log
 * scrolls to that turn.
 */
export function TaskPanel(): React.JSX.Element {
  const task = useGladeStore(selectSelectedTask)
  const rootPath = useGladeStore((state) => selectSelectedWorkspace(state)?.rootPath)
  const events =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
  const toolLogFocus = useGladeStore((state) => state.toolLogFocus)
  const [tab, setTab] = useState(PanelTab.ToolCalls)
  const [focus, setFocus] = useState<TurnFocus | null>(null)
  // The last request acted on, so an old request is never acted on again, e.g. when its task is selected again.
  const [handledRequest, setHandledRequest] = useState(toolLogFocus?.request)

  // A new request to show a turn of this task: switch to Tool calls and pass the turn to the log. Done while rendering
  // (React's pattern for adjusting state when a prop changes) so the right tab shows in the same commit.
  if (toolLogFocus !== null && toolLogFocus.taskId === task?.id && toolLogFocus.request !== handledRequest) {
    setHandledRequest(toolLogFocus.request)
    setTab(PanelTab.ToolCalls)
    setFocus({ turn: toolLogFocus.turn, request: toolLogFocus.request })
  }

  const clearFocus = useCallback(() => {
    setFocus(null)
  }, [])

  const tabs: readonly TabItem<PanelTab>[] = [
    { value: PanelTab.ToolCalls, label: 'Tool calls', count: toolCallCount(events) },
    { value: PanelTab.Files, label: 'Files' },
    { value: PanelTab.Todos, label: 'Todos' },
    { value: PanelTab.Artifacts, label: 'Artifacts' },
    { value: PanelTab.Subagents, label: 'Subagents' },
  ]

  return (
    <RightPanel
      tabs={
        <>
          <Tabs id={TABS_ID} label="Task panels" tabs={tabs} value={tab} onChange={setTab} />
          <span className={styles.spacer} />
          <Button
            variant={ButtonVariant.Icon}
            icon={faTableColumns}
            aria-label="Collapse side panel"
            title="Collapse side panel"
          />
        </>
      }
    >
      <TabPanel tabsId={TABS_ID} value={tab} className={styles.panel}>
        {tab === PanelTab.ToolCalls ? (
          task !== undefined && (
            <ToolLog
              key={task.id}
              taskId={task.id}
              events={events}
              rootPath={rootPath}
              focus={focus}
              onFocusShown={clearFocus}
            />
          )
        ) : (
          <p className={styles.empty}>{EMPTY_STATES[tab]}</p>
        )}
      </TabPanel>
    </RightPanel>
  )
}
