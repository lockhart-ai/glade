import type { ReactNode } from 'react'
import { Card } from '../components'
import styles from './BottomBar.module.css'

export interface BottomBarProps {
  /** The terminal card's tab row. */
  terminalTabs?: ReactNode
  /** The terminal itself. */
  terminal?: ReactNode
}

/** The full-width bar along the bottom of the window. For now it holds only the terminal card. */
export function BottomBar({ terminalTabs, terminal }: BottomBarProps): React.JSX.Element {
  return (
    <div className={styles.bar}>
      <Card role="region" aria-label="Terminal" className={styles.terminal}>
        <div className={styles.tabs} data-testid="terminal-tabs">
          {terminalTabs}
        </div>
        <div className={styles.content}>{terminal}</div>
      </Card>
    </div>
  )
}
