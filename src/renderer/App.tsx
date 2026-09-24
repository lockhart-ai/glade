import type { ReactNode } from 'react'
import { Chat } from './chat'
import { ContextMeter } from './context-meter'
import { ToastProvider } from './components'
import { FirstRun } from './first-run/FirstRun'
import { InputBar } from './input-bar'
import { PauseBanner } from './pause/PauseBanner'
import { AppShell, BottomBar, Sidebar, SidebarHeader, TaskCard } from './layout'
import { Panel, PanelToggle, usePanel } from './panels'
import styles from './App.module.css'
import { HydrationStatus, selectSelectedTask, selectSelectedWorkspace } from './store/state'
import { useGladeStore } from './store/react'
import { SelectedTaskHeader } from './task-header'
import { DeleteTaskDialog, isSearching, TaskList, TaskListToolbar } from './task-list'
import { SearchResults } from './search/SearchResults'
import { useNewTaskShortcut } from './shortcuts/useNewTaskShortcut'
import { useMarkDoneShortcut } from './shortcuts/useMarkDoneShortcut'
import { useMarkUnreadShortcut } from './shortcuts/useMarkUnreadShortcut'
import { usePinShortcut } from './shortcuts/usePinShortcut'
import { useRenameShortcut } from './shortcuts/useRenameShortcut'
import { useStopShortcut } from './shortcuts/useStopShortcut'
import { useCompactShortcut } from './shortcuts/useCompactShortcut'
import { usePanelShortcuts } from './shortcuts/usePanelShortcuts'
import { useRightPanelShortcuts } from './shortcuts/useRightPanelShortcuts'
import { useSettingsShortcut } from './shortcuts/useSettingsShortcut'
import { SettingsDialog } from './settings/SettingsDialog'
import { useSearchShortcut } from './shortcuts/useSearchShortcut'
import { useWorkspaceShortcuts } from './shortcuts/useWorkspaceShortcuts'
import { WorkspaceSwitcher } from './workspace-switcher/WorkspaceSwitcher'
import { TaskPanel } from './right-panel'
import { RelaunchNotice } from './relaunch-notice'
import { Terminal, TerminalTabs, useTerminalShortcuts } from './terminal'

interface WindowProps {
  /** The sidebar, or nothing while it's collapsed. */
  sidebar?: ReactNode
  task: ReactNode
  /** The app-wide banner, if any. */
  banner?: ReactNode
  overlay?: ReactNode
}

/**
 * The window frame, with the global terminal in the bottom bar, which collapses to its tab row. The terminal's own
 * shortcuts (⌃` and ⌘T) work wherever the focus is.
 */
function Window({ sidebar, task, banner, overlay }: WindowProps): React.JSX.Element {
  const bottomBar = usePanel(Panel.BottomBar)
  useTerminalShortcuts()
  return (
    <AppShell
      banner={banner}
      sidebar={sidebar}
      task={task}
      overlay={overlay}
      bottomBarCollapsed={bottomBar.collapsed}
      bottomBar={
        <BottomBar
          collapsed={bottomBar.collapsed}
          terminalTabs={<TerminalTabs />}
          terminal={<Terminal />}
          toggle={<PanelToggle panel={Panel.BottomBar} />}
        />
      }
    />
  )
}

/** The panels the first-run window can toggle: only the bottom bar, since it has no task list or task card. */
const FIRST_RUN_PANELS: readonly Panel[] = [Panel.BottomBar]

/** The panels the window can toggle once there's a workspace. */
const LAYOUT_PANELS: readonly Panel[] = [Panel.Sidebar, Panel.RightPanel, Panel.BottomBar]

/** What shows before there is any workspace: no workspace in the sidebar and the welcome in the task card. */
function FirstRunLayout(): React.JSX.Element {
  useSettingsShortcut()
  usePanelShortcuts(FIRST_RUN_PANELS)
  useWorkspaceShortcuts()
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
 */
function Layout(): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  const sidebar = usePanel(Panel.Sidebar)
  const hasTask = useGladeStore((state) => selectSelectedTask(state) !== undefined)
  usePanelShortcuts(LAYOUT_PANELS)
  const searching = useGladeStore((state) => isSearching(state.searchText))
  useNewTaskShortcut()
  useSearchShortcut()
  useStopShortcut()
  useCompactShortcut()
  useMarkDoneShortcut()
  useMarkUnreadShortcut()
  usePinShortcut()
  useRenameShortcut()
  useRightPanelShortcuts()
  useSettingsShortcut()
  useWorkspaceShortcuts()
  return (
    <Window
      banner={<PauseBanner />}
      sidebar={
        sidebar.collapsed ? undefined : (
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
      task={
        <TaskCard
          clearTrafficLights={sidebar.collapsed}
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
          <SettingsDialog />
        </>
      }
    />
  )
}

export function App(): React.JSX.Element {
  const hydration = useGladeStore((state) => state.hydration)
  const hasWorkspace = useGladeStore((state) => state.workspaces.length > 0)
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
      return <ToastProvider>{hasWorkspace ? <Layout /> : <FirstRunLayout />}</ToastProvider>
  }
}
