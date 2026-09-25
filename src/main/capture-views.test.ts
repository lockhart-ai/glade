import { describe, expect, it, vi } from 'vitest'
import {
  captureViewOf,
  composeViews,
  coverage,
  parseSlots,
  pasteView,
  SLOTS_SCRIPT,
  viewsSettled,
  type Bitmap,
  type BitmapImage,
  type CaptureView,
  type NativeView,
} from './capture-views'

/** A bitmap of one colour, as BGRA bytes. */
function solid(width: number, height: number, value: number): Bitmap {
  return { data: Buffer.alloc(width * height * 4, value), width, height }
}

function pixel(bitmap: Bitmap, x: number, y: number): number {
  return bitmap.data[(y * bitmap.width + x) * 4] ?? -1
}

function image(bitmap: Bitmap): BitmapImage & { resized: { width: number; height: number }[] } {
  const resized: { width: number; height: number }[] = []
  return {
    resized,
    getSize: () => ({ width: bitmap.width, height: bitmap.height }),
    resize({ width, height }) {
      resized.push({ width, height })
      return image(solid(width, height, bitmap.data[0] ?? 0))
    },
    toBitmap: () => bitmap.data,
  }
}

function view(overrides: Partial<CaptureView> = {}): CaptureView {
  return {
    bounds: { x: 2, y: 1, width: 4, height: 3 },
    visible: true,
    radius: 0,
    settle: () => Promise.resolve(),
    capture: () => Promise.resolve(image(solid(4, 3, 200))),
    ...overrides,
  }
}

describe('coverage', () => {
  it('covers every pixel without a radius, and the middle and edges with one', () => {
    expect(coverage(0, 0, 10, 10, 0)).toBe(1)
    expect(coverage(5, 5, 10, 10, 4)).toBe(1)
    expect(coverage(5, 0, 10, 10, 4)).toBe(1)
    expect(coverage(0, 5, 10, 10, 4)).toBe(1)
  })

  it('leaves the very corners out, and blends the pixels on the curve', () => {
    expect(coverage(0, 0, 10, 10, 4)).toBe(0)
    expect(coverage(9, 9, 10, 10, 4)).toBe(0)
    expect(coverage(9, 0, 10, 10, 4)).toBe(0)
    expect(coverage(0, 9, 10, 10, 4)).toBe(0)
    const edge = coverage(1, 1, 10, 10, 4)
    expect(edge).toBeGreaterThan(0)
    expect(edge).toBeLessThanOrEqual(1)
    expect(coverage(3, 3, 10, 10, 4)).toBe(1)
  })
})

describe('pasteView', () => {
  it('copies the view over the base where it goes, and leaves the rest', () => {
    const base = solid(8, 6, 10)
    pasteView(base, solid(4, 3, 200), { x: 2, y: 1 }, 0)

    expect(pixel(base, 2, 1)).toBe(200)
    expect(pixel(base, 5, 3)).toBe(200)
    expect(pixel(base, 1, 1)).toBe(10)
    expect(pixel(base, 6, 1)).toBe(10)
    expect(pixel(base, 2, 4)).toBe(10)
  })

  it('rounds its corners, keeping the base there', () => {
    const base = solid(12, 12, 10)
    pasteView(base, solid(10, 10, 200), { x: 1, y: 1 }, 4)

    expect(pixel(base, 1, 1)).toBe(10)
    expect(pixel(base, 10, 10)).toBe(10)
    expect(pixel(base, 6, 1)).toBe(200)
    expect(pixel(base, 6, 6)).toBe(200)
  })

  it('clips a view that hangs off the base', () => {
    const base = solid(4, 4, 10)
    pasteView(base, solid(4, 4, 200), { x: 2, y: -2 }, 0)

    expect(pixel(base, 3, 0)).toBe(200)
    expect(pixel(base, 3, 1)).toBe(200)
    expect(pixel(base, 3, 2)).toBe(10)
    expect(pixel(base, 1, 0)).toBe(10)
  })
})

describe('parseSlots and viewsSettled', () => {
  const slot = { x: 2, y: 1, width: 4, height: 3 }

  it('asks for the slots whose views show: not one an overlay covers, whose view is hidden', () => {
    expect(SLOTS_SCRIPT).toContain(
      "document.querySelectorAll('[data-native-view-slot]:not([data-native-view-covered])')",
    )
  })

  it("reads the page's slots, and none from anything else", () => {
    expect(parseSlots(JSON.stringify([slot]))).toEqual([slot])
    expect(parseSlots(undefined)).toEqual([])
  })

  it('is settled once every slot has a view showing over it, and no view shows elsewhere', () => {
    expect(viewsSettled([], [])).toBe(true)
    expect(viewsSettled([], [view({ visible: false })])).toBe(true)
    expect(viewsSettled([slot], [view()])).toBe(true)
    expect(viewsSettled([slot], [])).toBe(false)
    expect(viewsSettled([slot], [view({ bounds: { ...slot, width: 5 } })])).toBe(false)
    expect(viewsSettled([slot], [view({ visible: false })])).toBe(false)
    expect(viewsSettled([], [view()])).toBe(false)
  })
})

describe('composeViews', () => {
  it("pastes each showing view in at the page's scale, resizing its capture to fit", async () => {
    const page = image(solid(16, 12, 10))
    const small = image(solid(4, 3, 200))
    const hidden = vi.fn(() => Promise.resolve(image(solid(4, 3, 99))))

    const composed = await composeViews(page, 8, [
      view({ capture: () => Promise.resolve(small) }),
      view({ visible: false, capture: hidden }),
    ])

    expect(small.resized).toEqual([{ width: 8, height: 6 }])
    expect(hidden).not.toHaveBeenCalled()
    expect({ width: composed.width, height: composed.height }).toEqual({ width: 16, height: 12 })
    expect(pixel(composed, 4, 2)).toBe(200)
    expect(pixel(composed, 11, 7)).toBe(200)
    expect(pixel(composed, 3, 2)).toBe(10)
  })

  it("keeps a view's capture that's already the right size", async () => {
    const exact = image(solid(4, 3, 200))

    await composeViews(image(solid(8, 6, 10)), 8, [view({ capture: () => Promise.resolve(exact) })])

    expect(exact.resized).toEqual([])
  })
})

describe('captureViewOf', () => {
  function native(loading: boolean[]): NativeView & { calls: string[] } {
    const calls: string[] = []
    return {
      calls,
      getBounds: () => ({ x: 10, y: 20, width: 300, height: 200 }),
      getVisible: () => true,
      webContents: {
        isLoading: () => loading.shift() ?? false,
        enableDeviceEmulation: (parameters) => {
          calls.push(`emulate ${String(parameters.viewSize.width)}x${String(parameters.viewSize.height)}`)
        },
        executeJavaScript: (code) => {
          calls.push(code.includes("readyState === 'complete'") ? 'wait until loaded' : code)
          return Promise.resolve(true)
        },
        capturePage: (rect) => {
          calls.push(`capture ${JSON.stringify(rect)}`)
          return Promise.resolve(image(solid(300, 200, 1)))
        },
      },
    }
  }

  it('waits for the page to load, lays it out at its bounds, then captures just that', async () => {
    const webContentsView = native([true, true, false])
    const captured = captureViewOf(webContentsView, 15)

    expect(captured).toMatchObject({ bounds: { x: 10, y: 20, width: 300, height: 200 }, visible: true, radius: 15 })
    await captured.settle()
    await captured.capture()

    expect(webContentsView.calls).toEqual([
      'emulate 300x200',
      'wait until loaded',
      'capture {"x":0,"y":0,"width":300,"height":200}',
    ])
  })
})
