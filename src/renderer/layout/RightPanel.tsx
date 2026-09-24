import type { ReactNode } from 'react'
import { Card, CardLevel } from '../components'
import styles from './RightPanel.module.css'

export interface RightPanelProps {
  /** The tab row along the top. */
  tabs?: ReactNode
  /** The active tab's content. */
  children?: ReactNode
}

/** The nested card on the right of the task card: a tab row above the active tab's content. */
export function RightPanel({ tabs, children }: RightPanelProps): React.JSX.Element {
  return (
    <Card level={CardLevel.Nested} role="complementary" aria-label="Task panel" className={styles.panel}>
      <div className={styles.tabs} data-testid="right-panel-tabs">
        {tabs}
      </div>
      <div className={styles.content}>{children}</div>
    </Card>
  )
}
