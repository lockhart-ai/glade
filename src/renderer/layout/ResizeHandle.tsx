import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampWidth, type WidthBounds } from '../right-panel/panelModel'
import styles from './ResizeHandle.module.css'

export interface ResizeHandleProps {
  /** The panel's width now, in CSS pixels. */
  width: number
  /** How narrow and wide the panel can be, measured when a drag or key press starts. */
  bounds: () => WidthBounds
  /** How far ← and → move the handle. */
  step: number
  /** Each new width while you drag, to show at once. */
  onResize: (width: number) => void
  /** The width a drag or key press ended on, to keep. */
  onResizeEnd: (width: number) => void
}

/** A drag in progress: where it started, and the width it has reached. */
interface Drag {
  readonly pointerId: number
  readonly startX: number
  readonly startWidth: number
  readonly bounds: WidthBounds
  width: number
}

/** Which way each arrow key moves the handle, as a change in width: ← widens the panel, → narrows it. */
const KEY_STEPS: Readonly<Partial<Record<string, number>>> = { ArrowLeft: 1, ArrowRight: -1 }

/**
 * The drag handle on a panel's left edge (docs/design/html/08-open-file.html): dragging it left widens the panel, and
 * right narrows it, within `bounds`. It reports each width as you drag and the final one when you let go. Focused, ←
 * and → move it a step at a time.
 */
export function ResizeHandle({ width, bounds, step, onResize, onResizeEnd }: ResizeHandleProps): React.JSX.Element {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    // Keeps the drag from selecting text; capturing the pointer keeps the drag going outside the handle.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const limits = bounds()
    const startWidth = clampWidth(width, limits)
    drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth, bounds: limits, width: startWidth }
    setDragging(true)
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    const next = clampWidth(current.startWidth + current.startX - event.clientX, current.bounds)
    if (next === current.width) return
    current.width = next
    onResize(next)
  }

  function end(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    onResizeEnd(current.width)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const direction = KEY_STEPS[event.key]
    if (direction === undefined) return
    event.preventDefault()
    const limits = bounds()
    const next = clampWidth(clampWidth(width, limits) + direction * step, limits)
    onResize(next)
    onResizeEnd(next)
  }

  return (
    <div
      role="separator"
      aria-label="Resize panel"
      aria-orientation="vertical"
      aria-valuenow={width}
      tabIndex={0}
      data-dragging={dragging}
      className={styles.handle}
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.grip} />
    </div>
  )
}
