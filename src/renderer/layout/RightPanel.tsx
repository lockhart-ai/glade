import { useCallback, useEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import { CLOSE_REQUEST_EVENT } from '../commands/closeRequest'
import { Card, CardLevel } from '../components'
import {
  MIN_CHAT_WIDTH,
  MIN_PANEL_WIDTH,
  PANEL_WIDTH_STEP,
  widthBounds,
  type WidthBounds,
} from '../right-panel/panelModel'
import { ResizeHandle } from './ResizeHandle'
import styles from './RightPanel.module.css'

export interface RightPanelProps {
  /** The tab row along the top. */
  tabs?: ReactNode
  /** The active tab's content. */
  children?: ReactNode
  /** The width you chose, in CSS pixels. The layout caps it so the chat beside it keeps its minimum width. */
  width: number
  /** The width you dragged the handle to (or moved it to with the arrow keys), to keep. */
  onWidthChange: (width: number) => void
  /**
   * Close (⌘W) while the focus is in the panel: a close request (`src/renderer/commands/closeRequest.ts`), to cancel
   * when it closes something, such as the file showing.
   */
  onCloseRequest?: (event: Event) => void
}

/** The custom property the panel's width is set through; the stylesheet caps it to the room there is. */
const WIDTH_PROPERTY = '--right-panel-width'

function widthStyle(width: number): CSSProperties {
  return {
    [WIDTH_PROPERTY]: `${String(width)}px`,
    '--right-panel-min-width': `${String(MIN_PANEL_WIDTH)}px`,
    '--chat-min-width': `${String(MIN_CHAT_WIDTH)}px`,
  } as CSSProperties
}

/** The room the panel and the chat share in `card`: its content width, less the gap between them. */
function availableWidth(card: HTMLElement): number {
  const style = getComputedStyle(card)
  const px = (value: string): number => Number.parseFloat(value) || 0
  return card.clientWidth - px(style.paddingLeft) - px(style.paddingRight) - px(style.columnGap)
}

/**
 * The nested card on the right of the task card: a tab row above the active tab's content, with a drag handle on its
 * left edge that resizes it. While you drag, the width changes in place without re-rendering the panel's content; it's
 * handed to `onWidthChange` when you let go.
 */
export function RightPanel({
  tabs,
  children,
  width,
  onWidthChange,
  onCloseRequest,
}: RightPanelProps): React.JSX.Element {
  const slot = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = slot.current
    if (element === null || onCloseRequest === undefined) return
    element.addEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
    return () => {
      element.removeEventListener(CLOSE_REQUEST_EVENT, onCloseRequest)
    }
  }, [onCloseRequest])

  const bounds = useCallback((): WidthBounds => {
    const card = slot.current?.parentElement
    return widthBounds(card == null ? 0 : availableWidth(card))
  }, [])

  const showWidth = useCallback((next: number) => {
    slot.current?.style.setProperty(WIDTH_PROPERTY, `${String(next)}px`)
  }, [])

  return (
    <div ref={slot} className={styles.slot} style={widthStyle(width)} data-testid="right-panel">
      <ResizeHandle
        width={width}
        bounds={bounds}
        step={PANEL_WIDTH_STEP}
        onResize={showWidth}
        onResizeEnd={onWidthChange}
      />
      <Card level={CardLevel.Nested} role="complementary" aria-label="Task panel" className={styles.panel}>
        <div className={styles.tabs} data-testid="right-panel-tabs">
          {tabs}
        </div>
        <div className={styles.content}>{children}</div>
      </Card>
    </div>
  )
}
