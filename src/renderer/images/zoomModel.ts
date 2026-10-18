/**
 * The zoom of an image view (#685): the pure maths both image views share. A view shows an image of a natural size in
 * a box of a view size; the state says how big the image is drawn (its scale, where 1 is its own size) and where its
 * top-left sits in the view. Fit draws it as large as fits without scaling it up; zoomed in, the box it may cover is
 * the whole view, so panning can take any part of the image to the middle.
 */

/** A width and a height, in CSS pixels. */
export interface Size {
  readonly width: number
  readonly height: number
}

/** Where an image is in its view: drawn at `scale` of its own size, its top-left at (`tx`, `ty`). */
export interface ImageZoomState {
  readonly scale: number
  readonly tx: number
  readonly ty: number
}

/** The most an image is ever zoomed in, over its own size (Preview's is far higher; 8× shows any detail a screenshot has). */
export const MAX_SCALE = 8

/** What one ⌘+ or ⌘− multiplies the scale by (its inverse for ⌘−). */
export const ZOOM_KEY_FACTOR = 1.25

/**
 * How a pinch's wheel delta (Chromium sends a trackpad pinch as `wheel` events with `ctrlKey`, `deltaY` in pixels, up
 * when pinching out) becomes a factor: the scale is raised by e^(-deltaY · rate), so 100 px of pinch roughly doubles it.
 */
export const PINCH_RATE = 0.01

/** How far a pointer may travel between down and up and still count as a click (a toggle) rather than a drag (a pan). */
export const DRAG_THRESHOLD = 4

/** Whether two numbers are the same to within the pixel a renderer rounds to. */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.01
}

/** The scale that fits an image in a view that keeps `room` free around it, never scaling it past its own size. */
export function fitScale(view: Size, image: Size, room: Size = { width: 0, height: 0 }): number {
  const width = Math.max(view.width - room.width, 1)
  const height = Math.max(view.height - room.height, 1)
  return Math.min(1, Math.min(width / image.width, height / image.height))
}

/** The fit state: the image as large as fits, centred in the view. */
export function fitState(view: Size, image: Size, room: Size = { width: 0, height: 0 }): ImageZoomState {
  const scale = fitScale(view, image, room)
  return { scale, tx: (view.width - image.width * scale) / 2, ty: (view.height - image.height * scale) / 2 }
}

/** Whether `state` is the view's fit: the image as large as fits, centred. */
export function isAtFit(state: ImageZoomState, view: Size, image: Size, room: Size = { width: 0, height: 0 }): boolean {
  return close(state.scale, fitScale(view, image, room))
}

/** The scale clamped into what the view allows: the fit at least, `MAX_SCALE` at most. */
function clampedScale(scale: number, view: Size, image: Size, room: Size): number {
  return Math.min(Math.max(scale, fitScale(view, image, room)), MAX_SCALE)
}

/**
 * `state` as the view allows it now: its scale back between fit and `MAX_SCALE`, and its top-left back over the view —
 * an image smaller than it (at fit, say) stays centred, a larger one keeps an edge or is pulled back inside. The view
 * and the image's `room` may have changed under it (the window resized), or panning may have crept past an edge.
 */
export function clampState(
  state: ImageZoomState,
  view: Size,
  image: Size,
  room: Size = { width: 0, height: 0 },
): ImageZoomState {
  return panBy({ ...state, scale: clampedScale(state.scale, view, image, room) }, view, image, 0, 0)
}

/**
 * Zooms `state` to `scale`, keeping the image point under `anchor` (in the view; the view's centre for none) under it,
 * clamped as the view allows. Zoomed out to fit or in past `MAX_SCALE`, the anchor drifts — nothing keeps it there.
 */
export function zoomToScale(
  state: ImageZoomState,
  view: Size,
  image: Size,
  scale: number,
  anchor?: Size,
  room: Size = { width: 0, height: 0 },
): ImageZoomState {
  const next = clampedScale(scale, view, image, room)
  const at = anchor ?? { width: view.width / 2, height: view.height / 2 }
  const ratio = next / state.scale
  return panBy(
    {
      scale: next,
      tx: at.width - (at.width - state.tx) * ratio,
      ty: at.height - (at.height - state.ty) * ratio,
    },
    view,
    image,
    0,
    0,
  )
}

/** Zooms `state` by `factor`, around `anchor`. A factor of 1 leaves it as it is. */
export function zoomByFactor(
  state: ImageZoomState,
  view: Size,
  image: Size,
  factor: number,
  anchor?: Size,
  room: Size = { width: 0, height: 0 },
): ImageZoomState {
  return zoomToScale(state, view, image, state.scale * factor, anchor, room)
}

/** The zoom a pinch (`wheel` with `ctrlKey`, `deltaY` up when pinching out) makes, around the pointer. */
export function zoomForPinch(
  state: ImageZoomState,
  view: Size,
  image: Size,
  deltaY: number,
  anchor: Size,
  room: Size = { width: 0, height: 0 },
): ImageZoomState {
  return zoomByFactor(state, view, image, Math.exp(-deltaY * PINCH_RATE), anchor, room)
}

/**
 * Pans `state` by (`dx`, `dy`) view pixels, then keeps the image over the view: one smaller than it is pulled back to
 * the centre, a larger one stops with an edge at the view's edge — never a gap between image and view.
 */
export function panBy(state: ImageZoomState, view: Size, image: Size, dx: number, dy: number): ImageZoomState {
  const width = image.width * state.scale
  const height = image.height * state.scale
  return { ...state, tx: panAxis(state.tx + dx, view.width, width), ty: panAxis(state.ty + dy, view.height, height) }
}

/** One axis of `panBy`: clamped over the view, or centred when the image fits it (then `dx` or `dy` does nothing). */
function panAxis(next: number, viewSize: number, imageSize: number): number {
  if (imageSize <= viewSize) return (viewSize - imageSize) / 2
  return Math.min(Math.max(next, viewSize - imageSize), 0)
}

/**
 * What a click on the image at `anchor` does: fit goes to actual size with the clicked spot kept under the pointer;
 * anything else goes back to fit, centred. An image that fits at its own size is the same both ways, so the click
 * leaves it as it is.
 */
export function toggleFit(
  state: ImageZoomState,
  view: Size,
  image: Size,
  anchor?: Size,
  room: Size = { width: 0, height: 0 },
): ImageZoomState {
  if (isAtFit(state, view, image, room)) return zoomToScale(state, view, image, 1, anchor, room)
  return fitState(view, image, room)
}
