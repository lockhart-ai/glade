import type { ReactNode } from 'react'
import { Card, CardLevel } from '../components'
import styles from './TaskHeader.module.css'

export interface TaskHeaderProps {
  children?: ReactNode
}

/** The nested card at the top of the task card: title, state, objective and status. */
export function TaskHeader({ children }: TaskHeaderProps): React.JSX.Element {
  return (
    <Card level={CardLevel.Nested} role="region" aria-label="Task header" className={styles.header}>
      {children}
    </Card>
  )
}
