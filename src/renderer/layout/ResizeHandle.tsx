import { useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampSize, type SizeBounds } from '../panels/panelSize'
import styles from './ResizeHandle.module.css'

/** Which edge of its panel a handle sits on: the one facing the chat. */
export enum HandleEdge {
  /** The right panel's left edge: dragging left widens the panel. */
  Left = 'left',
  /** The sidebar's right edge: dragging right widens it. */
  Right = 'right',
  /** The bottom bar's top edge: dragging up makes it taller. */
  Top = 'top',
}

export interface ResizeHandleProps {
  /** The edge of the panel it sits on, which sets which way it drags. */
  edge: HandleEdge
  /** Its accessible name, e.g. `Resize task list`. */
  label: string
  /** The panel's size now (its width, or its height on the top edge), in CSS pixels. */
  size: number
  /** How small and big the panel can be, measured when a drag or key press starts. */
  bounds: () => SizeBounds
  /** How far each arrow key press moves the handle. */
  step: number
  /** Each new size while you drag, to show at once. */
  onResize: (size: number) => void
  /** The size a drag or key press ended on, to keep. */
  onResizeEnd: (size: number) => void
}

/** A drag in progress: where it started, and the size it has reached. */
interface Drag {
  readonly pointerId: number
  readonly start: number
  readonly startSize: number
  readonly bounds: SizeBounds
  size: number
}

/** How a handle on an edge moves: its separator's orientation, and which way along it makes the panel bigger. */
interface EdgeMotion {
  readonly orientation: 'vertical' | 'horizontal'
  /** The pointer's position along the axis the handle moves on. */
  readonly position: (event: PointerEvent<HTMLDivElement>) => number
  /** 1 when moving the pointer towards larger coordinates makes the panel bigger, -1 when it makes it smaller. */
  readonly growth: 1 | -1
  /** The arrow key that makes the panel bigger, and the one that makes it smaller. */
  readonly grow: string
  readonly shrink: string
}

function edgeMotion(edge: HandleEdge): EdgeMotion {
  switch (edge) {
    case HandleEdge.Left:
      return {
        orientation: 'vertical',
        position: (event) => event.clientX,
        growth: -1,
        grow: 'ArrowLeft',
        shrink: 'ArrowRight',
      }
    case HandleEdge.Right:
      return {
        orientation: 'vertical',
        position: (event) => event.clientX,
        growth: 1,
        grow: 'ArrowRight',
        shrink: 'ArrowLeft',
      }
    case HandleEdge.Top:
      return {
        orientation: 'horizontal',
        position: (event) => event.clientY,
        growth: -1,
        grow: 'ArrowUp',
        shrink: 'ArrowDown',
      }
  }
}

/**
 * The drag handle on the inner edge of a panel (docs/design/html/08-open-file.html), in the gap between it and the
 * chat: dragging it away from the panel makes the panel bigger, and towards it smaller, within `bounds`. It reports each
 * size as you drag and the final one when you let go. Focused, the arrow keys along its axis move it a step at a time.
 */
export function ResizeHandle({
  edge,
  label,
  size,
  bounds,
  step,
  onResize,
  onResizeEnd,
}: ResizeHandleProps): React.JSX.Element {
  const drag = useRef<Drag | null>(null)
  const [dragging, setDragging] = useState(false)
  const motion = edgeMotion(edge)

  function start(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return
    // Keeps the drag from selecting text; capturing the pointer keeps the drag going outside the handle.
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const limits = bounds()
    const startSize = clampSize(size, limits)
    drag.current = {
      pointerId: event.pointerId,
      start: motion.position(event),
      startSize,
      bounds: limits,
      size: startSize,
    }
    setDragging(true)
  }

  function move(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    const moved = motion.position(event) - current.start
    const next = clampSize(current.startSize + motion.growth * moved, current.bounds)
    if (next === current.size) return
    current.size = next
    onResize(next)
  }

  function end(event: PointerEvent<HTMLDivElement>): void {
    const current = drag.current
    if (current?.pointerId !== event.pointerId) return
    drag.current = null
    setDragging(false)
    onResizeEnd(current.size)
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const direction = event.key === motion.grow ? 1 : event.key === motion.shrink ? -1 : 0
    if (direction === 0) return
    event.preventDefault()
    const limits = bounds()
    const next = clampSize(clampSize(size, limits) + direction * step, limits)
    onResize(next)
    onResizeEnd(next)
  }

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={motion.orientation}
      aria-valuenow={size}
      tabIndex={0}
      data-dragging={dragging}
      data-edge={edge}
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
