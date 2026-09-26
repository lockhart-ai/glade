import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { Card, ToastAnchor } from '../components'
import styles from './TaskCard.module.css'

/** The header card's height, which the chat under it clips and pads its top by (see `TaskCard.module.css`). */
export const TASK_HEADER_HEIGHT_VAR = '--task-header-height'

/** The input bar's height, which the chat under it clips and pads its bottom by (see `TaskCard.module.css`). */
export const INPUT_BAR_HEIGHT_VAR = '--input-bar-height'

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

/** Where a floating layer's height is kept: the stage the chat is in, the layer, and the CSS variable. */
interface LayerHeight {
  readonly stage: RefObject<HTMLDivElement | null>
  readonly layer: RefObject<HTMLDivElement | null>
  readonly variable: string
}

/**
 * Keeps `variable` on `stage` at the height of `layer` as it changes (the header: a task selected or none, a field
 * showing or not; the input bar: its queue, images or field growing), so the chat under the layer can clip and pad
 * itself by it and its first and last messages are never hidden. Measured before the first paint, then on every resize.
 */
function useLayerHeight({ stage, layer, variable }: LayerHeight): void {
  useLayoutEffect(() => {
    const stageElement = stage.current
    const layerElement = layer.current
    if (stageElement === null || layerElement === null) return
    const measure = (): void => {
      stageElement.style.setProperty(variable, `${String(layerElement.offsetHeight)}px`)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(layerElement)
    return () => {
      observer.disconnect()
    }
  }, [stage, layer, variable])
}

/**
 * The task card: the header, chat and input bar in a column, with the right panel card beside them. The header card and
 * the input bar float over the top and bottom of the chat, which scrolls under them and is cut off halfway under each
 * (#268, #270). Toasts stand above the input bar, centred on the chat column, so it must be used under a
 * `ToastProvider`.
 */
export function TaskCard({ header, chat, inputBar, rightPanel, titleBar }: TaskCardProps): React.JSX.Element {
  const stage = useRef<HTMLDivElement>(null)
  const headerLayer = useRef<HTMLDivElement>(null)
  const inputLayer = useRef<HTMLDivElement>(null)
  useLayerHeight({ stage, layer: headerLayer, variable: TASK_HEADER_HEIGHT_VAR })
  useLayerHeight({ stage, layer: inputLayer, variable: INPUT_BAR_HEIGHT_VAR })

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
          <div ref={inputLayer} className={styles.inputBar} data-testid="input-bar">
            <ToastAnchor className={styles.toastAnchor} />
            {inputBar}
          </div>
        </div>
      </div>
      {rightPanel}
    </Card>
  )
}
