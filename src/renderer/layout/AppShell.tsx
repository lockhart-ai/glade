import type { ReactNode } from 'react'
import styles from './AppShell.module.css'

export interface AppShellProps {
  /** The sidebar card (see `Sidebar`). */
  sidebar: ReactNode
  /** The task card (see `TaskCard`). */
  task: ReactNode
  /** The full-width bottom bar (see `BottomBar`). */
  bottomBar: ReactNode
}

/**
 * The window frame: a flat background with the sidebar and task card side by side above the bottom bar. The title
 * bar is hidden, so the outer padding along the top edge drags the window.
 */
export function AppShell({ sidebar, task, bottomBar }: AppShellProps): React.JSX.Element {
  return (
    <div className={styles.shell}>
      <div className={styles.dragStrip} data-testid="window-drag-strip" />
      <div className={styles.top}>
        {sidebar}
        {task}
      </div>
      {bottomBar}
    </div>
  )
}
