import type { ReactNode } from 'react'
import { Card } from '../components'
import styles from './Sidebar.module.css'

export interface SidebarProps {
  children?: ReactNode
  /** What sits at its foot, under the content, which scrolls above it: the usage meter. None unless given. */
  footer?: ReactNode
}

/** The sidebar card. It starts below the window's title bar row, so nothing in it sits under the traffic lights. */
export function Sidebar({ children, footer }: SidebarProps): React.JSX.Element {
  return (
    <Card role="navigation" aria-label="Tasks" className={styles.sidebar}>
      <div className={styles.content}>{children}</div>
      {footer}
    </Card>
  )
}
