import { faTableColumns } from '@fortawesome/free-solid-svg-icons'
import { useCallback, useState, type KeyboardEvent } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { UiStateKey, type ToolEvent } from '../../shared/domain'
import { Button, ButtonVariant, TabPanel, Tabs, type TabItem } from '../components'
import { FilesTab, isCloseFileKey, type FileLineFocus } from '../files'
import { RightPanel } from '../layout'
import { selectSelectedTask, selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import { ToolLog, type TurnFocus } from '../tool-log'
import { formatCount, isPanelCollapsed, PanelTab, parsePanelTab, parsePanelWidth } from './panelModel'
import { PANEL_TAB_DEFINITIONS } from './panelTabs'
import styles from './TaskPanel.module.css'

const TABS_ID = 'task-panel'

/** What each tab not built yet shows. */
const EMPTY_STATES: Readonly<Record<Exclude<PanelTab, PanelTab.ToolCalls | PanelTab.Files>, string>> = {
  [PanelTab.Todos]: 'No todos yet.',
  [PanelTab.Artifacts]: 'No artifacts yet.',
  [PanelTab.Subagents]: 'No subagents yet.',
}

const NO_TOOL_EVENTS: readonly ToolEvent[] = []

/**
 * The right panel of the task card: the tab bar (Tool calls, Files, Todos, Artifacts, Subagents, each with its count)
 * and the selected tab. Tool calls and Files are built; the others show an empty state. The selected tab, the width
 * and whether the panel is collapsed are kept in UI state, for the whole window; collapsed, the panel shows nothing.
 * When the chat asks to show a turn of the selected task (its tool-call chip), the store opens Tool calls and the log
 * scrolls to that turn; when the agent shows a file (`show_file`), the store opens Files and the viewer marks its line.
 */
export function TaskPanel(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  const rootPath = useGladeStore((state) => selectSelectedWorkspace(state)?.rootPath)
  const events =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
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
  const activeFile = useGladeStore((state) =>
    task === undefined ? null : (state.openFiles[task.id]?.activePath ?? null),
  )
  const closeFile = useGladeStore((state) => state.closeFile)
  const fileFocus = useGladeStore((state) => state.fileFocus)
  // The line the agent last asked to show, and its task. Tracked here, not in the Files tab, which may only mount in
  // answer to the request (the store opens the tab for it).
  const [fileLine, setFileLine] = useState<(FileLineFocus & { readonly taskId: string }) | null>(null)
  const [handledFileRequest, setHandledFileRequest] = useState(fileFocus?.request)
  const [focus, setFocus] = useState<TurnFocus | null>(null)
  // The last request acted on, so an old request is never acted on again, e.g. when its task is selected again.
  const [handledRequest, setHandledRequest] = useState(toolLogFocus?.request)

  // A new request to show a turn of this task: pass the turn to the log (the store has already opened Tool calls).
  // Done while rendering (React's pattern for adjusting state when a prop changes) so it shows in the same commit.
  if (toolLogFocus !== null && toolLogFocus.taskId === task?.id && toolLogFocus.request !== handledRequest) {
    setHandledRequest(toolLogFocus.request)
    setFocus({ turn: toolLogFocus.turn, request: toolLogFocus.request })
  }

  // A new request to show a file of this task: mark its line (the store has already opened the file and this tab).
  if (fileFocus !== null && fileFocus.taskId === task?.id && fileFocus.request !== handledFileRequest) {
    setHandledFileRequest(fileFocus.request)
    setFileLine(fileFocus)
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

  // ⌘W closes the file showing in Files while the focus is in the panel; anywhere else it closes the window, as ever.
  // The focus stays in the panel, on the tab's content, so another ⌘W closes the next file rather than the window.
  const closeActiveFile = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (tab !== PanelTab.Files || task === undefined || activeFile === null || !isCloseFileKey(event)) return
    event.preventDefault()
    const panel = event.currentTarget
    void closeFile(task.id, activeFile).then(() => {
      if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('[role="tabpanel"]')?.focus()
    })
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
      onKeyDown={closeActiveFile}
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
        ) : tab === PanelTab.Files ? (
          task !== undefined &&
          rootPath !== undefined && (
            <FilesTab
              key={task.id}
              taskId={task.id}
              rootPath={rootPath}
              focus={fileLine?.taskId === task.id ? fileLine : null}
            />
          )
        ) : (
          <p className={styles.empty}>{EMPTY_STATES[tab]}</p>
        )}
      </TabPanel>
    </RightPanel>
  )
}
