import type { ReactNode } from 'react'
import { Chat } from './chat'
import { classNames } from './components/classNames'
import { ContextMeter } from './context-meter'
import { ToastProvider } from './components'
import { FirstRun } from './first-run/FirstRun'
import { InputBar } from './input-bar'
import { PauseBanner } from './pause/PauseBanner'
import { AppShell, BottomBar, Sidebar, SidebarHeader, TaskCard } from './layout'
import styles from './App.module.css'
import { HydrationStatus, selectSelectedWorkspace } from './store/state'
import { useGladeStore } from './store/react'
import { SelectedTaskHeader } from './task-header'
import { DeleteTaskDialog, TaskList, TaskListToolbar } from './task-list'
import { useNewTaskShortcut } from './shortcuts/useNewTaskShortcut'
import { useMarkDoneShortcut } from './shortcuts/useMarkDoneShortcut'
import { useMarkUnreadShortcut } from './shortcuts/useMarkUnreadShortcut'
import { usePinShortcut } from './shortcuts/usePinShortcut'
import { useRenameShortcut } from './shortcuts/useRenameShortcut'
import { useStopShortcut } from './shortcuts/useStopShortcut'
import { useCompactShortcut } from './shortcuts/useCompactShortcut'
import { useRightPanelShortcuts } from './shortcuts/useRightPanelShortcuts'
import { useWorkspaceShortcuts } from './shortcuts/useWorkspaceShortcuts'
import { WorkspaceSwitcher } from './workspace-switcher/WorkspaceSwitcher'
import { TaskPanel } from './right-panel'
import { RelaunchNotice } from './relaunch-notice'

interface PlaceholderProps {
  label: string
  className?: string
}

/** A labelled empty region, standing in for content that later tickets build. */
function Placeholder({ label, className }: PlaceholderProps): React.JSX.Element {
  return <div className={classNames(styles.placeholder, className)}>{label}</div>
}

interface WindowProps {
  sidebar: ReactNode
  task: ReactNode
  /** The app-wide banner, if any. */
  banner?: ReactNode
  overlay?: ReactNode
}

/** The window frame, with the bottom bar's placeholder until the terminal ticket fills it. */
function Window({ sidebar, task, banner, overlay }: WindowProps): React.JSX.Element {
  return (
    <AppShell
      banner={banner}
      sidebar={sidebar}
      task={task}
      overlay={overlay}
      bottomBar={
        <BottomBar
          terminalTabs={<Placeholder label="Terminal tabs" className={styles.tabs} />}
          terminal={<Placeholder label="Terminal" className={styles.fill} />}
        />
      }
    />
  )
}

/** What shows before there is any workspace: no workspace in the sidebar and the welcome in the task card. */
function FirstRunLayout(): React.JSX.Element {
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
    />
  )
}

/** The window layout, with a labelled placeholder in each region until the P1 tickets fill them. */
function Layout(): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  useNewTaskShortcut()
  useStopShortcut()
  useCompactShortcut()
  useMarkDoneShortcut()
  useMarkUnreadShortcut()
  usePinShortcut()
  useRenameShortcut()
  useRightPanelShortcuts()
  useWorkspaceShortcuts()
  return (
    <Window
      banner={<PauseBanner />}
      sidebar={
        <Sidebar>
          <WorkspaceSwitcher />
          {workspace !== undefined && (
            <>
              <TaskListToolbar workspaceId={workspace.id} />
              <TaskList workspaceId={workspace.id} />
            </>
          )}
        </Sidebar>
      }
      task={
        <TaskCard
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
