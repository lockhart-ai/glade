import type { ReactNode } from 'react'
import { Card } from '../components'
import styles from './Sidebar.module.css'

export interface SidebarProps {
  children?: ReactNode
}

/**
 * The sidebar card. It starts with the strip that holds the macOS traffic lights and drags the window, so nothing in it
 * sits under them.
 */
export function Sidebar({ children }: SidebarProps): React.JSX.Element {
  return (
    <Card role="navigation" aria-label="Tasks" className={styles.sidebar}>
      <div className={styles.lightsStrip} data-testid="lights-strip" />
      <div className={styles.content}>{children}</div>
    </Card>
  )
}
