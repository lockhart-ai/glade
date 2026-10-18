/**
 * The zoom of an image view (#685), shared by the Files tab's picture and the image viewer over the window: trackpad
 * pinch (which Chromium sends as `wheel` events with `ctrlKey`) zooms around the pointer, ⌘+ and ⌘− zoom, ⌘0 returns
 * to fit, a click on the image toggles fit and actual size at the clicked spot, and zoomed in, a drag or a scroll
 * pans. The maths is `zoomModel`'s; this measures the view, takes the gestures and places the image at its box.
 *
 * While the view takes the zoom keys — showing, for the overlay; focused, for a picture in the Files tab — it is
 * registered here, so the View menu's zoom items (`AppCommandId.Zoom*`, which main sends only then) zoom it, and the
 * window reports the fact to main (`MenuState.imageZoom`).
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import { AppCommandId } from '../../shared/commands'
import { useGladeStore } from '../store/react'
import {
  clampState,
  DRAG_THRESHOLD,
  fitState,
  isAtFit,
  panBy,
  toggleFit,
  zoomByFactor,
  zoomForPinch,
  ZOOM_KEY_FACTOR,
  type ImageZoomState,
  type Size,
} from './zoomModel'

/** Where the image goes in its view: its top-left, and its size including any border the view draws around it. */
export interface ImageZoomBox {
  readonly left: number
  readonly top: number
  readonly width: number
  readonly height: number
}

export interface UseImageZoomProps {
  /** The image's natural size, once known; null until it is, while the consumer lays it out as it always did. */
  readonly natural: Size | null
  /** What tells two images apart: when it changes, the zoom resets to the new image's fit. */
  readonly imageKey: string
  /**
   * Chrome the view draws around the image's own pixels, counted into the box: the viewer's frame is its image plus a
   * 1px border all round. Nothing extra by default.
   */
  readonly frameInset?: Size
  /** Room the fit keeps free around the image, for the viewer's close button and pager. None by default. */
  readonly fitRoom?: Size
  /** Whether the view takes the zoom keys for as long as it shows (the overlay); a picture in the Files tab takes them while it has the focus. */
  readonly takesKeys?: boolean
  /**
   * Called for a click that isn't on the image — the viewer's backdrop, which closes it. Without one, a click beside
   * the image zooms there, as a click on the image does.
   */
  readonly onBlankClick?: () => void
}

export interface ImageZoom {
  /** Puts the view on its element: the box that clips the image and takes the gestures. */
  readonly viewRef: (node: HTMLElement | null) => void
  /** Puts the zoom box on the image's element (the image, or the frame that holds it). */
  readonly frameRef: (node: HTMLElement | null) => void
  /**
   * Where the image is now, as the style for `frameRef`'s element; undefined until the image has its size, while the
   * consumer's own layout (fit, or the card for one that can't be shown) stands.
   */
  readonly frameStyle: CSSProperties | undefined
  /** Whether it's zoomed in past fit: the view clips it, and a drag or a scroll pans it. */
  readonly zoomed: boolean
}

/** What one active image view answers the View menu's zoom items with, while it takes the zoom keys. */
interface ActiveZoomView {
  readonly zoomIn: () => void
  readonly zoomOut: () => void
  readonly fit: () => void
}

/** The image views taking the zoom keys now, last registered last: that one answers the View menu. */
const activeViews: ActiveZoomView[] = []

/**
 * Runs one of the View menu's zoom commands on the image view that takes the zoom keys (the one that registered
 * last); false when none does, which shouldn't happen — main only sends these while `MenuState.imageZoom` holds.
 */
export function runImageZoomCommand(id: AppCommandId.ZoomIn | AppCommandId.ZoomOut | AppCommandId.ZoomFit): boolean {
  const view = activeViews.at(-1)
  if (view === undefined) return false
  if (id === AppCommandId.ZoomOut) view.zoomOut()
  else if (id === AppCommandId.ZoomFit) view.fit()
  else view.zoomIn()
  return true
}

/** The image's size the zoom works with: its own, plus the view's chrome around it, on each axis. */
function outerSize(natural: Size, inset: Size): Size {
  return { width: natural.width + inset.width * 2, height: natural.height + inset.height * 2 }
}

/** The natural size of an image element that has loaded; null while it hasn't, or it has none to give. */
export function naturalSizeOf(image: HTMLImageElement): Size | null {
  return image.naturalWidth === 0 ? null : { width: image.naturalWidth, height: image.naturalHeight }
}

export function useImageZoom({
  natural,
  imageKey,
  frameInset = { width: 0, height: 0 },
  fitRoom = { width: 0, height: 0 },
  takesKeys = false,
  onBlankClick,
}: UseImageZoomProps): ImageZoom {
  // The view and the frame, as state: a ref alone can't tell the effects below that the element has arrived — the
  // viewer's portal mounts its content after the first commit, and an effect that ran before it never re-runs.
  const [viewNode, setViewNode] = useState<HTMLElement | null>(null)
  const [frameNode, setFrameNode] = useState<HTMLElement | null>(null)
  const viewRef = useCallback((node: HTMLElement | null): void => {
    setViewNode(node)
  }, [])
  const frameRef = useCallback((node: HTMLElement | null): void => {
    setFrameNode(node)
  }, [])
  const imageZoomOpened = useGladeStore((state) => state.imageZoomOpened)
  const imageZoomClosed = useGladeStore((state) => state.imageZoomClosed)
  const [viewSize, setViewSize] = useState<Size | null>(null)
  const [state, setState] = useState<ImageZoomState | null>(null)
  const [focused, setFocused] = useState(false)
  // The image's outer size, for the model: its own pixels plus the chrome the view draws around them.
  const outer = natural === null ? null : outerSize(natural, frameInset)
  // A different image showing: its zoom starts over, at its own fit (React's pattern for adjusting state when a prop
  // changes, as `FileViewer` does for a shown line).
  const [shown, setShown] = useState(imageKey)
  if (shown !== imageKey) {
    setShown(imageKey)
    setState(null)
  }
  // What the effects and their gestures read, kept current after each render: the props are objects a caller may
  // rebuild at will, so they can't be dependencies, and the gestures read the zoom as it is now, not as the bind was.
  const latest = useRef({ natural, outer, fitRoom, state, onBlankClick })
  useEffect(() => {
    latest.current = { natural, outer, fitRoom, state, onBlankClick }
  })

  const apply = useCallback((zoom: (state: ImageZoomState) => ImageZoomState): void => {
    setState((previous) => (previous === null ? null : zoom(previous)))
  }, [])

  // The view's size, as it is now and as it changes (the window resized, the panel opened or closed).
  useEffect(() => {
    if (viewNode === null) return
    const measure = (): void => {
      setViewSize({ width: viewNode.clientWidth, height: viewNode.clientHeight })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(viewNode)
    return () => {
      observer.disconnect()
    }
  }, [viewNode])

  // The image has its size: start it at its fit. The effect turns on the size as numbers (a stable key), since the
  // props themselves are objects the caller may rebuild each render.
  const naturalKey = natural === null ? null : `${String(natural.width)}x${String(natural.height)}`
  useEffect(() => {
    const { outer, fitRoom } = latest.current
    if (state === null && viewSize !== null && outer !== null) setState(fitState(viewSize, outer, fitRoom))
  }, [state, viewSize, naturalKey])

  // The view resized: keep the zoom the view allows — back to fit at most, over the view at least.
  useEffect(() => {
    const { outer, fitRoom } = latest.current
    if (viewSize === null || outer === null) return
    setState((previous) => (previous === null ? null : clampState(previous, viewSize, outer, fitRoom)))
  }, [viewSize])

  const context = useCallback(
    (): { readonly view: Size; readonly image: Size; readonly room: Size } | null =>
      viewSize === null || latest.current.outer === null
        ? null
        : { view: viewSize, image: latest.current.outer, room: latest.current.fitRoom },
    [viewSize],
  )
  const zoomIn = useCallback((): void => {
    const at = context()
    if (at !== null) {
      apply((previous) => zoomByFactor(previous, at.view, at.image, ZOOM_KEY_FACTOR, undefined, at.room))
    }
  }, [apply, context])
  const zoomOut = useCallback((): void => {
    const at = context()
    if (at !== null) {
      apply((previous) => zoomByFactor(previous, at.view, at.image, 1 / ZOOM_KEY_FACTOR, undefined, at.room))
    }
  }, [apply, context])
  const fit = useCallback((): void => {
    const at = context()
    if (at !== null) apply(() => fitState(at.view, at.image, at.room))
  }, [apply, context])
  const toggleAt = useCallback(
    (anchor: Size | undefined): void => {
      const at = context()
      if (at !== null) apply((previous) => toggleFit(previous, at.view, at.image, anchor, at.room))
    },
    [apply, context],
  )

  // While the view takes the zoom keys, it answers the View menu's zoom items, and they directly — the menu bar
  // takes a real ⌘+, ⌘− or ⌘0 for itself, but a key that reaches the page (a synthetic one, or a stale menu's) is
  // the image's to zoom.
  const active = takesKeys || focused
  useEffect(() => {
    if (!active) return
    imageZoomOpened()
    const view: ActiveZoomView = { zoomIn, zoomOut, fit }
    activeViews.push(view)
    const onZoomKeys = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
      if (event.key === '=' || event.key === '+') {
        event.preventDefault()
        zoomIn()
      } else if (event.key === '-') {
        event.preventDefault()
        zoomOut()
      } else if (event.key === '0') {
        event.preventDefault()
        fit()
      }
    }
    window.addEventListener('keydown', onZoomKeys)
    return () => {
      imageZoomClosed()
      activeViews.splice(activeViews.indexOf(view), 1)
      window.removeEventListener('keydown', onZoomKeys)
    }
  }, [active, zoomIn, zoomOut, fit, imageZoomOpened, imageZoomClosed])

  // The gestures, on the view itself. Wheel is attached natively: React's own wheel listener is passive, and the
  // pinch's preventDefault is what keeps the page zoom from taking the trackpad's pinch too.
  useEffect(() => {
    if (viewNode === null) return
    const onWheel = (event: WheelEvent): void => {
      const at = context()
      if (at === null) return
      if (event.ctrlKey) {
        // The trackpad's pinch: zoom around the pointer, and keep the page zoom off it.
        event.preventDefault()
        const bounds = viewNode.getBoundingClientRect()
        const pointer = { width: event.clientX - bounds.left, height: event.clientY - bounds.top }
        apply((previous) => zoomForPinch(previous, at.view, at.image, event.deltaY, pointer, at.room))
        return
      }
      // A scroll pans, once zoomed in; at fit there's nothing to pan, so the event goes on as it came.
      const current = latest.current.state
      if (current !== null && !isAtFit(current, at.view, at.image, at.room)) {
        event.preventDefault()
        apply((previous) => panBy(previous, at.view, at.image, -event.deltaX, -event.deltaY))
      }
    }
    viewNode.addEventListener('wheel', onWheel, { passive: false })

    // A click — on the image, the zoom toggles at the spot (fit to actual size there, or back to fit); beside it, the
    // view's own click (the viewer's backdrop closes it). Where the pointer landed says which.
    const clickAt = (target: EventTarget | null, x: number, y: number): void => {
      const bounds = viewNode.getBoundingClientRect()
      const at = { width: x - bounds.left, height: y - bounds.top }
      if (target instanceof Node && frameNode?.contains(target) === true) toggleAt(at)
      else if (latest.current.onBlankClick !== undefined) latest.current.onBlankClick()
      else toggleAt(at)
    }
    // A press that travels no further than the threshold is a click; a longer press is a drag: it pans.
    let last: { x: number; y: number } | null = null
    let travelled = 0
    let downTarget: EventTarget | null = null
    const onPointerDown = (event: PointerEvent): void => {
      last = { x: event.clientX, y: event.clientY }
      travelled = 0
      // The capture retargets the events that follow to the view, so the press's own target is kept for the click.
      // (An automation's DOM may not have it; a browser always does, and a pointer already gone is fine to drop.)
      downTarget = event.target
      if (typeof viewNode.setPointerCapture === 'function') viewNode.setPointerCapture(event.pointerId)
    }
    const onPointerMove = (event: PointerEvent): void => {
      if (last === null) return
      // The image follows the pointer: it pans by how far the pointer has moved since the last event.
      const dx = event.clientX - last.x
      const dy = event.clientY - last.y
      last = { x: event.clientX, y: event.clientY }
      travelled += Math.abs(dx) + Math.abs(dy)
      if (travelled > DRAG_THRESHOLD) {
        const at = context()
        if (at !== null) apply((previous) => panBy(previous, at.view, at.image, dx, dy))
      }
    }
    const onPointerUp = (event: PointerEvent): void => {
      const wasClick = last !== null && travelled <= DRAG_THRESHOLD
      const target = downTarget
      last = null
      downTarget = null
      if (!wasClick) return
      clickAt(target, event.clientX, event.clientY)
    }
    const onPointerCancel = (): void => {
      last = null
      downTarget = null
    }
    viewNode.addEventListener('pointerdown', onPointerDown)
    viewNode.addEventListener('pointermove', onPointerMove)
    viewNode.addEventListener('pointerup', onPointerUp)
    viewNode.addEventListener('pointercancel', onPointerCancel)

    // A click with no press behind it (`detail` 0 — an assistive technology's, or an automation's, as a capture's
    // `element.click()` is) toggles the zoom as a pointer click does; a real pointer's was handled by its pointerup.
    const onClick = (event: MouseEvent): void => {
      if (event.detail !== 0) return
      clickAt(event.target, event.clientX, event.clientY)
    }
    viewNode.addEventListener('click', onClick)

    // ↵ or Space on the focused view (a picture in the Files tab, which the focus marks as its own) toggles the zoom,
    // as a click does; the overlay's keys go to its own controls, and it takes the zoom keys while it shows.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      event.preventDefault()
      toggleAt(undefined)
    }
    const onFocusIn = (): void => {
      setFocused(true)
    }
    const onFocusOut = (event: FocusEvent): void => {
      if (!(event.relatedTarget instanceof Node) || !viewNode.contains(event.relatedTarget)) setFocused(false)
    }
    viewNode.addEventListener('keydown', onKeyDown)
    viewNode.addEventListener('focusin', onFocusIn)
    viewNode.addEventListener('focusout', onFocusOut)

    return () => {
      viewNode.removeEventListener('wheel', onWheel)
      viewNode.removeEventListener('pointerdown', onPointerDown)
      viewNode.removeEventListener('pointermove', onPointerMove)
      viewNode.removeEventListener('pointerup', onPointerUp)
      viewNode.removeEventListener('pointercancel', onPointerCancel)
      viewNode.removeEventListener('click', onClick)
      viewNode.removeEventListener('keydown', onKeyDown)
      viewNode.removeEventListener('focusin', onFocusIn)
      viewNode.removeEventListener('focusout', onFocusOut)
    }
  }, [viewNode, apply, context, toggleAt, frameNode])

  const zoomed = state !== null && viewSize !== null && outer !== null && !isAtFit(state, viewSize, outer, fitRoom)
  const box: ImageZoomBox | null =
    state === null || viewSize === null || outer === null
      ? null
      : { left: state.tx, top: state.ty, width: outer.width * state.scale, height: outer.height * state.scale }
  return {
    viewRef,
    frameRef,
    frameStyle:
      box === null
        ? undefined
        : {
            position: 'absolute',
            left: box.left,
            top: box.top,
            width: box.width,
            height: box.height,
            maxWidth: 'none',
            maxHeight: 'none',
          },
    zoomed,
  }
}
