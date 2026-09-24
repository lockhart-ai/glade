import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'

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

export interface StickToBottom {
  /** Attach to the scrolling element. */
  readonly ref: RefObject<HTMLDivElement | null>
  /** Attach as the scrolling element's `onScroll`. */
  readonly onScroll: () => void
}

/**
 * Keeps a scroller pinned to its bottom as its content grows, unless the user has scrolled up: whenever `content`
 * changes, it scrolls to the bottom if the scroller was at the bottom before. Changing `resetKey` (e.g. selecting
 * another task) sticks it to the bottom again.
 */
export function useStickToBottom(content: unknown, resetKey: unknown): StickToBottom {
  const ref = useRef<HTMLDivElement | null>(null)
  const stuck = useRef(true)
  const lastResetKey = useRef(resetKey)

  const onScroll = useCallback(() => {
    if (ref.current !== null) stuck.current = isAtBottom(ref.current)
  }, [])

  useLayoutEffect(() => {
    if (lastResetKey.current !== resetKey) {
      lastResetKey.current = resetKey
      stuck.current = true
    }
    const scroller = ref.current
    if (scroller !== null && stuck.current) scroller.scrollTop = scroller.scrollHeight
  }, [content, resetKey])

  return { ref, onScroll }
}
