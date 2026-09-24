// The panel toggles' icons, from docs/design/html/task-workspace.html: a rounded window outline split by a line at the
// panel's edge (left for the sidebar, right for the right panel, across for the bottom bar). The designs stroke them
// at 1.8 on a 24-unit grid; Font Awesome fills its paths, so each is drawn here as the filled outline of those strokes.
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core'

const SIZE = 24
/** Half the designs' 1.8 stroke. */
const HALF_STROKE = 0.9

/** The window outline's centre line and corner radius, from the designs' `<rect x=3.5 y=4.5 w=17 h=15 rx=2.5>`. */
const FRAME = { left: 3.5, top: 4.5, right: 20.5, bottom: 19.5, radius: 2.5 } as const

interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** A coordinate as a path writes it, without floating-point noise (2.6, not 2.5999999999999996). */
function n(value: number): string {
  return String(Math.round(value * 100) / 100)
}

/**
 * A rounded rectangle, drawn clockwise, or anticlockwise to cut a hole in one drawn clockwise. With no radius, a plain
 * rectangle.
 */
function roundedRect({ left, top, right, bottom }: Box, r: number, clockwise: boolean): string {
  const arc = (x: number, y: number): string =>
    r === 0 ? '' : `A${n(r)} ${n(r)} 0 0 ${clockwise ? '1' : '0'} ${n(x)} ${n(y)}`
  const start = `M${n(left + r)} ${n(top)}`
  if (clockwise) {
    return (
      `${start}H${n(right - r)}${arc(right, top + r)}V${n(bottom - r)}${arc(right - r, bottom)}` +
      `H${n(left + r)}${arc(left, bottom - r)}V${n(top + r)}${arc(left + r, top)}Z`
    )
  }
  return (
    `${start}${arc(left, top + r)}V${n(bottom - r)}${arc(left + r, bottom)}` +
    `H${n(right - r)}${arc(right, bottom - r)}V${n(top + r)}${arc(right - r, top)}Z`
  )
}

/** Where the dividing line runs: down the window at an x, or across it at a y. */
type Divider = { readonly x: number } | { readonly y: number }

/** The outlined window split by a line: the outline's outer edge, its inner edge (a hole), and the line. */
export function panelIconPath(divider: Divider): string {
  const { left, top, right, bottom, radius } = FRAME
  const outer = {
    left: left - HALF_STROKE,
    top: top - HALF_STROKE,
    right: right + HALF_STROKE,
    bottom: bottom + HALF_STROKE,
  }
  const inner = {
    left: left + HALF_STROKE,
    top: top + HALF_STROKE,
    right: right - HALF_STROKE,
    bottom: bottom - HALF_STROKE,
  }
  const line =
    'x' in divider
      ? { ...inner, left: divider.x - HALF_STROKE, right: divider.x + HALF_STROKE }
      : { ...inner, top: divider.y - HALF_STROKE, bottom: divider.y + HALF_STROKE }
  return (
    roundedRect(outer, radius + HALF_STROKE, true) +
    roundedRect(inner, radius - HALF_STROKE, false) +
    roundedRect(line, 0, true)
  )
}

function panelIcon(iconName: IconDefinition['iconName'], divider: Divider): IconDefinition {
  // `fak` is Font Awesome's prefix for custom icons.
  return { prefix: 'fak', iconName, icon: [SIZE, SIZE, [], '', panelIconPath(divider)] }
}

/** The sidebar's toggle: the line near the left edge. */
export const sidebarIcon = panelIcon('sidebar', { x: 9 })

/** The right panel's toggle: the line near the right edge. */
export const rightPanelIcon = panelIcon('sidebar-flip', { x: 15 })

/** The bottom bar's toggle: the line across, near the bottom. */
export const bottomBarIcon = panelIcon('table-layout', { y: 14 })
