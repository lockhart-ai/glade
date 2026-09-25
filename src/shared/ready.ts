/**
 * The attribute the renderer sets on `<html>` once the page has rendered, its fonts have loaded and its store has
 * hydrated. `npm run screenshot` waits for it before capturing; nothing else reads it.
 */
export const READY_ATTRIBUTE = 'data-glade-ready'

/**
 * The attribute on a slot in the page that a native view (a plugin's) is drawn over. `npm run screenshot` waits for each
 * showing slot to have its view over it, and pastes the view into the capture, which leaves it out.
 */
export const NATIVE_VIEW_SLOT_ATTRIBUTE = 'data-native-view-slot'

/**
 * The attribute on such a slot while its view is hidden because one of the page's overlays (a menu, a dialog, a toast)
 * is over it. `npm run screenshot` leaves the slot out: it has no view over it to wait for.
 */
export const NATIVE_VIEW_COVERED_ATTRIBUTE = 'data-native-view-covered'
