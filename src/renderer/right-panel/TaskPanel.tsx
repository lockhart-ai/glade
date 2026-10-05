import { useCallback, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { PermissionMark, PermissionRequest } from '../../shared/domain'
import { AgentsTab } from '../agents'
import { TabPanel, Tabs, type TabItem } from '../components'
import { FilesTab, type FileLineFocus } from '../files'
import { RightPanel } from '../layout'
import { usePresence } from '../motion'
import { Panel, PanelToggle, usePanel, usePanelSize } from '../panels'
import { permissionLinesByToolUse } from '../permissions/permissionLines'
import { selectSelectedTask, selectSelectedWorkspace, type TodoFocus } from '../store/state'
import { useGladeStore } from '../store/react'
import { TodoHub } from '../todos'
import type { TurnFocus } from '../tool-log'
import { activePanelTab, FIRST_PANEL_TAB, formatCount, PanelTab, panelTabEntry } from './panelModel'
import { PANEL_TAB_DEFINITIONS } from './panelTabs'
import styles from './TaskPanel.module.css'

const TABS_ID = 'task-panel'

const NO_PERMISSION_REQUESTS: readonly PermissionRequest[] = []
const NO_PERMISSION_MARKS: readonly PermissionMark[] = []

/**
 * The right panel of the task card: the tab bar (Agents, Files, Todos, each with its count) and the selected tab
 * (P16, #491). Agents is what's happening: a tab for every agent in the task, each with its tool calls and its
 * watchers, and on each call's row what was decided about its permission request (#459). Todos is what the work
 * produced: each todo with its files, links and changes.
 *
 * The selected tab is kept in UI state per workspace (#432): switching workspace shows that workspace's tab, and a
 * relaunch keeps every workspace's. One left on a tab the panel no longer has opens on Agents. The width and whether
 * the panel is collapsed are kept in UI state for the whole window; collapsed, the panel shows nothing. It slides
 * open and shut.
 *
 * When the chat asks to show a turn of the selected task (its tool-call chip), the store opens Agents on Main's tab
 * and its log scrolls to that turn; when the agent shows a file (`show_file`), the store opens Files and the viewer
 * marks its line; and when something asks to show a todo, the store opens Todos and the hub opens that todo.
 *
 * The panel reads none of the task's tool log, watchers or commits itself: Agents and Todos read their own, so the
 * panel doesn't render with every event.
 */
export function TaskPanel(): React.JSX.Element | null {
  const task = useGladeStore(selectSelectedTask)
  const workspace = useGladeStore(selectSelectedWorkspace)
  const rootPath = workspace?.rootPath
  const todos = useGladeStore((state) => (task === undefined ? undefined : state.todos[task.id]))
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
  const tab = workspace === undefined ? FIRST_PANEL_TAB : activePanelTab(uiState, workspace.id)
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
  const todoFocus = useGladeStore((state) => state.todoFocus)
  const [handledTodoRequest, setHandledTodoRequest] = useState(todoFocus?.request)
  // The todo last asked to show, and its task, until the hub has shown it: the hub may only mount in answer to the
  // request.
  const [todoShown, setTodoShown] = useState<TodoFocus | null>(null)
  // The last request acted on, so an old request is never acted on again, e.g. when its task is selected again.
  const [handledRequest, setHandledRequest] = useState(toolLogFocus?.request)

  // A new request to show a turn of this task: pass the turn to the log (the store has already opened Agents on Main).
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

  const clearFocus = useCallback(() => {
    setFocus(null)
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
    if (task === undefined) return false
    switch (tab) {
      case PanelTab.Agents:
        return (
          <AgentsTab
            key={task.id}
            taskId={task.id}
            rootPath={rootPath}
            permissions={permissions}
            focus={focus}
            onFocusShown={clearFocus}
          />
        )
      case PanelTab.Files:
        return (
          rootPath !== undefined && (
            <FilesTab
              key={task.id}
              taskId={task.id}
              rootPath={rootPath}
              focus={fileLine?.taskId === task.id ? fileLine : null}
            />
          )
        )
      case PanelTab.Todos:
        return (
          <TodoHub
            key={task.id}
            taskId={task.id}
            list={todos}
            focus={todoShown?.taskId === task.id ? todoShown : null}
            onFocusShown={clearTodoShown}
          />
        )
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
