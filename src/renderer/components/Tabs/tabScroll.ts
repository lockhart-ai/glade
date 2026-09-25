import { useEffect, type RefObject } from 'react'

/** Which way a chevron scrolls the row. */
export enum ScrollDirection {
  Start = 'start',
  End = 'end',
}

/** How many pixels a wheel "line" is, for a mouse that reports its wheel in lines rather than pixels. */
const LINE_PX = 16

/** The widest the row can scroll: how much of it is past its right edge when scrolled to the start. */
function maxScroll(element: HTMLElement): number {
  return Math.max(element.scrollWidth - element.clientWidth, 0)
}

/** Whether the row is too narrow for its tabs, and so scrolls. */
export function overflows(element: HTMLElement): boolean {
  return maxScroll(element) > 0
}

/**
 * How far a wheel turn scrolls the row sideways, in pixels, or null to leave it to the browser: a sideways swipe on a
 * trackpad scrolls the row as it is, and a row that fits has nowhere to go. An up-and-down turn scrolls it (down goes
 * right), since a mouse wheel has no other way to.
 */
export function wheelScroll(element: HTMLElement, event: WheelEvent): number | null {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || !overflows(element)) return null
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_LINE:
      return event.deltaY * LINE_PX
    case WheelEvent.DOM_DELTA_PAGE:
      return event.deltaY * element.clientWidth
    default:
      return event.deltaY
  }
}

/** How far a chevron scrolls the row: about a tab's width (the row's tabs' average), towards `direction`. */
export function chevronScroll(element: HTMLElement, tabCount: number, direction: ScrollDirection): number {
  const step = element.scrollWidth / Math.max(tabCount, 1)
  return direction === ScrollDirection.End ? step : -step
}

/**
 * Where to scroll the row so `tab` shows whole, clear of the chevrons and fades at its ends (the row's
 * `scroll-padding`), or null if it already does or the row fits.
 */
export function revealScroll(element: HTMLElement, tab: HTMLElement): number | null {
  if (!overflows(element)) return null
  const style = getComputedStyle(element)
  const startRoom = parseFloat(style.scrollPaddingLeft) || 0
  const endRoom = parseFloat(style.scrollPaddingRight) || 0
  const start = tab.offsetLeft - startRoom
  const end = tab.offsetLeft + tab.offsetWidth + endRoom
  const { scrollLeft, clientWidth } = element
  let target = scrollLeft
  if (start < scrollLeft) target = start
  else if (end > scrollLeft + clientWidth) target = end - clientWidth
  target = Math.min(Math.max(target, 0), maxScroll(element))
  return target === scrollLeft ? null : target
}

/** Scrolls `ref`'s row sideways as its wheel turns up and down (see `wheelScroll`). */
export function useSidewaysWheel(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    const onWheel = (event: WheelEvent): void => {
      const left = wheelScroll(element, event)
      if (left === null) return
      // Not passive, so the page doesn't take the turn too. Instant: the wheel sends many small turns.
      event.preventDefault()
      element.scrollBy({ left, behavior: 'instant' })
    }
    element.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      element.removeEventListener('wheel', onWheel)
    }
  }, [ref])
}
