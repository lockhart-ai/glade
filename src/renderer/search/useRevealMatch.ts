import { useEffect, type RefObject } from 'react'
import { useGladeStore } from '../store/react'

/** Whether `element` shows whole within the scroller's visible area. */
function inView(element: Element, scroller: Element): boolean {
  const box = element.getBoundingClientRect()
  const view = scroller.getBoundingClientRect()
  return box.top >= view.top && box.bottom <= view.bottom
}

/**
 * Each time a search result is opened (`matchRevealRequest`), smoothly scrolls the chat to its first marked match, if
 * that's off screen; a chat with no match, or one already showing it, stays where it is.
 */
export function useRevealMatch(scroller: RefObject<HTMLElement | null>): void {
  const request = useGladeStore((state) => state.matchRevealRequest)

  useEffect(() => {
    if (request === 0) return
    const element = scroller.current
    const match = element?.querySelector('mark') ?? null
    if (element === null || match === null) return
    if (!inView(match, element)) match.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [request, scroller])
}
