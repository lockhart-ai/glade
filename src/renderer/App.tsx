import type { ReactNode } from 'react'
import { Chat } from './chat'
import { ContextMeter } from './context-meter'
import { ToastProvider } from './components'
import { FirstRun } from './first-run/FirstRun'
import { InputBar } from './input-bar'
import { PauseBanner } from './pause/PauseBanner'
import { AppShell, BottomBar, Sidebar, SidebarHeader, TaskCard } from './layout'
import { isMoving, MotionPhase, usePresence } from './motion'
import { Panel, PanelToggle, usePanel, usePanelSize } from './panels'
import styles from './App.module.css'
import { HydrationStatus, selectSelectedTask, selectSelectedWorkspace } from './store/state'
import { useGladeStore } from './store/react'
import { SelectedTaskHeader } from './task-header'
import { DeleteTaskDialog, isSearching, TaskList, TaskListToolbar } from './task-list'
import { SearchResults } from './search/SearchResults'
import { useStopShortcut } from './shortcuts/useStopShortcut'
import { useCompactShortcut } from './shortcuts/useCompactShortcut'
import { useRightPanelShortcuts } from './shortcuts/useRightPanelShortcuts'
import { SettingsDialog } from './settings/SettingsDialog'
import { useSearchShortcut } from './shortcuts/useSearchShortcut'
import { MenuBar } from './commands/MenuBar'
import { RemoveWorkspaceDialog } from './commands/RemoveWorkspaceDialog'
import { WorkspaceSwitcher } from './workspace-switcher/WorkspaceSwitcher'
import { TaskPanel } from './right-panel'
import { RelaunchNotice } from './relaunch-notice'
import { Terminal, TerminalTabs, useTerminalShortcuts } from './terminal'
import { PluginPanel } from './plugins'

interface WindowProps {
  /** The sidebar, or nothing while it's collapsed. */
  sidebar?: ReactNode
  /** Whether the sidebar is sliding open or shut, or still. */
  sidebarMotion?: MotionPhase
  task: ReactNode
  /** Whether the task card shows the right panel beside the chat (it does unless it's collapsed). */
  taskHasRightPanel?: boolean
  /** The app-wide banner, if any. */
  banner?: ReactNode
  overlay?: ReactNode
}

/**
 * The window frame, with the global terminal in the bottom bar, which slides shut to its tab row. The sidebar and the
 * bottom bar keep the sizes you drag them to. The terminal's own shortcuts (⌃` and ⌘T) work wherever the focus is.
 */
function Window({
  sidebar,
  sidebarMotion,
  task,
  taskHasRightPanel = false,
  banner,
  overlay,
}: WindowProps): React.JSX.Element {
  const bottomBar = usePanel(Panel.BottomBar)
  const bottomBarMotion = usePresence(!bottomBar.collapsed).phase
  const sidebarWidth = usePanelSize(Panel.Sidebar)
  const bottomBarHeight = usePanelSize(Panel.BottomBar)
  useTerminalShortcuts()
  return (
    <AppShell
      banner={banner}
      sidebar={sidebar}
      sidebarMotion={sidebarMotion}
      sidebarWidth={sidebarWidth.size}
      onSidebarWidthChange={sidebarWidth.setSize}
      task={task}
      taskHasRightPanel={taskHasRightPanel}
      overlay={overlay}
      bottomBarCollapsed={bottomBarMotion === MotionPhase.Hidden}
      bottomBarMotion={bottomBarMotion}
      bottomBarHeight={bottomBarHeight.size}
      onBottomBarHeightChange={bottomBarHeight.setSize}
      bottomBar={
        <BottomBar
          collapsed={bottomBarMotion === MotionPhase.Hidden}
          motion={bottomBarMotion}
          terminalTabs={<TerminalTabs />}
          terminal={<Terminal />}
          plugin={<PluginPanel collapsed={bottomBarMotion === MotionPhase.Hidden} moving={isMoving(bottomBarMotion)} />}
          toggle={<PanelToggle panel={Panel.BottomBar} />}
        />
      }
    />
  )
}

/**
 * What shows while no workspace is: before there is any, or once the last one shown is closed. No workspace in the
 * sidebar and the welcome in the task card.
 */
function FirstRunLayout(): React.JSX.Element {
  return (
    <Window
      sidebar={
        <Sidebar>
          <SidebarHeader />
          <p className={styles.sidebarNote}>Tasks will appear here once you open a workspace.</p>
        </Sidebar>
      }
      task={<FirstRun />}
      overlay={<SettingsDialog />}
    />
  )
}

/**
 * The window layout: the sidebar, the task card and the bottom bar. While the sidebar is collapsed, a button at the top
 * left of the task card shows it again: at the start of the task header, or on a row of its own with no task selected.
 * The sidebar slides open and shut, and stays on screen while it slides shut.
 */
function Layout(): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  const sidebar = usePanel(Panel.Sidebar)
  const sidebarPresence = usePresence(!sidebar.collapsed)
  const rightPanel = usePanel(Panel.RightPanel)
  const hasTask = useGladeStore((state) => selectSelectedTask(state) !== undefined)
  const searching = useGladeStore((state) => isSearching(state.searchText))
  // The menu bar answers the other shortcuts (see `MenuBar`).
  useSearchShortcut()
  useStopShortcut()
  useCompactShortcut()
  useRightPanelShortcuts()
  return (
    <Window
      banner={<PauseBanner />}
      sidebarMotion={sidebarPresence.phase}
      sidebar={
        !sidebarPresence.mounted ? undefined : (
          <Sidebar>
            <WorkspaceSwitcher collapseButton={<PanelToggle panel={Panel.Sidebar} />} />
            {workspace !== undefined && (
              <>
                <TaskListToolbar workspaceId={workspace.id} />
                {searching ? <SearchResults workspaceId={workspace.id} /> : <TaskList workspaceId={workspace.id} />}
              </>
            )}
          </Sidebar>
        )
      }
      taskHasRightPanel={!rightPanel.collapsed}
      task={
        <TaskCard
          titleBar={sidebar.collapsed && !hasTask ? <PanelToggle panel={Panel.Sidebar} /> : undefined}
          header={<SelectedTaskHeader />}
          chat={<Chat />}
          inputBar={<InputBar contextMeter={<ContextMeter />} />}
          rightPanel={<TaskPanel />}
        />
      }
      overlay={
        <>
          <RelaunchNotice />
          <DeleteTaskDialog />
          <RemoveWorkspaceDialog />
          <SettingsDialog />
        </>
      }
    />
  )
}

export function App(): React.JSX.Element {
  const hydration = useGladeStore((state) => state.hydration)
  const hasWorkspace = useGladeStore((state) => state.selectedWorkspaceId !== null)
  switch (hydration.status) {
    case HydrationStatus.Loading:
      return (
        <main className={styles.status} aria-busy="true">
          Loading…
        </main>
      )
    case HydrationStatus.Failed:
      return <main className={styles.status}>Glade couldn’t load: {hydration.message}</main>
    case HydrationStatus.Ready:
      return (
        <ToastProvider>
          <MenuBar />
          {hasWorkspace ? <Layout /> : <FirstRunLayout />}
        </ToastProvider>
      )
  }
}
