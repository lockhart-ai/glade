import type { ReactNode } from 'react'
import { Chat } from './chat'
import { classNames } from './components/classNames'
import { ToastProvider } from './components'
import { FirstRun } from './first-run/FirstRun'
import { AppShell, BottomBar, Sidebar, SidebarHeader, TaskCard, TaskHeader } from './layout'
import styles from './App.module.css'
import { HydrationStatus, selectSelectedWorkspace } from './store/state'
import { useGladeStore } from './store/react'
import { TaskList, TaskListToolbar } from './task-list'
import { TaskPanel } from './tool-log'

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
}

/** The window frame, with the bottom bar's placeholder until the terminal ticket fills it. */
function Window({ sidebar, task }: WindowProps): React.JSX.Element {
  return (
    <AppShell
      sidebar={sidebar}
      task={task}
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
  return (
    <Window
      sidebar={
        <Sidebar>
          <SidebarHeader workspace={workspace} />
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
          header={
            <TaskHeader>
              <Placeholder label="Task header" className={styles.header} />
            </TaskHeader>
          }
          chat={<Chat />}
          inputBar={<Placeholder label="Input bar" className={styles.inputBar} />}
          rightPanel={<TaskPanel />}
        />
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
