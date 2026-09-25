// What's floating over the page now: the menus, popovers, dialogs, toasts and notices each register their box while
// they're open. A plugin's view is native and drawn above the page, so it would cover them; its slot
// (`../plugins/useViewSlot`) watches this and hides the view while one of them overlaps it.
import { useCallback, useRef } from 'react'

/** Called when an overlay opens or closes, moves, or finishes animating in. */
type OverlayListener = () => void

/** How far past an overlay's box its shadow reaches (`--shadow-menu`: 16px down, 40px blur), which counts as covered. */
export const OVERLAY_SHADOW_REACH = 48

const open = new Set<HTMLElement>()
const listeners = new Set<OverlayListener>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/**
 * Records `element` as floating over the page until the returned function is called. Its box is read afresh whenever
 * anyone asks, and listeners hear when it's positioned (its style or class changes) or its animation ends.
 */
export function registerOverlay(element: HTMLElement): () => void {
  open.add(element)
  // Floating UI positions it through its inline style after it mounts, and on scroll or resize.
  const observer = new MutationObserver(notify)
  observer.observe(element, { attributes: true, attributeFilter: ['style', 'class'] })
  // It animates in with `scale` or `translate`, which moves its box without a mutation.
  element.addEventListener('animationend', notify)
  element.addEventListener('transitionend', notify)
  notify()
  return () => {
    open.delete(element)
    observer.disconnect()
    element.removeEventListener('animationend', notify)
    element.removeEventListener('transitionend', notify)
    notify()
  }
}

/** Calls `listener` whenever an overlay opens, closes, moves or finishes animating, until the returned function. */
export function watchOverlays(listener: OverlayListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** A box in the page's CSS pixels. */
export interface OverlayBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** Whether any open overlay, or its shadow, overlaps `box`. An overlay with no box (not laid out) overlaps nothing. */
export function isCovered(box: OverlayBox): boolean {
  for (const element of open) {
    const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
    if (width === 0 || height === 0) continue
    if (
      left - OVERLAY_SHADOW_REACH < box.x + box.width &&
      right + OVERLAY_SHADOW_REACH > box.x &&
      top - OVERLAY_SHADOW_REACH < box.y + box.height &&
      bottom + OVERLAY_SHADOW_REACH > box.y
    ) {
      return true
    }
  }
  return false
}

/**
 * A callback ref that registers the element it's given as an overlay while it's mounted. Pass it as the overlay's
 * outermost element's `ref`, or call it from the ref callback that element already has.
 */
export function useOverlayRef(): (element: HTMLElement | null) => void {
  const release = useRef<(() => void) | null>(null)
  return useCallback((element: HTMLElement | null) => {
    release.current?.()
    release.current = element === null ? null : registerOverlay(element)
  }, [])
}
