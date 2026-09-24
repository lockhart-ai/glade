/**
 * Close (⌘W) closes what has the focus: the file showing in the Files tab while the focus is in the right panel (and,
 * with the terminal, its tab while it has the focus), or else the window. The menu bar answers ⌘W, so the window never
 * sees the key: Close sends it the command, which asks whatever has the focus to close something with a close request,
 * a DOM event that bubbles up from the focused element. A part of the window that can close something listens for it
 * on its own element and cancels the event (`preventDefault`) when it has; if nothing does, the window closes.
 */

/** The close request's DOM event type. */
export const CLOSE_REQUEST_EVENT = 'glade:close-request'

/**
 * Sends a close request from the focused element (or the page, when nothing has the focus). Returns whether something
 * closed: false leaves it to the window to close.
 */
export function requestClose(): boolean {
  const target = document.activeElement ?? document.body
  const event = new Event(CLOSE_REQUEST_EVENT, { bubbles: true, cancelable: true })
  return !target.dispatchEvent(event)
}
