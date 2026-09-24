import type { ReactNode } from 'react'
import { Card } from '../components'
import { classNames } from '../components/classNames'
import styles from './BottomBar.module.css'

export interface BottomBarProps {
  /** The terminal card's tab row. */
  terminalTabs?: ReactNode
  /** The terminal itself. */
  terminal?: ReactNode
  /** The button at the end of the tab row that collapses the bar and shows it again. */
  toggle?: ReactNode
  /** Whether the bar is collapsed to its tab row. */
  collapsed?: boolean
}

/**
 * The full-width bar along the bottom of the window. For now it holds only the terminal card. Collapsed, the card
 * keeps only its tab row, whose toggle shows it again.
 */
export function BottomBar({ terminalTabs, terminal, toggle, collapsed = false }: BottomBarProps): React.JSX.Element {
  return (
    <div className={styles.bar}>
      <Card role="region" aria-label="Terminal" className={styles.terminal}>
        <div className={classNames(styles.tabs, collapsed && styles.alone)} data-testid="terminal-tabs">
          {terminalTabs}
          {toggle}
        </div>
        {!collapsed && <div className={styles.content}>{terminal}</div>}
      </Card>
    </div>
  )
}
