import { useLayoutEffect, type RefObject } from 'react'
import type { PluginViewBounds } from '../../shared/bridge'

/** Where a native view goes now: the slot's box in the page's CSS pixels, or null to hide it. */
export type PlaceView = (bounds: PluginViewBounds | null) => void

/** The slot's box, in the page's CSS pixels from its top left. */
function boundsOf(element: Element): PluginViewBounds {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { x: left, y: top, width, height }
}

function same(a: PluginViewBounds | null, b: PluginViewBounds): boolean {
  return a !== null && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Keeps a native view (a plugin's, which main draws over the page) over `slot`: reports the slot's box when it's
 * showing, again whenever it's resized or the window is, and null to hide the view once it stops showing (`showing`
 * false: the bottom bar collapsed or sliding) or the slot goes.
 */
export function useViewSlot(slot: RefObject<HTMLElement | null>, showing: boolean, place: PlaceView): void {
  useLayoutEffect(() => {
    const element = slot.current
    // Hidden already: by this effect's cleanup when it stopped showing, and never shown before it first showed.
    if (!showing || element === null) return
    let last: PluginViewBounds | null = null
    const report = (): void => {
      const bounds = boundsOf(element)
      if (same(last, bounds)) return
      last = bounds
      place(bounds)
    }
    report()
    // Its size changes with the bar's height and the window's width; its place with the window's height as well.
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      place(null)
    }
  }, [slot, showing, place])
}
