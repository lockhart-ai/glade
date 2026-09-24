import type { ReactNode } from 'react'
import { Card, ToastAnchor } from '../components'
import { classNames } from '../components/classNames'
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
  /**
   * Whether the sidebar is collapsed. The traffic lights then float over this card's top-left corner, so the column
   * starts a little lower to clear them.
   */
  clearTrafficLights?: boolean
  /**
   * A row above the chat for when there's no header to hold the button that shows the sidebar: it starts clear of the
   * traffic lights, drags the window, and holds what's given.
   */
  titleBar?: ReactNode
}

/**
 * The task card: the header, chat and input bar in a column, with the right panel card beside them. Toasts stand above
 * the input bar, centred on the chat column, so it must be used under a `ToastProvider`.
 */
export function TaskCard({
  header,
  chat,
  inputBar,
  rightPanel,
  clearTrafficLights = false,
  titleBar,
}: TaskCardProps): React.JSX.Element {
  return (
    <Card role="main" aria-label="Task" className={styles.task}>
      <div className={classNames(styles.column, clearTrafficLights && styles.belowTrafficLights)}>
        {titleBar !== undefined && (
          <div className={styles.titleBar} data-testid="task-title-bar">
            {titleBar}
          </div>
        )}
        {header}
        <section aria-label="Chat" className={styles.chat}>
          {chat}
        </section>
        <div className={styles.inputBar} data-testid="input-bar">
          <ToastAnchor className={styles.toastAnchor} />
          {inputBar}
        </div>
      </div>
      {rightPanel}
    </Card>
  )
}
