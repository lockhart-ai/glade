import type { ReactNode } from 'react'
import { Card } from '../components'
import styles from './Sidebar.module.css'

export interface SidebarProps {
  children?: ReactNode
}

/**
 * The sidebar card. The macOS traffic lights float over its top-left corner, so its top strip drags the window and
 * the content starts below them.
 */
export function Sidebar({ children }: SidebarProps): React.JSX.Element {
  return (
    <Card role="navigation" aria-label="Tasks" className={styles.sidebar}>
      <div className={styles.titleBar} data-testid="sidebar-title-bar" />
      <div className={styles.content}>{children}</div>
    </Card>
  )
}
