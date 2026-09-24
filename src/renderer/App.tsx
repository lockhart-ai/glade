import { classNames } from './components/classNames'
import { AppShell, BottomBar, RightPanel, Sidebar, TaskCard, TaskHeader } from './layout'
import styles from './App.module.css'
import { HydrationStatus } from './store/state'
import { useGladeStore } from './store/react'

interface PlaceholderProps {
  label: string
  className?: string
}

/** A labelled empty region, standing in for content that later tickets build. */
function Placeholder({ label, className }: PlaceholderProps): React.JSX.Element {
  return <div className={classNames(styles.placeholder, className)}>{label}</div>
}

/** The window layout, with a labelled placeholder in each region until the P1 tickets fill them. */
function Layout(): React.JSX.Element {
  return (
    <AppShell
      sidebar={
        <Sidebar>
          <Placeholder label="Sidebar" className={styles.fill} />
        </Sidebar>
      }
      task={
        <TaskCard
          header={
            <TaskHeader>
              <Placeholder label="Task header" className={styles.header} />
            </TaskHeader>
          }
          chat={<Placeholder label="Chat" className={styles.fill} />}
          inputBar={<Placeholder label="Input bar" className={styles.inputBar} />}
          rightPanel={
            <RightPanel tabs={<Placeholder label="Tabs" className={styles.tabs} />}>
              <Placeholder label="Right panel" className={styles.fill} />
            </RightPanel>
          }
        />
      }
      bottomBar={
        <BottomBar
          terminalTabs={<Placeholder label="Terminal tabs" className={styles.tabs} />}
          terminal={<Placeholder label="Terminal" className={styles.fill} />}
        />
      }
    />
  )
}

export function App(): React.JSX.Element {
  const hydration = useGladeStore((state) => state.hydration)
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
      return <Layout />
  }
}
