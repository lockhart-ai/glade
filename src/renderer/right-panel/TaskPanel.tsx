import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PermissionMark, PermissionRequest, TaskCommit, ToolEvent, Watcher } from '../../shared/domain'
import { AgentsTab } from '../agents'
import { ArtifactsTab } from '../artifacts'
import { ChangesTab } from '../changes'
import { TabPanel, Tabs, type TabItem } from '../components'
import { FilesTab, type FileLineFocus } from '../files'
import { RightPanel } from '../layout'
import { usePresence } from '../motion'
import { Panel, PanelToggle, usePanel, usePanelSize } from '../panels'
import { permissionLinesByToolUse } from '../permissions/permissionLines'
import { selectSelectedTask, selectSelectedWorkspace, type TodoFocus } from '../store/state'
import { useGladeStore } from '../store/react'
import { SubagentsTab, type SubagentShown } from '../subagents'
import { TodoHub, Todos } from '../todos'
import { ToolLog, type TurnFocus } from '../tool-log'
import { WatchersTab } from '../watchers'
import { NOW_REFRESH_MS, useNow } from '../task-list/useNow'
import { activePanelTab, firstPanelTab, formatCount, PanelTab, panelTabEntry } from './panelModel'
import { panelTabDefinitions } from './panelTabs'
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
 *
 * With the todo hub on (P16, #491; the hidden `todoHubEnabled` setting) the tab bar is Agents · Files · Todos: Agents
 * (#536) takes the place of Tool calls, Subagents and Watchers, and the hub of Todos, Artifacts and Changes. A
 * workspace left on a tab that isn't shown opens on the first one. The chip then opens Agents on Main's tab, at its turn.
 */
export function TaskPanel(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  const workspace = useGladeStore(selectSelectedWorkspace)
  const rootPath = workspace?.rootPath
  // The three tabs (P16, #491), behind their hidden switch until #501: with it off, the panel is today's seven.
  const todoHub = useGladeStore((state) => state.settings.todoHubEnabled)
  // The task's tool log, watchers and commits are what the tabs the hub replaces show. With the hub on the panel reads
  // none of them: the Agents tab and the hub read their own, so the panel doesn't render with every event.
  const logsOf = task === undefined || todoHub ? undefined : task.id
  const events =
    useGladeStore((state) => (logsOf === undefined ? undefined : state.toolEvents[logsOf])) ?? NO_TOOL_EVENTS
  const todos = useGladeStore((state) => (task === undefined ? undefined : state.todos[task.id]))
  const watchers = useGladeStore((state) => (logsOf === undefined ? undefined : state.watchers[logsOf])) ?? NO_WATCHERS
  const commits = useGladeStore((state) => (logsOf === undefined ? undefined : state.commits[logsOf])) ?? NO_COMMITS
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
  const definitions = panelTabDefinitions(todoHub)
  const counts = useGladeStore(
    useShallow((state) =>
      definitions.map(({ count }) => (task === undefined ? undefined : formatCount(count(state, task.id)))),
    ),
  )
  const uiState = useGladeStore((state) => state.uiState)
  const tab = workspace === undefined ? firstPanelTab(todoHub) : activePanelTab(uiState, workspace.id, todoHub)
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
  const todoFocus = useGladeStore((state) => state.todoFocus)
  const [handledTodoRequest, setHandledTodoRequest] = useState(todoFocus?.request)
  // The todo last asked to show, and its task, until the hub has shown it: like the subagent, the hub may only mount
  // in answer to the request.
  const [todoShown, setTodoShown] = useState<TodoFocus | null>(null)
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

  // A new request to show a todo of this task: pass it to the hub (the store has already opened Todos).
  if (todoFocus !== null && todoFocus.taskId === task?.id && todoFocus.request !== handledTodoRequest) {
    setHandledTodoRequest(todoFocus.request)
    setTodoShown(todoFocus)
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

  const clearTodoShown = useCallback(() => {
    setTodoShown(null)
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
      case PanelTab.Agents:
        return (
          task !== undefined && (
            <AgentsTab
              key={task.id}
              taskId={task.id}
              rootPath={rootPath}
              permissions={permissions}
              focus={focus}
              onFocusShown={clearFocus}
            />
          )
        )
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
          <TodoHub
            key={task.id}
            taskId={task.id}
            list={todos}
            focus={todoShown?.taskId === task.id ? todoShown : null}
            onFocusShown={clearTodoShown}
          />
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

  const tabs: readonly TabItem<PanelTab>[] = definitions.map(({ tab: value, label }, index) => ({
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
