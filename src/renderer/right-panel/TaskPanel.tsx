import { faTableColumns } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { UiStateKey, type ToolEvent } from '../../shared/domain'
import { Button, ButtonVariant, TabPanel, Tabs, type TabItem } from '../components'
import { RightPanel } from '../layout'
import { selectSelectedTask, selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import { Todos } from '../todos'
import { ToolLog, type TurnFocus } from '../tool-log'
import { useNow } from '../task-list/useNow'
import { formatCount, isPanelCollapsed, PanelTab, parsePanelTab, parsePanelWidth } from './panelModel'
import { PANEL_TAB_DEFINITIONS } from './panelTabs'
import styles from './TaskPanel.module.css'

const TABS_ID = 'task-panel'

/** What each tab not built yet shows. */
const EMPTY_STATES: Readonly<Record<Exclude<PanelTab, PanelTab.ToolCalls | PanelTab.Todos>, string>> = {
  [PanelTab.Files]: 'No files yet.',
  [PanelTab.Artifacts]: 'No artifacts yet.',
  [PanelTab.Subagents]: 'No subagents yet.',
}

const NO_TOOL_EVENTS: readonly ToolEvent[] = []

/**
 * The right panel of the task card: the tab bar (Tool calls, Files, Todos, Artifacts, Subagents, each with its count)
 * and the selected tab. Tool calls and Todos are built so far; the others show an empty state. The selected tab, the width
 * and whether the panel is collapsed are kept in UI state, for the whole window; collapsed, the panel shows nothing.
 * When the chat asks to show a turn of the selected task (its tool-call chip), the store opens Tool calls and the log
 * scrolls to that turn.
 */
export function TaskPanel(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  const rootPath = useGladeStore((state) => selectSelectedWorkspace(state)?.rootPath)
  const events =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
  const todos = useGladeStore((state) => (task === undefined ? undefined : state.todos[task.id]))
  const now = useNow()
  const counts = useGladeStore(
    useShallow((state) =>
      PANEL_TAB_DEFINITIONS.map(({ count }) => (task === undefined ? undefined : formatCount(count(state, task.id)))),
    ),
  )
  const tab = useGladeStore((state) => parsePanelTab(state.uiState[UiStateKey.RightPanelTab]))
  const width = useGladeStore((state) => parsePanelWidth(state.uiState[UiStateKey.RightPanelWidth]))
  const collapsed = useGladeStore((state) => isPanelCollapsed(state.uiState[UiStateKey.RightPanelCollapsed]))
  const setUiState = useGladeStore((state) => state.setUiState)
  const toolLogFocus = useGladeStore((state) => state.toolLogFocus)
  const [focus, setFocus] = useState<TurnFocus | null>(null)
  // The last request acted on, so an old request is never acted on again, e.g. when its task is selected again.
  const [handledRequest, setHandledRequest] = useState(toolLogFocus?.request)

  // A new request to show a turn of this task: pass the turn to the log (the store has already opened Tool calls).
  // Done while rendering (React's pattern for adjusting state when a prop changes) so it shows in the same commit.
  if (toolLogFocus !== null && toolLogFocus.taskId === task?.id && toolLogFocus.request !== handledRequest) {
    setHandledRequest(toolLogFocus.request)
    setFocus({ turn: toolLogFocus.turn, request: toolLogFocus.request })
  }

  const clearFocus = useCallback(() => {
    setFocus(null)
  }, [])

  const selectTab = (next: PanelTab): void => {
    if (next !== tab) void setUiState({ key: UiStateKey.RightPanelTab, value: next })
  }

  const keepWidth = (next: number): void => {
    if (next !== width) void setUiState({ key: UiStateKey.RightPanelWidth, value: String(next) })
  }

  if (collapsed) return null

  const tabs: readonly TabItem<PanelTab>[] = PANEL_TAB_DEFINITIONS.map(({ tab: value, label }, index) => ({
    value,
    label,
    count: counts[index],
  }))

  return (
    <RightPanel
      width={width}
      onWidthChange={keepWidth}
      tabs={
        <>
          <Tabs id={TABS_ID} label="Task panels" tabs={tabs} value={tab} onChange={selectTab} className={styles.tabs} />
          <span className={styles.spacer} />
          <Button
            variant={ButtonVariant.Icon}
            icon={faTableColumns}
            aria-label="Collapse side panel"
            title="Collapse side panel"
            className={styles.collapse}
            onClick={() => void setUiState({ key: UiStateKey.RightPanelCollapsed, value: 'true' })}
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
        ) : tab === PanelTab.Todos ? (
          task !== undefined && <Todos list={todos} now={now} />
        ) : (
          <p className={styles.empty}>{EMPTY_STATES[tab]}</p>
        )}
      </TabPanel>
    </RightPanel>
  )
}
