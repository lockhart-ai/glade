import type { ReactNode } from 'react'
import { Card } from '../components'
import styles from './Sidebar.module.css'

export interface SidebarProps {
  children?: ReactNode
}

/** The sidebar card. It starts below the window's title bar row, so nothing in it sits under the traffic lights. */
export function Sidebar({ children }: SidebarProps): React.JSX.Element {
  return (
    <Card role="navigation" aria-label="Tasks" className={styles.sidebar}>
      <div className={styles.content}>{children}</div>
    </Card>
  )
}
