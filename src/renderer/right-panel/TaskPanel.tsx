import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PermissionMark, PermissionRequest, TaskCommit, ToolEvent, Watcher } from '../../shared/domain'
import { ArtifactsTab } from '../artifacts'
import { ChangesTab } from '../changes'
import { TabPanel, Tabs, type TabItem } from '../components'
import { FilesTab, type FileLineFocus } from '../files'
import { RightPanel } from '../layout'
import { usePresence } from '../motion'
import { Panel, PanelToggle, usePanel, usePanelSize } from '../panels'
import { permissionLinesByToolUse } from '../permissions/permissionLines'
import { selectSelectedTask, selectSelectedWorkspace } from '../store/state'
import { useGladeStore } from '../store/react'
import { SubagentsTab, type SubagentShown } from '../subagents'
import { TodoHub, Todos } from '../todos'
import { ToolLog, type TurnFocus } from '../tool-log'
import { WatchersTab } from '../watchers'
import { NOW_REFRESH_MS, useNow } from '../task-list/useNow'
import { activePanelTab, formatCount, PanelTab, panelTabEntry } from './panelModel'
import { PANEL_TAB_DEFINITIONS } from './panelTabs'
import styles from './TaskPanel.module.css'

const TABS_ID = 'task-panel'

const NO_TOOL_EVENTS: readonly ToolEvent[] = []
const NO_WATCHERS: readonly Watcher[] = []
const NO_COMMITS: readonly TaskCommit[] = []
const NO_PERMISSION_REQUESTS: readonly PermissionRequest[] = []
const NO_PERMISSION_MARKS: readonly PermissionMark[] = []

/**
 * The right panel of the task card: the tab bar (Tool calls, Files, Todos, Artifacts, Subagents, Watchers, Changes,
 * each with its count) and the selected tab. Tool calls and Subagents show, on each call's row, what was decided about
 * its permission request (#459). The selected tab is kept in UI state per workspace (#432): switching
 * workspace shows that workspace's tab, and a relaunch keeps every workspace's. The width and whether the panel is
 * collapsed are kept in UI state for the whole window; collapsed, the panel shows nothing. It slides open and shut.
 * When the chat asks to show a turn of the selected task (its tool-call chip), the store opens Tool calls and the log
 * scrolls to that turn; when the agent shows a file (`show_file`), the store opens Files and the viewer marks its line.
 */
export function TaskPanel(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  const workspace = useGladeStore(selectSelectedWorkspace)
  const rootPath = workspace?.rootPath
  const events =
    useGladeStore((state) => (task === undefined ? undefined : state.toolEvents[task.id])) ?? NO_TOOL_EVENTS
  const todos = useGladeStore((state) => (task === undefined ? undefined : state.todos[task.id]))
  const watchers = useGladeStore((state) => (task === undefined ? undefined : state.watchers[task.id])) ?? NO_WATCHERS
  const commits = useGladeStore((state) => (task === undefined ? undefined : state.commits[task.id])) ?? NO_COMMITS
  const permissionRequests =
    useGladeStore((state) => (task === undefined ? undefined : state.permissionRequests[task.id])) ??
    NO_PERMISSION_REQUESTS
  const permissionMarks =
    useGladeStore((state) => (task === undefined ? undefined : state.permissionMarks[task.id])) ?? NO_PERMISSION_MARKS
  // Each call's permission line, by its tool_use id: made again only when a request opens or closes or a call is
  // marked, and the rows tell their own by value, so only the row it changed for renders.
  const permissions = useMemo(
    () => permissionLinesByToolUse(permissionRequests, permissionMarks),
    [permissionRequests, permissionMarks],
  )
  const counts = useGladeStore(
    useShallow((state) =>
      PANEL_TAB_DEFINITIONS.map(({ count }) => (task === undefined ? undefined : formatCount(count(state, task.id)))),
    ),
  )
  const uiState = useGladeStore((state) => state.uiState)
  const tab = workspace === undefined ? PanelTab.ToolCalls : activePanelTab(uiState, workspace.id)
  // The Todos tab as the hub (P16), behind its hidden switch until #501; no other tab changes with it.
  const todoHub = useGladeStore((state) => state.settings.todoHubEnabled)
  // Only the Todos and Artifacts tabs show relative times ("updated 4m ago", "12m ago"). The hub's keep their own
  // clocks, so the panel doesn't tick for it.
  const ticking = (tab === PanelTab.Todos && !todoHub) || tab === PanelTab.Artifacts
  const now = useNow(ticking ? NOW_REFRESH_MS : null)
  const { size: width, setSize: keepWidth } = usePanelSize(Panel.RightPanel)
  const { collapsed } = usePanel(Panel.RightPanel)
  const presence = usePresence(!collapsed)
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
  const subagentFocus = useGladeStore((state) => state.subagentFocus)
  const [handledSubagentRequest, setHandledSubagentRequest] = useState(subagentFocus?.request)
  // The subagent last asked to show, and its task, until the Subagents tab has shown it. Tracked here, since the tab
  // may only mount in answer to the request (the store opens it, and the panel, for it).
  const [subagentShown, setSubagentShown] = useState<(SubagentShown & { readonly taskId: string }) | null>(null)
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

  // A new request to show a subagent of this task: pass it to the tab (the store has already opened it).
  if (subagentFocus !== null && subagentFocus.taskId === task?.id && subagentFocus.request !== handledSubagentRequest) {
    setHandledSubagentRequest(subagentFocus.request)
    setSubagentShown(subagentFocus)
  }

  const clearFocus = useCallback(() => {
    setFocus(null)
  }, [])

  const clearSubagentShown = useCallback(() => {
    setSubagentShown(null)
  }, [])

  const selectTab = (next: PanelTab): void => {
    if (next !== tab && workspace !== undefined) void setUiState(panelTabEntry(uiState, workspace.id, next))
  }

  // Close (⌘W) closes the file showing in Files while the focus is in the panel; anywhere else it closes the window, as
  // ever. The focus stays in the panel, on the tab's content, so another ⌘W closes the next file rather than the window.
  const closeActiveFile = (event: Event): void => {
    if (tab !== PanelTab.Files || task === undefined || activeFile === null) return
    event.preventDefault()
    const panel = event.currentTarget as HTMLElement
    void closeFile(task.id, activeFile).then(() => {
      if (!panel.contains(document.activeElement)) panel.querySelector<HTMLElement>('[role="tabpanel"]')?.focus()
    })
  }

  if (!presence.mounted) return null

  const tabContent = (): React.ReactNode => {
    switch (tab) {
      case PanelTab.ToolCalls:
        return (
          task !== undefined && (
            <ToolLog
              key={task.id}
              taskId={task.id}
              events={events}
              rootPath={rootPath}
              permissions={permissions}
              focus={focus}
              onFocusShown={clearFocus}
            />
          )
        )
      case PanelTab.Todos:
        if (task === undefined) return false
        return todoHub ? (
          <TodoHub key={task.id} taskId={task.id} list={todos} />
        ) : (
          <Todos taskId={task.id} list={todos} now={now} />
        )
      case PanelTab.Subagents:
        return (
          task !== undefined && (
            <SubagentsTab
              key={task.id}
              taskId={task.id}
              events={events}
              rootPath={rootPath}
              permissions={permissions}
              watchers={watchers}
              focus={subagentShown?.taskId === task.id ? subagentShown : null}
              onFocusShown={clearSubagentShown}
            />
          )
        )
      case PanelTab.Files:
        return (
          task !== undefined &&
          rootPath !== undefined && (
            <FilesTab
              key={task.id}
              taskId={task.id}
              rootPath={rootPath}
              focus={fileLine?.taskId === task.id ? fileLine : null}
            />
          )
        )
      case PanelTab.Artifacts:
        return task !== undefined && <ArtifactsTab key={task.id} taskId={task.id} now={now} />
      case PanelTab.Watchers:
        return task !== undefined && <WatchersTab key={task.id} taskId={task.id} watchers={watchers} />
      case PanelTab.Changes:
        return task !== undefined && <ChangesTab key={task.id} taskId={task.id} commits={commits} events={events} />
    }
  }

  const tabs: readonly TabItem<PanelTab>[] = PANEL_TAB_DEFINITIONS.map(({ tab: value, label }, index) => ({
    value,
    label,
    count: counts[index],
  }))

  return (
    <RightPanel
      motion={presence.phase}
      width={width}
      onWidthChange={keepWidth}
      onCloseRequest={closeActiveFile}
      tabs={
        <>
          {/* In a narrow panel the tabs scroll sideways (see Tabs) rather than push the collapse button out of reach. */}
          <Tabs id={TABS_ID} label="Task panels" tabs={tabs} value={tab} onChange={selectTab} />
          <span className={styles.spacer} />
          <PanelToggle panel={Panel.RightPanel} className={styles.collapse} />
        </>
      }
    >
      <TabPanel tabsId={TABS_ID} value={tab} className={styles.panel}>
        {tabContent()}
      </TabPanel>
    </RightPanel>
  )
}
