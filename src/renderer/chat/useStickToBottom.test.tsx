import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAtBottom, STICK_THRESHOLD, useStickToBottom } from './useStickToBottom'

describe('isAtBottom', () => {
  it('is true at the bottom, or within the threshold of it', () => {
    expect(isAtBottom({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(isAtBottom({ scrollTop: 600 - STICK_THRESHOLD, scrollHeight: 1000, clientHeight: 400 })).toBe(true)
    expect(isAtBottom({ scrollTop: 599 - STICK_THRESHOLD, scrollHeight: 1000, clientHeight: 400 })).toBe(false)
    expect(isAtBottom({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true)
    expect(isAtBottom({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 }, 0)).toBe(false)
  })
})

interface ScrollerProps {
  readonly content: string
  readonly resetKey: string
}

function Scroller({ content, resetKey }: ScrollerProps): React.JSX.Element {
  const { ref, onScroll } = useStickToBottom(content, resetKey)
  return (
    <div ref={ref} onScroll={onScroll} data-testid="scroller">
      {content}
    </div>
  )
}

/** The scroller's viewport height, from when it first renders (jsdom doesn't lay out). */
const VIEWPORT = 400

/** jsdom doesn't lay out; give the scroller a content height to scroll through. */
function layOut(scroller: HTMLElement, scrollHeight: number): void {
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight })
}

function scrollTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top
  fireEvent.scroll(scroller)
}

describe('useStickToBottom', () => {
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(VIEWPORT)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('scrolls to the bottom as content arrives while at the bottom', () => {
    const { rerender } = render(<Scroller content="a" resetKey="t1" />)
    const scroller = screen.getByTestId('scroller')
    layOut(scroller, 1000)

    rerender(<Scroller content="ab" resetKey="t1" />)

    expect(scroller.scrollTop).toBe(1000)
  })

  it('stays put once the user has scrolled up, and sticks again at the bottom', () => {
    const { rerender } = render(<Scroller content="a" resetKey="t1" />)
    const scroller = screen.getByTestId('scroller')
    layOut(scroller, 1000)
    scrollTo(scroller, 100)

    layOut(scroller, 1200)
    rerender(<Scroller content="ab" resetKey="t1" />)
    expect(scroller.scrollTop).toBe(100)

    scrollTo(scroller, 800)
    layOut(scroller, 1400)
    rerender(<Scroller content="abc" resetKey="t1" />)
    expect(scroller.scrollTop).toBe(1400)
  })

  it('sticks to the bottom again for a new reset key', () => {
    const { rerender } = render(<Scroller content="a" resetKey="t1" />)
    const scroller = screen.getByTestId('scroller')
    layOut(scroller, 1000)
    scrollTo(scroller, 100)

    rerender(<Scroller content="a" resetKey="t2" />)

    expect(scroller.scrollTop).toBe(1000)
  })

  describe('as the scroller resizes', () => {
    /** The observers the hook made, and the elements each watches. */
    const observers: { readonly resize: () => void; readonly watched: Element[]; disconnected: boolean }[] = []

    class FakeResizeObserver {
      private readonly entry: (typeof observers)[number]
      constructor(callback: () => void) {
        this.entry = { resize: callback, watched: [], disconnected: false }
        observers.push(this.entry)
      }
      observe(element: Element): void {
        this.entry.watched.push(element)
      }
      unobserve = (): void => undefined
      disconnect(): void {
        this.entry.disconnected = true
      }
    }

    afterEach(() => {
      observers.length = 0
      vi.unstubAllGlobals()
    })

    it('keeps the bottom in view when the scroller shrinks while at the bottom', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      render(<Scroller content="a" resetKey="t1" />)
      const scroller = screen.getByTestId('scroller')
      expect(observers).toHaveLength(1)
      expect(observers[0]?.watched).toEqual([scroller])

      // The window gets shorter: the same content in a smaller viewport.
      layOut(scroller, 1000)
      observers[0]?.resize()

      expect(scroller.scrollTop).toBe(1000)
    })

    it('leaves the scroll alone on a resize once the user has scrolled up', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      render(<Scroller content="a" resetKey="t1" />)
      const scroller = screen.getByTestId('scroller')
      layOut(scroller, 1000)
      scrollTo(scroller, 100)

      observers[0]?.resize()

      expect(scroller.scrollTop).toBe(100)
    })

    it('stays stuck when a scroll event arrives after a resize the observer has yet to report', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      render(<Scroller content="a" resetKey="t1" />)
      const scroller = screen.getByTestId('scroller')
      layOut(scroller, 1000)
      observers[0]?.resize()
      expect(scroller.scrollTop).toBe(1000)

      // The window shrinks before the event for that scroll to the bottom is dispatched: the event finds the old
      // scroll position short of the new bottom, but it's layout moving, not the user scrolling up.
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1500 })
      scrollTo(scroller, 600)
      expect(scroller.scrollTop).toBe(1500)

      // Once the observer has seen the new size, scrolling up unsticks it as usual.
      observers[0]?.resize()
      scrollTo(scroller, 200)
      layOut(scroller, 1600)
      observers[0]?.resize()
      expect(scroller.scrollTop).toBe(200)
    })

    it("stays stuck when the window shrinks before the observer's first report", () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      const { rerender } = render(<Scroller content="a" resetKey="t1" />)
      const scroller = screen.getByTestId('scroller')
      layOut(scroller, 1000)
      rerender(<Scroller content="ab" resetKey="t1" />)
      expect(scroller.scrollTop).toBe(1000)

      // The window shrinks straight after the chat renders, as the narrow-window spec's does, and the scroll the
      // shrink causes is dispatched before the observer has reported any size: it's layout moving, not the user.
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 100 })
      layOut(scroller, 1500)
      scrollTo(scroller, 600)
      expect(scroller.scrollTop).toBe(1500)

      observers[0]?.resize()
      expect(scroller.scrollTop).toBe(1500)
    })

    it('stops watching when it unmounts', () => {
      vi.stubGlobal('ResizeObserver', FakeResizeObserver)
      const { unmount } = render(<Scroller content="a" resetKey="t1" />)

      unmount()

      expect(observers[0]?.disconnected).toBe(true)
    })
  })
})
