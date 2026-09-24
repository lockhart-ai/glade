import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react'

/** How close to the bottom, in pixels, still counts as at the bottom, so a stray pixel of scroll doesn't unstick. */
export const STICK_THRESHOLD = 24

/** The parts of a scrolling element the stick-to-bottom logic reads. */
export interface ScrollMetrics {
  readonly scrollTop: number
  readonly scrollHeight: number
  readonly clientHeight: number
}

/** Whether a scroller is scrolled to (within `threshold` of) its bottom. */
export function isAtBottom(
  { scrollTop, scrollHeight, clientHeight }: ScrollMetrics,
  threshold: number = STICK_THRESHOLD,
): boolean {
  return scrollHeight - clientHeight - scrollTop <= threshold
}

/** The scroller's visible size, which only layout changes, never the user scrolling. */
function sizeOf({ clientWidth, clientHeight }: HTMLElement): string {
  return `${String(clientWidth)}×${String(clientHeight)}`
}

export interface StickToBottom {
  /** Attach to the scrolling element. */
  readonly ref: RefObject<HTMLDivElement | null>
  /** Attach as the scrolling element's `onScroll`. */
  readonly onScroll: () => void
}

/**
 * Keeps a scroller pinned to its bottom as its content grows, unless the user has scrolled up: whenever `content`
 * changes, it scrolls to the bottom if the scroller was at the bottom before. So does the scroller shrinking, e.g. as
 * the window gets smaller or the header above it grows, so the latest message stays in view above the input bar.
 * Changing `resetKey` (e.g. selecting another task) sticks it to the bottom again.
 */
export function useStickToBottom(content: unknown, resetKey: unknown): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)
  const lastResetKey = useRef(resetKey)
  // The scroller's size when the resize observer last saw it. A scroll event can arrive after a layout that the observer
  // hasn't reported yet, e.g. the event from our own scroll to the bottom, dispatched once the window has already
  // shrunk: it isn't the user scrolling up, so it mustn't unstick the scroller.
  const observedSize = useRef<string | null>(null)

  const onScroll = useCallback(() => {
    const scroller = ref.current
    if (scroller === null) return
    const resized = observedSize.current !== null && sizeOf(scroller) !== observedSize.current
    if (stuck.current && resized) scroller.scrollTop = scroller.scrollHeight
    else stuck.current = isAtBottom(scroller)
  }, [])

  useLayoutEffect(() => {
    if (lastResetKey.current !== resetKey) {
      lastResetKey.current = resetKey
      stuck.current = true
    }
    const scroller = ref.current
    if (scroller !== null && stuck.current) scroller.scrollTop = scroller.scrollHeight
  }, [content, resetKey])

  useEffect(() => {
    const scroller = ref.current
    if (scroller === null) return
    const observer = new ResizeObserver(() => {
      observedSize.current = sizeOf(scroller)
      if (stuck.current) scroller.scrollTop = scroller.scrollHeight
    })
    observer.observe(scroller)
    return () => {
      observer.disconnect()
    }
  }, [])

  return { ref, onScroll }
}
