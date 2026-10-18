// The image zoom's event handling (#685): jsdom lays nothing out, so the view reports its box from a stub (its
// clientWidth and clientHeight, and a ResizeObserver the tests fire), and the gestures are fired at it as events.
// The maths itself is zoomModel's, checked in its own test; here it's that the right gesture does the right thing.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppCommandId } from '../../shared/commands'
import { storeWrapper } from '../store/test-wrapper'
import { naturalSizeOf, runImageZoomCommand, useImageZoom } from './useImageZoom'

/** The view the stub lays out: 600×500 to start, changeable to test the view resizing. */
let view: { width: number; height: number } = { width: 600, height: 500 }

/** A natural 1200×900 image, larger than the view, so there's room to pan once it's zoomed in. */
const IMAGE = { width: 1200, height: 900 }
/** The fit of IMAGE in the view as it starts: 600/1200 = 0.5, which is also the height's limit. */
const FIT = 0.5
const FITTED = { left: 0, top: 25, width: 600, height: 450 }

/** The view box's style as numbers, from its placeholder frame. */
function box(): { left: number; top: number; width: number; height: number } {
  const frame = screen.getByTestId('frame')
  return {
    left: Number.parseFloat(frame.style.left),
    top: Number.parseFloat(frame.style.top),
    width: Number.parseFloat(frame.style.width),
    height: Number.parseFloat(frame.style.height),
  }
}

function zoomed(): boolean {
  return screen.getByTestId('frame').hasAttribute('data-zoomed')
}

/** A pinch over the view, at its centre: `deltaY` up as the pinch opens. */
function pinch(deltaY: number, at: { x: number; y: number } = { x: 300, y: 250 }): void {
  fireEvent.wheel(screen.getByTestId('view'), { ctrlKey: true, deltaY, clientX: at.x, clientY: at.y })
}

/** A scroll over the view. */
function scroll(deltaY: number): void {
  fireEvent.wheel(screen.getByTestId('view'), { deltaY })
}

function press(at: { x: number; y: number }, on: 'view' | 'frame' = 'frame'): void {
  fireEvent.pointerDown(screen.getByTestId(on), { pointerId: 1, button: 0, clientX: at.x, clientY: at.y })
}

function moveTo(at: { x: number; y: number }): void {
  fireEvent.pointerMove(screen.getByTestId('view'), { pointerId: 1, clientX: at.x, clientY: at.y })
}

function release(at: { x: number; y: number }): void {
  fireEvent.pointerUp(screen.getByTestId('view'), { pointerId: 1, clientX: at.x, clientY: at.y })
}

/** A press, a drag by `by`, and a release: the image follows the pointer once zoomed in. */
function drag(by: { x: number; y: number }): void {
  press({ x: 300, y: 250 })
  moveTo({ x: 300 + by.x, y: 250 + by.y })
  release({ x: 300 + by.x, y: 250 + by.y })
}

/** A press and a release where it went down: a click. */
function click(on: 'view' | 'frame', at: { x: number; y: number } = { x: 300, y: 250 }): void {
  press(at, on)
  release(at)
}

function key(key: string): void {
  fireEvent.keyDown(window, { key, metaKey: true })
}

/** The harness: a view box with the zoomed placeholder frame in it, wired as the image views are. */
function Harness(props: {
  natural?: { width: number; height: number } | null
  imageKey?: string
  takesKeys?: boolean
  onBlankClick?: () => void
}): React.JSX.Element {
  const { viewRef, frameRef, frameStyle, zoomed } = useImageZoom({
    natural: props.natural === undefined ? IMAGE : props.natural,
    imageKey: props.imageKey ?? 'one',
    takesKeys: props.takesKeys ?? false,
    onBlankClick: props.onBlankClick,
  })
  return (
    <div ref={viewRef} data-testid="view" tabIndex={0}>
      <div ref={frameRef} data-testid="frame" data-zoomed={zoomed ? '' : undefined} style={frameStyle ?? undefined} />
    </div>
  )
}

describe('useImageZoom', () => {
  let setPointerCapture: (pointerId: number) => void
  let releasePointerCapture: (pointerId: number) => void

  beforeEach(() => {
    // jsdom's DOM has no pointer capture (the zoom drops it there; a browser always has it, and its view does too).
    setPointerCapture = vi.fn(() => undefined)
    releasePointerCapture = vi.fn(() => undefined)
    Element.prototype.setPointerCapture = function capture(pointerId: number): void {
      setPointerCapture(pointerId)
    }
    Element.prototype.releasePointerCapture = function letGo(pointerId: number): void {
      releasePointerCapture(pointerId)
    }
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'view' ? view.width : 0
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
      return this.dataset.testid === 'view' ? view.height : 0
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete (Element.prototype as { setPointerCapture?: unknown }).setPointerCapture
    delete (Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture
  })

  it('starts at the fit, centred, and not zoomed', () => {
    const { wrapper } = storeWrapper()
    render(<Harness />, { wrapper })
    expect(box()).toEqual(FITTED)
    expect(zoomed()).toBe(false)
  })

  it('lays the image out as it did while it has no natural size, then fits once it does', () => {
    const { wrapper } = storeWrapper()
    const { rerender } = render(<Harness natural={null} />, { wrapper })
    expect(screen.getByTestId('frame').style.length).toBe(0)
    rerender(<Harness natural={IMAGE} />)
    expect(box()).toEqual(FITTED)
  })

  it('pinches in around the pointer, and out again, never past the fit', () => {
    const { wrapper } = storeWrapper()
    render(<Harness />, { wrapper })
    pinch(-100)
    // The fit is half the image's width, so e^1 of pinch raises the scale from 0.5 to 0.5·e: about 1.36×, anchored so
    // the image's middle (where the pointer was) stays there.
    expect(zoomed()).toBe(true)
    expect(box().width).toBeCloseTo(600 * Math.E)
    expect(box().left + box().width / 2).toBeCloseTo(300)
    pinch(100)
    expect(zoomed()).toBe(false)
    expect(box()).toEqual(FITTED)
    // Pinching out at the fit stays there.
    pinch(100)
    expect(box()).toEqual(FITTED)
  })

  it('zooms with ⌘+ and ⌘− and returns to fit with ⌘0, while the view takes the zoom keys', () => {
    const { wrapper, store } = storeWrapper()
    render(<Harness takesKeys />, { wrapper })
    key('=')
    expect(box().width).toBeCloseTo(600 * 1.25)
    key('-')
    expect(box()).toEqual(FITTED)
    // ⌘− at the fit stays there.
    key('-')
    expect(box()).toEqual(FITTED)
    key('=')
    key('0')
    expect(box()).toEqual(FITTED)
    // While it takes the keys, the window says so, and the View menu's zoom items zoom it.
    expect(store.getState().openImageZoomCount).toBe(1)
    act(() => {
      expect(runImageZoomCommand(AppCommandId.ZoomIn)).toBe(true)
    })
    expect(box().width).toBeCloseTo(600 * 1.25)
    act(() => {
      expect(runImageZoomCommand(AppCommandId.ZoomFit)).toBe(true)
    })
    expect(box()).toEqual(FITTED)
    act(() => {
      expect(runImageZoomCommand(AppCommandId.ZoomOut)).toBe(true)
    })
    expect(box()).toEqual(FITTED)
  })

  it('does none of that while the view doesn’t take the zoom keys, and does once it has the focus', () => {
    const { wrapper, store } = storeWrapper()
    const onBlankClick = vi.fn()
    render(<Harness onBlankClick={onBlankClick} />, { wrapper })
    key('=')
    expect(box()).toEqual(FITTED)
    expect(runImageZoomCommand(AppCommandId.ZoomIn)).toBe(false)
    expect(store.getState().openImageZoomCount).toBe(0)
    fireEvent.focusIn(screen.getByTestId('view'))
    expect(store.getState().openImageZoomCount).toBe(1)
    key('=')
    expect(box().width).toBeCloseTo(600 * 1.25)
    // The focus leaving the view (to nothing outside it) takes the keys back.
    fireEvent.focusOut(screen.getByTestId('view'))
    expect(store.getState().openImageZoomCount).toBe(0)
  })

  it('pans a scroll once zoomed in, and nothing while at fit', () => {
    const { wrapper } = storeWrapper()
    render(<Harness />, { wrapper })
    scroll(100)
    expect(box()).toEqual(FITTED)
    pinch(-100)
    const at = box()
    scroll(100)
    // The scroll pans up, and sideways nothing (the wheel's deltaX is 0): the image is wider than the view.
    expect(box().top).toBeCloseTo(at.top - 100)
    expect(box().left).toBeCloseTo(at.left)
  })

  it('pans a drag once zoomed in, the image following the pointer, and a press that stays put is a click instead', () => {
    const { wrapper } = storeWrapper()
    render(<Harness />, { wrapper })
    pinch(-100)
    const at = box()
    drag({ x: 40, y: -30 })
    expect(box().left).toBeCloseTo(at.left + 40)
    expect(box().top).toBeCloseTo(at.top - 30)
    // Back at fit, a drag pans nothing: the image is centred there. (The view takes ⌘0 once it has the focus.)
    fireEvent.focusIn(screen.getByTestId('view'))
    key('0')
    drag({ x: 40, y: 40 })
    expect(box()).toEqual(FITTED)
  })

  it('toggles between fit and actual size at the clicked spot, on the image', () => {
    const { wrapper } = storeWrapper()
    render(<Harness />, { wrapper })
    // The image's own middle, at fit, sits at (300, 250) — the click puts it under the pointer at actual size.
    click('frame', { x: 300, y: 250 })
    expect(zoomed()).toBe(true)
    expect(box().width).toBe(1200)
    expect(box().left + box().width / 2).toBeCloseTo(300)
    expect(box().top + box().height / 2).toBeCloseTo(250)
    // A click again goes back to the fit, centred.
    click('frame')
    expect(box()).toEqual(FITTED)
    // ↵ toggles it too, from the view's centre.
    fireEvent.focusIn(screen.getByTestId('view'))
    fireEvent.keyDown(screen.getByTestId('view'), { key: 'Enter' })
    expect(box().width).toBe(1200)
    fireEvent.keyDown(screen.getByTestId('view'), { key: ' ' })
    expect(box()).toEqual(FITTED)
  })

  it('hands a click beside the image to the view’s own click, and zooms there without one', () => {
    const { wrapper } = storeWrapper()
    const { rerender } = render(<Harness />, { wrapper })
    const onBlankClick = vi.fn()
    rerender(<Harness onBlankClick={onBlankClick} />)
    click('view', { x: 20, y: 20 })
    expect(onBlankClick).toHaveBeenCalledOnce()
    rerender(<Harness />)
    click('view', { x: 20, y: 20 })
    // The zoom goes to actual size keeping the image point the click showed (40, -10 in the image) under the pointer,
    // panned back inside where actual size would put it past the view's edge.
    expect(box().width).toBe(1200)
    expect(box().left).toBeCloseTo(20 - (20 - FITTED.left) / FIT)
    expect(box().top).toBe(0)
  })

  it('toggles for a click with no press behind it, as an assistive technology sends one', () => {
    const { wrapper } = storeWrapper()
    render(<Harness />, { wrapper })
    // `detail` 0: no pointer press. On the image it toggles at the spot.
    fireEvent.click(screen.getByTestId('frame'), { detail: 0, clientX: 300, clientY: 250 })
    expect(box().width).toBe(1200)
    // And beside it, without the view's own click to hand it to, it zooms there.
    fireEvent.click(screen.getByTestId('view'), { detail: 0, clientX: 20, clientY: 20 })
    expect(box()).toEqual(FITTED)
    // A real pointer's click (detail 1) was already handled by its pointerup: it does nothing here.
    fireEvent.click(screen.getByTestId('frame'), { detail: 1, clientX: 300, clientY: 250 })
    expect(box()).toEqual(FITTED)
  })

  it('starts over when another image shows', () => {
    const { wrapper } = storeWrapper()
    const { rerender } = render(<Harness />, { wrapper })
    pinch(-100)
    expect(zoomed()).toBe(true)
    rerender(<Harness imageKey="two" />)
    expect(box()).toEqual(FITTED)
    expect(zoomed()).toBe(false)
  })

  it('keeps the zoom within the view as the view changes', () => {
    const observers: (() => void)[] = []
    class FakeResizeObserver {
      constructor(callback: () => void) {
        observers.push(callback)
      }
      observe = (): void => undefined
      unobserve = (): void => undefined
      disconnect = (): void => undefined
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    try {
      const { wrapper } = storeWrapper()
      render(<Harness />, { wrapper })
      expect(observers).toHaveLength(1)
      // The panel narrows: the zoom is kept, clamped over the view it now overflows, and panned back inside.
      view = { width: 300, height: 500 }
      act(() => {
        observers[0]?.()
      })
      expect(box()).toEqual({ left: 0, top: 25, width: 600, height: 450 })
      expect(zoomed()).toBe(true)
      // Wide again: the same zoom is the fit of the view it started in, and the image recentres.
      view = { width: 600, height: 500 }
      act(() => {
        observers[0]?.()
      })
      expect(box()).toEqual(FITTED)
      expect(zoomed()).toBe(false)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('reads an image element’s natural size once it has one', () => {
    const image = document.createElement('img')
    expect(naturalSizeOf(image)).toBeNull()
    Object.defineProperty(image, 'naturalWidth', { value: 320 })
    Object.defineProperty(image, 'naturalHeight', { value: 200 })
    expect(naturalSizeOf(image)).toEqual({ width: 320, height: 200 })
  })
})
