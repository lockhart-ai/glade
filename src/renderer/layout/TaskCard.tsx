import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Card, ToastAnchor } from '../components'
import styles from './TaskCard.module.css'

/** The header card's height, which the chat under it pads its top by (see `TaskCard.module.css`). */
export const TASK_HEADER_HEIGHT_VAR = '--task-header-height'

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
   * A row above the chat for when there's no header to hold the button that shows the sidebar: it drags the window, and
   * holds what's given.
   */
  titleBar?: ReactNode
}

/**
 * Keeps `--task-header-height` on `stage` at the height of `header` as it changes (a task selected or none, a field
 * showing or not), so the chat under the header can pad its top by that much and its first message is never hidden.
 * Measured before the first paint, then on every resize.
 */
function useHeaderHeight(stage: RefObject<HTMLDivElement | null>, header: RefObject<HTMLDivElement | null>): void {
  useLayoutEffect(() => {
    const stageElement = stage.current
    const headerElement = header.current
    if (stageElement === null || headerElement === null) return
    const measure = (): void => {
      stageElement.style.setProperty(TASK_HEADER_HEIGHT_VAR, `${String(headerElement.offsetHeight)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(headerElement)
    return () => {
      observer.disconnect()
    }
  }, [stage, header])
}

/**
 * The task card: the header, chat and input bar in a column, with the right panel card beside them. The header card
 * floats over the top of the chat, which scrolls under it. Toasts stand above the input bar, centred on the chat
 * column, so it must be used under a `ToastProvider`.
 */
export function TaskCard({ header, chat, inputBar, rightPanel, titleBar }: TaskCardProps): React.JSX.Element {
  const stage = useRef<HTMLDivElement>(null)
  const headerLayer = useRef<HTMLDivElement>(null)
  useHeaderHeight(stage, headerLayer)

  return (
    <Card role="main" aria-label="Task" className={styles.task}>
      <div className={styles.column}>
        {titleBar !== undefined && (
          <div className={styles.titleBar} data-testid="task-title-bar">
            {titleBar}
          </div>
        )}
        <div ref={stage} className={styles.stage} data-testid="task-stage">
          <div ref={headerLayer} className={styles.header}>
            {header}
          </div>
          <section aria-label="Chat" className={styles.chat}>
            {chat}
          </section>
        </div>
        <div className={styles.inputBar} data-testid="input-bar">
          <ToastAnchor className={styles.toastAnchor} />
          {inputBar}
        </div>
      </div>
      {rightPanel}
    </Card>
  )
}
