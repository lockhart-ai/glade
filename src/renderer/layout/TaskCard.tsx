import type { ReactNode } from 'react'
import { Card } from '../components'
import styles from './TaskCard.module.css'

export interface TaskCardProps {
  /** The header card at the top (see `TaskHeader`). */
  header: ReactNode
  /** The chat, between the header and the input bar. */
  chat: ReactNode
  /** The input bar at the bottom. */
  inputBar: ReactNode
  /** The right panel card (see `RightPanel`). */
  rightPanel: ReactNode
}

/** The task card: the header, chat and input bar in a column, with the right panel card beside them. */
export function TaskCard({ header, chat, inputBar, rightPanel }: TaskCardProps): React.JSX.Element {
  return (
    <Card role="main" aria-label="Task" className={styles.task}>
      <div className={styles.column}>
        {header}
        <section aria-label="Chat" className={styles.chat}>
          {chat}
        </section>
        <div className={styles.inputBar} data-testid="input-bar">
          {inputBar}
        </div>
      </div>
      {rightPanel}
    </Card>
  )
}
