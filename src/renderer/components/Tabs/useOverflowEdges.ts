import { useLayoutEffect, useState, type RefObject } from 'react'

/** Which ends of a row that scrolls sideways have more of it past them. */
export interface OverflowEdges {
  /** Something is scrolled out of view to the left. */
  readonly start: boolean
  /** Something is out of view to the right. */
  readonly end: boolean
}

const NONE: OverflowEdges = { start: false, end: false }

/** How far short of an end a scroll still counts as at it: scroll positions can be fractional. */
const SLACK_PX = 1

function measure(element: HTMLElement): OverflowEdges {
  const { scrollLeft, scrollWidth, clientWidth } = element
  return { start: scrollLeft > SLACK_PX, end: scrollWidth - clientWidth - scrollLeft > SLACK_PX }
}

/**
 * Tracks which ends of `ref`'s element have content scrolled past them, so the row can fade there to show there's
 * more. Measures as it scrolls, as it resizes, and whenever `content` (a key for what's in the row, e.g. its tabs'
 * labels and counts) changes.
 */
export function useOverflowEdges(ref: RefObject<HTMLElement | null>, content: string): OverflowEdges {
  const [edges, setEdges] = useState<OverflowEdges>(NONE)

  useLayoutEffect(() => {
    const element = ref.current
    if (element === null) return
    const update = (): void => {
      const next = measure(element)
      setEdges((current) => (current.start === next.start && current.end === next.end ? current : next))
    }
    update()
    element.addEventListener('scroll', update, { passive: true })
    const observer = new ResizeObserver(update)
    observer.observe(element)
    return () => {
      element.removeEventListener('scroll', update)
      observer.disconnect()
    }
  }, [ref, content])

  return edges
}
