/**
 * The corner radius a native view (a plugin's, or the Files viewer's HTML preview) is drawn with, for a capture
 * (`./capture-views`) to read back when it pastes the view into the page's: Electron's `WebContentsView` has a
 * setter (`setBorderRadius`) but no getter, so whoever makes the view records it here. A view never tagged (every
 * plugin's, today) keeps the fallback radius the caller gives `viewRadius`, so this changes nothing for them.
 */
import type { WebContentsView } from 'electron'

const radii = new WeakMap<WebContentsView, number>()

/** Records the radius `view` is drawn with. */
export function setViewRadius(view: WebContentsView, radius: number): void {
  radii.set(view, radius)
}

/** The radius `view` was tagged with, or `fallback` for one that never was. */
export function viewRadius(view: WebContentsView, fallback: number): number {
  return radii.get(view) ?? fallback
}
