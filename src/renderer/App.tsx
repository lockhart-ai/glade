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
 */
function Layout(): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  const sidebar = usePanel(Panel.Sidebar)
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
