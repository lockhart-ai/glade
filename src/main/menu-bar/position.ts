/** Where the menu bar popover goes: dropped under its icon, and kept on the screen. */

/** A rectangle on the screen, in points: Electron's `Rectangle`. */
export interface Bounds {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** The gap between the menu bar and the popover under it. */
export const POPOVER_GAP = 4

/** The least room the popover leaves between itself and the screen's edges. */
export const SCREEN_MARGIN = 8

/** The shortest the popover gets, however little it lists. */
export const MIN_POPOVER_HEIGHT = 80

/** What `popoverBounds` places the popover from. */
export interface PopoverPlacement {
  /** The icon's bounds in the menu bar. */
  readonly anchor: Bounds
  /** The popover's width, and the height its page asks for. */
  readonly width: number
  readonly height: number
  /** The work area of the screen the icon is on: the screen less the menu bar and the Dock. */
  readonly workArea: Bounds
}

/**
 * The popover's bounds: centred under its icon, `POPOVER_GAP` below the menu bar, moved in from a screen edge it would
 * cross, and no taller than the room below it (its page scrolls the rest). Whole points, as a window's bounds are.
 */
export function popoverBounds({ anchor, width, height, workArea }: PopoverPlacement): Bounds {
  const left = workArea.x + SCREEN_MARGIN
  const right = workArea.x + workArea.width - SCREEN_MARGIN - width
  const centred = anchor.x + anchor.width / 2 - width / 2
  const x = Math.round(Math.max(left, Math.min(right, centred)))
  const y = Math.round(Math.max(anchor.y + anchor.height, workArea.y) + POPOVER_GAP)
  const room = workArea.y + workArea.height - SCREEN_MARGIN - y
  const fitted = Math.round(Math.max(MIN_POPOVER_HEIGHT, Math.min(height, room)))
  return { x, y, width, height: fitted }
}
