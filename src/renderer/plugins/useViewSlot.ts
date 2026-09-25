import { useLayoutEffect, type RefObject } from 'react'
import type { PluginViewBounds } from '../../shared/bridge'
import { NATIVE_VIEW_COVERED_ATTRIBUTE } from '../../shared/ready'
import { isCovered, watchOverlays } from '../components/overlays'

/** Where a native view goes now: the slot's box in the page's CSS pixels, or null to hide it. */
export type PlaceView = (bounds: PluginViewBounds | null) => void

/** The slot's box, in the page's CSS pixels from its top left. */
function boundsOf(element: Element): PluginViewBounds {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { x: left, y: top, width, height }
}

function same(a: PluginViewBounds | null | undefined, b: PluginViewBounds | null): boolean {
  if (a === undefined || a === null || b === null) return a === b
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/**
 * Keeps a native view (a plugin's, which main draws over the page) over `slot`: reports the slot's box when it's
 * showing, again whenever it's resized or the window is, and null to hide the view once it stops showing (`showing`
 * false: the bottom bar collapsed or sliding) or the slot goes.
 *
 * The view is drawn above the page, so it would cover the page's own overlays (menus, popovers, dialogs, toasts,
 * `../components/overlays`): while any of them overlaps the slot, the view is hidden too, and it's back when they've
 * gone.
 */
export function useViewSlot(slot: RefObject<HTMLElement | null>, showing: boolean, place: PlaceView): void {
  useLayoutEffect(() => {
    const element = slot.current
    // Hidden already: by this effect's cleanup when it stopped showing, and never shown before it first showed.
    if (!showing || element === null) return
    // What was last reported: nothing yet, a box, or hidden (null).
    let last: PluginViewBounds | null | undefined
    const report = (): void => {
      const bounds = boundsOf(element)
      const covered = isCovered(bounds)
      element.toggleAttribute(NATIVE_VIEW_COVERED_ATTRIBUTE, covered)
      const next = covered ? null : bounds
      if (same(last, next)) return
      last = next
      place(next)
    }
    report()
    // Its size changes with the bar's height and the window's width; its place with the window's height as well.
    const observer = new ResizeObserver(report)
    observer.observe(element)
    window.addEventListener('resize', report)
    const unwatch = watchOverlays(report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      unwatch()
      element.removeAttribute(NATIVE_VIEW_COVERED_ATTRIBUTE)
      place(null)
    }
  }, [slot, showing, place])
}
