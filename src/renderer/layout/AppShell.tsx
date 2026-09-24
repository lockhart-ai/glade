import type { ReactNode } from 'react'
import styles from './AppShell.module.css'

export interface AppShellProps {
  /** The sidebar card (see `Sidebar`). */
  sidebar: ReactNode
  /** The task card (see `TaskCard`). */
  task: ReactNode
  /** The full-width bottom bar (see `BottomBar`). */
  bottomBar: ReactNode
  /**
   * The app-wide banner across the top of the window (see `PauseBanner`), when there is one. It renders nothing while
   * there's nothing to say, and then takes no room.
   */
  banner?: ReactNode
  /** What floats over the window, such as the relaunch notice; positioned by itself against the frame. */
  overlay?: ReactNode
}

/**
 * The window frame: a flat background with the sidebar and task card side by side above the bottom bar, under the
 * app-wide banner when there is one. The title bar is hidden, so the outer padding along the top edge drags the window.
 */
export function AppShell({ sidebar, task, bottomBar, banner, overlay }: AppShellProps): React.JSX.Element {
  return (
    <div className={styles.shell}>
      <div className={styles.dragStrip} data-testid="window-drag-strip" />
      {banner}
      <div className={styles.top}>
        {sidebar}
        {task}
      </div>
      <div className={styles.bottom}>{bottomBar}</div>
      {overlay}
    </div>
  )
}
