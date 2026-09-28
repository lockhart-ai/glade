/**
 * Closing the window, or quitting, with unsaved edits in the Files tab. The window tells main whenever it starts or
 * stops having any (`window.setUnsavedEdits`). While it has, main calls off closing the window (its `close` event) or
 * quitting (`before-quit`), and tells the window which it was (`close.blocked`); the window asks Save / Discard /
 * Cancel, then closes (`window.close`) or quits (`app.quit`) again, with nothing unsaved by then, unless you cancel.
 */
import { CloseKind, EventType, type CloseBlockedEvent } from '../shared/bridge'

/** What the window has told main about its unsaved edits, and what that means for closing it or quitting. */
export class CloseGuard {
  private unsaved = false

  constructor(
    /** Tells the window a close or quit was called off for its unsaved edits. */
    private readonly emit: (event: CloseBlockedEvent) => void,
  ) {}

  /** The window has unsaved edits, or none any more. */
  setUnsaved(unsaved: boolean): void {
    this.unsaved = unsaved
  }

  /**
   * Closing the window (`kind` Window) or quitting (Quit) is about to happen: answers whether to call it off, having
   * told the window to ask about its unsaved edits.
   */
  callsOff(kind: CloseKind): boolean {
    if (!this.unsaved) return false
    this.emit({ type: EventType.CloseBlocked, kind })
    return true
  }
}
