import { describe, expect, it } from 'vitest'
import { MIN_POPOVER_HEIGHT, POPOVER_GAP, popoverBounds, SCREEN_MARGIN, type Bounds } from './position'

/** A 1512×982 screen with a 25pt menu bar, and the Dock at the bottom. */
const WORK_AREA: Bounds = { x: 0, y: 25, width: 1512, height: 900 }
const WIDTH = 360

/** The icon in the menu bar, its left edge at `x`. */
function icon(x: number): Bounds {
  return { x, y: 0, width: 32, height: 24 }
}

describe('popoverBounds', () => {
  it('drops under the icon, centred on it, just below the menu bar', () => {
    expect(popoverBounds({ anchor: icon(1000), width: WIDTH, height: 400, workArea: WORK_AREA })).toEqual({
      x: 1000 + 16 - 180,
      y: 25 + POPOVER_GAP,
      width: WIDTH,
      height: 400,
    })
  })

  it('moves in from the right edge of the screen, for an icon near it', () => {
    const bounds = popoverBounds({ anchor: icon(1480), width: WIDTH, height: 300, workArea: WORK_AREA })
    expect(bounds.x).toBe(1512 - SCREEN_MARGIN - WIDTH)
  })

  it('moves in from the left edge of the screen, for an icon near it', () => {
    const bounds = popoverBounds({ anchor: icon(20), width: WIDTH, height: 300, workArea: WORK_AREA })
    expect(bounds.x).toBe(SCREEN_MARGIN)
  })

  it('keeps to the screen the icon is on, when it is not the first', () => {
    const second: Bounds = { x: 1512, y: -200, width: 1920, height: 1150 }
    const anchor: Bounds = { x: 3300, y: -225, width: 32, height: 24 }
    expect(popoverBounds({ anchor, width: WIDTH, height: 300, workArea: second })).toEqual({
      x: 1512 + 1920 - SCREEN_MARGIN - WIDTH,
      y: -200 + POPOVER_GAP,
      width: WIDTH,
      height: 300,
    })
  })

  it('is no taller than the room under the menu bar, the rest scrolling', () => {
    const bounds = popoverBounds({ anchor: icon(1000), width: WIDTH, height: 5_000, workArea: WORK_AREA })
    expect(bounds.y + bounds.height).toBe(25 + 900 - SCREEN_MARGIN)
  })

  it('is never shorter than its least height, and always whole points', () => {
    expect(popoverBounds({ anchor: icon(1000), width: WIDTH, height: 0, workArea: WORK_AREA }).height).toBe(
      MIN_POPOVER_HEIGHT,
    )
    const bounds = popoverBounds({
      anchor: { x: 1000.4, y: 0, width: 31.3, height: 24.6 },
      width: WIDTH,
      height: 211.7,
      workArea: WORK_AREA,
    })
    for (const value of Object.values(bounds)) expect(Number.isInteger(value)).toBe(true)
  })

  it('drops under an icon whose bounds reach below the work area’s top', () => {
    const bounds = popoverBounds({
      anchor: { x: 1000, y: 0, width: 32, height: 30 },
      width: WIDTH,
      height: 200,
      workArea: WORK_AREA,
    })
    expect(bounds.y).toBe(30 + POPOVER_GAP)
  })
})
