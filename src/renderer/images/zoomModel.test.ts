import { describe, expect, it } from 'vitest'
import {
  MAX_SCALE,
  clampState,
  fitScale,
  fitState,
  isAtFit,
  panBy,
  toggleFit,
  zoomByFactor,
  zoomForPinch,
  zoomToScale,
  ZOOM_KEY_FACTOR,
  type ImageZoomState,
  type Size,
} from './zoomModel'

/** A 1200×900 screenshot in a 600×500 view (which keeps 96 px of room across, 160 down, for the viewer's chrome). */
const VIEW: Size = { width: 600, height: 500 }
const IMAGE: Size = { width: 1200, height: 900 }
const ROOM: Size = { width: 96, height: 160 }
/** The fit of IMAGE in VIEW keeping ROOM: the height is the tighter axis, 340/900. */
const FIT = 340 / 900
const FITTED: ImageZoomState = { scale: FIT, tx: (600 - 1200 * FIT) / 2, ty: (500 - 900 * FIT) / 2 }

/** A 240×180 image, smaller than its view: fit is its own size, centred. */
const SMALL: Size = { width: 240, height: 180 }
const SMALL_FIT: ImageZoomState = { scale: 1, tx: (600 - 240) / 2, ty: (500 - 180) / 2 }

describe('fitScale', () => {
  it('fits the tighter axis, keeping the room, and never scales past the image’s own size', () => {
    expect(fitScale(VIEW, IMAGE, ROOM)).toBeCloseTo(FIT)
    expect(fitScale(VIEW, SMALL)).toBe(1)
    expect(fitScale({ width: 100, height: 100 }, { width: 100, height: 100 })).toBe(1)
  })

  it('treats a room larger than the view as no room', () => {
    expect(fitScale({ width: 40, height: 40 }, { width: 100, height: 100 }, { width: 96, height: 160 })).toBeCloseTo(
      0.01,
    )
  })
})

describe('fitState', () => {
  it('centres the fitted image in the view', () => {
    expect(fitState(VIEW, IMAGE, ROOM)).toEqual(FITTED)
    expect(fitState(VIEW, SMALL)).toEqual(SMALL_FIT)
  })
})

describe('isAtFit', () => {
  it('says so at fit, and no once zoomed in', () => {
    expect(isAtFit(FITTED, VIEW, IMAGE, ROOM)).toBe(true)
    expect(isAtFit({ ...FITTED, scale: 1 }, VIEW, IMAGE, ROOM)).toBe(false)
    expect(isAtFit(SMALL_FIT, VIEW, SMALL)).toBe(true)
  })
})

describe('zoomToScale', () => {
  it('keeps the image point under the anchor where it was', () => {
    // Zooming to actual size around the view's centre: the image's own centre lands where it was.
    const centre = { width: 300, height: 250 }
    const actual = zoomToScale(FITTED, VIEW, IMAGE, 1, centre, ROOM)
    expect(actual.scale).toBe(1)
    expect(actual.tx + (IMAGE.width * actual.scale) / 2).toBeCloseTo(centre.width)
    expect(actual.ty + (IMAGE.height * actual.scale) / 2).toBeCloseTo(centre.height)
  })

  it('anchors at the view’s centre without one', () => {
    const zoomed = zoomToScale(FITTED, VIEW, IMAGE, 2, undefined, ROOM)
    expect(zoomed.tx + (IMAGE.width * zoomed.scale) / 2).toBeCloseTo(300)
    expect(zoomed.ty + (IMAGE.height * zoomed.scale) / 2).toBeCloseTo(250)
  })

  it('stops at the fit and at MAX_SCALE', () => {
    expect(zoomToScale(FITTED, VIEW, IMAGE, FIT / 2, undefined, ROOM).scale).toBeCloseTo(FIT)
    expect(zoomToScale(FITTED, VIEW, IMAGE, 100, undefined, ROOM).scale).toBe(MAX_SCALE)
  })

  it('drifts the anchor when the clamp moves the scale under it', () => {
    const zoomed = zoomToScale(FITTED, VIEW, IMAGE, 100, { width: 590, height: 490 }, ROOM)
    expect(zoomed.scale).toBe(MAX_SCALE)
    expect(zoomed.tx + (IMAGE.width * zoomed.scale) / 2).not.toBeCloseTo(590)
  })
})

describe('zoomByFactor', () => {
  it('raises the scale by the factor, up to the cap', () => {
    expect(zoomByFactor(FITTED, VIEW, IMAGE, 2, undefined, ROOM).scale).toBeCloseTo(FIT * 2)
    expect(zoomByFactor(FITTED, VIEW, IMAGE, ZOOM_KEY_FACTOR, undefined, ROOM).scale).toBeCloseTo(FIT * ZOOM_KEY_FACTOR)
    expect(zoomByFactor({ ...FITTED, scale: MAX_SCALE }, VIEW, IMAGE, ZOOM_KEY_FACTOR, undefined, ROOM).scale).toBe(
      MAX_SCALE,
    )
  })

  it('lowers it by the inverse, stopping at the fit', () => {
    const barely = { ...FITTED, scale: FIT * 1.1 }
    expect(zoomByFactor(barely, VIEW, IMAGE, 1 / ZOOM_KEY_FACTOR, undefined, ROOM).scale).toBeCloseTo(FIT)
  })
})

describe('zoomForPinch', () => {
  it('zooms in as the pinch opens (deltaY up) around the pointer, and out as it closes', () => {
    const pointer = { width: 300, height: 250 }
    const inward = zoomForPinch(FITTED, VIEW, IMAGE, -80, pointer, ROOM)
    expect(inward.scale).toBeCloseTo(FIT * Math.exp(0.8))
    // The image point under the pointer stays under it: the same image point is that far from the new top-left.
    expect(pointer.width - inward.tx).toBeCloseTo((pointer.width - FITTED.tx) * (inward.scale / FITTED.scale))
    expect(pointer.height - inward.ty).toBeCloseTo((pointer.height - FITTED.ty) * (inward.scale / FITTED.scale))
    const outward = zoomForPinch({ ...FITTED, scale: 1 }, VIEW, IMAGE, 40, pointer, ROOM)
    expect(outward.scale).toBeCloseTo(Math.exp(-0.4))
    // But zooming out stops at the fit, never smaller.
    expect(zoomForPinch({ ...FITTED, scale: 1 }, VIEW, IMAGE, 120, pointer, ROOM).scale).toBeCloseTo(FIT)
  })
})

describe('panBy', () => {
  it('moves the image by the delta', () => {
    const zoomed: ImageZoomState = { scale: 1, tx: -300, ty: -200 }
    expect(panBy(zoomed, VIEW, IMAGE, 40, -10)).toEqual({ scale: 1, tx: -260, ty: -210 })
  })

  it('stops with an edge at the view’s edge, never showing a gap', () => {
    const zoomed: ImageZoomState = { scale: 1, tx: -300, ty: -200 }
    expect(panBy(zoomed, VIEW, IMAGE, 400, 0).tx).toBe(0) // hard against the left edge
    expect(panBy(zoomed, VIEW, IMAGE, -400, 0).tx).toBe(600 - 1200) // and against the right
    expect(panBy(zoomed, VIEW, IMAGE, 0, -400).ty).toBe(500 - 900)
    expect(panBy(zoomed, VIEW, IMAGE, 0, 400).ty).toBe(0)
  })

  it('recentres a zoomed-out image that fits the view, and a drag does nothing to one that still fits', () => {
    expect(panBy(FITTED, VIEW, IMAGE, 50, 50)).toEqual(FITTED)
    expect(panBy(SMALL_FIT, VIEW, SMALL, 50, -50)).toEqual(SMALL_FIT)
  })

  it('pulls a drifted top-left back inside for a zero delta', () => {
    const drifted: ImageZoomState = { scale: 1, tx: 10, ty: -1300 }
    expect(panBy(drifted, VIEW, IMAGE, 0, 0)).toEqual({ scale: 1, tx: 0, ty: 500 - 900 })
  })
})

describe('clampState', () => {
  it('pulls a scale back between fit and MAX_SCALE and the top-left back over the view', () => {
    expect(clampState({ scale: FIT / 2, tx: 0, ty: 0 }, VIEW, IMAGE, ROOM)).toEqual(FITTED)
    expect(clampState({ scale: 50, tx: 0, ty: 0 }, VIEW, IMAGE, ROOM).scale).toBe(MAX_SCALE)
    expect(clampState({ scale: 1, tx: 10, ty: -1300 }, VIEW, IMAGE)).toEqual({ scale: 1, tx: 0, ty: 500 - 900 })
    // A view that grew re-centres a fitted image in it.
    expect(clampState(FITTED, { width: 800, height: 500 }, IMAGE, ROOM).tx).toBeCloseTo((800 - 1200 * FIT) / 2)
  })
})

describe('toggleFit', () => {
  it('goes from fit to actual size at the clicked spot', () => {
    const spot = { width: 200, height: 300 }
    const actual = toggleFit(FITTED, VIEW, IMAGE, spot, ROOM)
    expect(actual.scale).toBe(1)
    // The image point the spot showed at fit still shows there at actual size.
    expect(spot.width - actual.tx).toBeCloseTo((spot.width - FITTED.tx) / FITTED.scale)
    expect(spot.height - actual.ty).toBeCloseTo((spot.height - FITTED.ty) / FITTED.scale)
  })

  it('goes back to fit, centred, from anything else', () => {
    expect(toggleFit({ scale: 1, tx: -100, ty: -50 }, VIEW, IMAGE, { width: 10, height: 10 }, ROOM)).toEqual(FITTED)
    expect(toggleFit({ ...FITTED, scale: 2 }, VIEW, IMAGE, undefined, ROOM)).toEqual(FITTED)
  })

  it('leaves an image that fits at its own size as it is: fit and actual size are the same', () => {
    expect(toggleFit(SMALL_FIT, VIEW, SMALL, { width: 100, height: 100 })).toEqual(SMALL_FIT)
  })
})
