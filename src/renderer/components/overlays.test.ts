import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCovered, OVERLAY_SHADOW_REACH, registerOverlay, useOverlayRef, watchOverlays } from './overlays'

/** An element laid out at this box, as jsdom never lays anything out. */
function boxed(x: number, y: number, width: number, height: number): HTMLElement {
  const element = document.createElement('div')
  element.getBoundingClientRect = () => new DOMRect(x, y, width, height)
  document.body.append(element)
  return element
}

/** The plugin card's body in the design's window, as its slot reports it. */
const SLOT = { x: 1232, y: 936, width: 680, height: 255 }

const releases: (() => void)[] = []
function register(element: HTMLElement): () => void {
  const release = registerOverlay(element)
  releases.push(release)
  return release
}

afterEach(() => {
  for (const release of releases.splice(0)) release()
  document.body.replaceChildren()
})

describe('isCovered', () => {
  it('is false with no overlay open', () => {
    expect(isCovered(SLOT)).toBe(false)
  })

  it('is true while an overlay overlaps the box, and false once it closes', () => {
    const release = register(boxed(1300, 800, 250, 185))
    expect(isCovered(SLOT)).toBe(true)
    release()
    expect(isCovered(SLOT)).toBe(false)
  })

  it('counts the reach of an overlay’s shadow as covering, on every side, and nothing past it', () => {
    const reach = OVERLAY_SHADOW_REACH
    const { x, y, width, height } = SLOT
    // Just inside the reach, on each side.
    for (const [ox, oy] of [
      [x - reach - 99, y],
      [x + width + reach - 1, y],
      [x, y - reach - 99],
      [x, y + height + reach - 1],
    ] as const) {
      const release = register(boxed(ox, oy, 100, 100))
      expect(isCovered(SLOT)).toBe(true)
      release()
    }
    // Just past it.
    for (const [ox, oy] of [
      [x - reach - 100, y],
      [x + width + reach, y],
      [x, y - reach - 100],
      [x, y + height + reach],
    ] as const) {
      const release = register(boxed(ox, oy, 100, 100))
      expect(isCovered(SLOT)).toBe(false)
      release()
    }
  })

  it('ignores an overlay with no box, and a far one, while another covers', () => {
    register(boxed(0, 0, 0, 0))
    register(boxed(20, 40, 200, 100))
    expect(isCovered(SLOT)).toBe(false)
    // The Settings modal's backdrop covers the whole window.
    register(boxed(0, 0, 1920, 1200))
    expect(isCovered(SLOT)).toBe(true)
  })

  it('reads the overlay’s box afresh each time: one that moves over the box covers it', () => {
    const element = boxed(20, 40, 200, 100)
    register(element)
    expect(isCovered(SLOT)).toBe(false)
    element.getBoundingClientRect = () => new DOMRect(1400, 900, 200, 100)
    expect(isCovered(SLOT)).toBe(true)
  })
})

describe('watchOverlays', () => {
  it('hears overlays open and close, until it stops watching', () => {
    const listener = vi.fn()
    const unwatch = watchOverlays(listener)
    const release = register(boxed(0, 0, 10, 10))
    expect(listener).toHaveBeenCalledTimes(1)
    release()
    expect(listener).toHaveBeenCalledTimes(2)
    unwatch()
    register(boxed(0, 0, 10, 10))
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('hears an overlay being positioned, and its animation or transition ending, but no longer once it’s closed', async () => {
    const element = boxed(0, 0, 10, 10)
    const release = register(element)
    const listener = vi.fn()
    const unwatch = watchOverlays(listener)

    element.style.transform = 'translate(40px, 80px)'
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(1)
    })
    element.className = 'leaving'
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledTimes(2)
    })
    // Other attributes don't move it.
    element.setAttribute('aria-label', 'Menu')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listener).toHaveBeenCalledTimes(2)
    element.dispatchEvent(new Event('animationend'))
    expect(listener).toHaveBeenCalledTimes(3)
    element.dispatchEvent(new Event('transitionend'))
    expect(listener).toHaveBeenCalledTimes(4)

    release()
    expect(listener).toHaveBeenCalledTimes(5)
    element.dispatchEvent(new Event('animationend'))
    element.dispatchEvent(new Event('transitionend'))
    element.style.transform = 'none'
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(listener).toHaveBeenCalledTimes(5)
    unwatch()
  })

  it('lets a listener stop watching while it’s being called, without skipping the others', () => {
    const second = vi.fn()
    let unwatchFirst = (): void => undefined
    const first = vi.fn(() => {
      unwatchFirst()
    })
    unwatchFirst = watchOverlays(first)
    const unwatchSecond = watchOverlays(second)
    register(boxed(0, 0, 10, 10))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    register(boxed(0, 0, 10, 10))
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(2)
    unwatchSecond()
  })
})

describe('useOverlayRef', () => {
  it('registers the element it’s given, swaps it for another, and lets it go when given null', () => {
    const { result } = renderHook(() => useOverlayRef())
    const ref = result.current
    const first = boxed(1300, 900, 100, 100)
    const second = boxed(20, 40, 100, 100)

    ref(first)
    expect(isCovered(SLOT)).toBe(true)
    ref(second)
    expect(isCovered(SLOT)).toBe(false)
    first.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0)
    second.getBoundingClientRect = () => new DOMRect(1300, 900, 100, 100)
    expect(isCovered(SLOT)).toBe(true)
    ref(null)
    expect(isCovered(SLOT)).toBe(false)
  })

  it('keeps the same callback across renders', () => {
    const { result, rerender } = renderHook(() => useOverlayRef())
    const ref = result.current
    rerender()
    expect(result.current).toBe(ref)
  })
})
