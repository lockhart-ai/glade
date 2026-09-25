/**
 * Native views in a capture: a plugin's view is drawn over the window's page by the OS, so `capturePage()` of the
 * page leaves a hole where it is. Capture mode waits for each view to settle over its slot in the page, captures it,
 * and pastes it into the page's capture, rounding its corners as the window does. Only ever runs in capture mode.
 */
import { NATIVE_VIEW_COVERED_ATTRIBUTE, NATIVE_VIEW_SLOT_ATTRIBUTE } from '../shared/ready'

/** A rectangle in the window, in points. */
export interface ViewRect {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** An image a capture pastes from or into: a NativeImage's size and raw BGRA pixels. */
export interface BitmapImage {
  getSize(): { width: number; height: number }
  resize(options: { width: number; height: number; quality: 'best' }): BitmapImage
  toBitmap(): Buffer
}

/** A native view over the window's page, as a capture sees it. */
export interface CaptureView {
  readonly bounds: ViewRect
  readonly visible: boolean
  /** Its corner radius, in points. */
  readonly radius: number
  /** Waits until its page has loaded and painted. */
  settle(): Promise<void>
  capture(): Promise<BitmapImage>
}

/** Raw BGRA pixels, row by row. */
export interface Bitmap {
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

/**
 * Asks the page (as JSON) for the boxes of its showing slots, rounded to whole points as main places views. A slot an
 * overlay covers has its view hidden, so it isn't showing.
 */
export const SLOTS_SCRIPT = `JSON.stringify([...document.querySelectorAll('[${NATIVE_VIEW_SLOT_ATTRIBUTE}]:not([${NATIVE_VIEW_COVERED_ATTRIBUTE}])')]
  .map((slot) => slot.getBoundingClientRect())
  .filter((box) => box.width > 0 && box.height > 0)
  .map((box) => ({ x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) })))`

/** Reads the page's answer to `SLOTS_SCRIPT`. */
export function parseSlots(json: unknown): ViewRect[] {
  return typeof json === 'string' ? (JSON.parse(json) as ViewRect[]) : []
}

function sameRect(a: ViewRect, b: ViewRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

/** Whether every slot has a view showing over it, and no view shows anywhere else. */
export function viewsSettled(slots: readonly ViewRect[], views: readonly CaptureView[]): boolean {
  const showing = views.filter((view) => view.visible)
  return showing.length === slots.length && slots.every((slot) => showing.some((view) => sameRect(view.bounds, slot)))
}

/** How much of a pixel (by its top left, in the view) lies inside the view's rounded corners: 0 to 1. */
export function coverage(x: number, y: number, width: number, height: number, radius: number): number {
  if (radius <= 0) return 1
  const px = x + 0.5
  const py = y + 0.5
  const cx = px < radius ? radius : px > width - radius ? width - radius : null
  const cy = py < radius ? radius : py > height - radius ? height - radius : null
  if (cx === null || cy === null) return 1
  const outside = Math.hypot(px - cx, py - cy) - radius
  return Math.min(1, Math.max(0, 0.5 - outside))
}

/** Pastes `view` into `base` with its top left at `at`, its corners rounded to `radius`: all in pixels. */
export function pasteView(base: Bitmap, view: Bitmap, at: { x: number; y: number }, radius: number): void {
  for (let y = 0; y < view.height; y += 1) {
    const ty = at.y + y
    if (ty < 0 || ty >= base.height) continue
    for (let x = 0; x < view.width; x += 1) {
      const tx = at.x + x
      if (tx < 0 || tx >= base.width) continue
      const cover = coverage(x, y, view.width, view.height, radius)
      if (cover === 0) continue
      const from = (y * view.width + x) * 4
      const to = (ty * base.width + tx) * 4
      for (let channel = 0; channel < 4; channel += 1) {
        const over = view.data[from + channel] ?? 0
        const under = base.data[to + channel] ?? 0
        base.data[to + channel] = Math.round(over * cover + under * (1 - cover))
      }
    }
  }
}

/**
 * The page's capture with each showing view pasted in where it is: `page` is the page captured at `contentWidth`
 * points wide (a Retina capture has twice the pixels), and the result is raw BGRA pixels the same size.
 */
export async function composeViews(
  page: BitmapImage,
  contentWidth: number,
  views: readonly CaptureView[],
): Promise<Bitmap> {
  const size = page.getSize()
  const scale = size.width / contentWidth
  const base: Bitmap = { data: Buffer.from(page.toBitmap()), width: size.width, height: size.height }
  for (const view of views.filter(({ visible }) => visible)) {
    const width = Math.round(view.bounds.width * scale)
    const height = Math.round(view.bounds.height * scale)
    let image = await view.capture()
    const captured = image.getSize()
    if (captured.width !== width || captured.height !== height) image = image.resize({ width, height, quality: 'best' })
    pasteView(
      base,
      { data: image.toBitmap(), width, height },
      { x: Math.round(view.bounds.x * scale), y: Math.round(view.bounds.y * scale) },
      view.radius * scale,
    )
  }
  return base
}

/**
 * Waits (in a view's page) until it has loaded and its fonts are ready. Not for a frame: a view in a window that's
 * never shown gets none, but `capturePage()` draws one.
 */
export const PAINTED_SCRIPT = `new Promise((resolve) => {
  const loaded = () => document.fonts.ready.then(() => resolve(true))
  if (document.readyState === 'complete') loaded()
  else window.addEventListener('load', loaded, { once: true })
})`

/** The parts of an Electron `WebContentsView` a capture reads. */
export interface NativeView {
  getBounds(): ViewRect
  getVisible(): boolean
  readonly webContents: {
    isLoading(): boolean
    executeJavaScript(code: string): Promise<unknown>
    enableDeviceEmulation(parameters: Electron.Parameters): void
    capturePage(rect: ViewRect): Promise<BitmapImage>
  }
}

/** How long a capture waits between looks at something it waits on. */
export const CAPTURE_POLL_MS = 20

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A `WebContentsView` drawn offscreen, as a capture sees it, with the corner radius it's drawn with. An offscreen view
 * lays its page out at the window's size, whatever its bounds, so the capture lays it out at its bounds' size itself.
 */
export function captureViewOf(view: NativeView, radius: number): CaptureView {
  const bounds = view.getBounds()
  const size = { width: bounds.width, height: bounds.height }
  return {
    bounds,
    visible: view.getVisible(),
    radius,
    async settle() {
      while (view.webContents.isLoading()) await delay(CAPTURE_POLL_MS)
      view.webContents.enableDeviceEmulation({
        screenPosition: 'desktop',
        screenSize: size,
        viewPosition: { x: 0, y: 0 },
        deviceScaleFactor: 0,
        viewSize: size,
        scale: 1,
      })
      await view.webContents.executeJavaScript(PAINTED_SCRIPT)
    },
    capture: () => view.webContents.capturePage({ x: 0, y: 0, ...size }),
  }
}
