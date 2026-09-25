import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { HandleEdge, ResizeHandle } from './ResizeHandle'

const BOUNDS = { min: 320, max: 800 }

function renderHandle(size = 440, edge = HandleEdge.Left) {
  const onResize = vi.fn()
  const onResizeEnd = vi.fn()
  const bounds = vi.fn(() => BOUNDS)
  const view = render(
    <ResizeHandle
      edge={edge}
      label="Resize panel"
      size={size}
      bounds={bounds}
      step={16}
      onResize={onResize}
      onResizeEnd={onResizeEnd}
    />,
  )
  return { handle: screen.getByRole('separator', { name: 'Resize panel' }), onResize, onResizeEnd, bounds, view }
}

let setPointerCapture: ReturnType<typeof vi.fn>

beforeEach(() => {
  // jsdom doesn't capture pointers.
  setPointerCapture = vi.fn()
  Element.prototype.setPointerCapture = setPointerCapture as unknown as Element['setPointerCapture']
})

describe('ResizeHandle', () => {
  it('is a focusable vertical separator carrying the width', () => {
    const { handle } = renderHandle()

    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', '440')
    expect(handle).toHaveAttribute('tabindex', '0')
  })

  it('widens the panel as you drag left and narrows it as you drag right, then keeps where you let go', () => {
    const { handle, onResize, onResizeEnd, bounds } = renderHandle()

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 1000 })
    expect(handle).toHaveAttribute('data-dragging', 'true')
    expect(setPointerCapture).toHaveBeenCalledWith(1)
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 950 })
    expect(onResize.mock.calls).toEqual([[540], [490]])
    expect(onResizeEnd).not.toHaveBeenCalled()

    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 950 })
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(490)
    expect(handle).toHaveAttribute('data-dragging', 'false')
    expect(bounds).toHaveBeenCalledOnce()

    // Once let go, the pointer moving on changes nothing.
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onResize).toHaveBeenCalledTimes(2)
    expect(onResizeEnd).toHaveBeenCalledOnce()
  })

  it('holds the drag within the bounds', () => {
    const { handle, onResize, onResizeEnd } = renderHandle()

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 1000 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 0 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 2000 })
    fireEvent.pointerCancel(handle, { pointerId: 1 })

    expect(onResize.mock.calls).toEqual([[800], [320]])
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(320)
  })

  it('starts from the width the bounds allow, when the stored width is wider', () => {
    const { handle, onResize } = renderHandle(1200)

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 1000 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 1010 })

    expect(onResize).toHaveBeenCalledExactlyOnceWith(790)
  })

  it('ends the drag when the pointer capture is lost, and ignores other buttons and pointers', () => {
    const { handle, onResize, onResizeEnd } = renderHandle()

    fireEvent.pointerDown(handle, { pointerId: 1, button: 2, clientX: 1000 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 900 })
    expect(onResize).not.toHaveBeenCalled()

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 1000 })
    fireEvent.pointerMove(handle, { pointerId: 2, clientX: 900 })
    fireEvent.pointerUp(handle, { pointerId: 2 })
    expect(onResize).not.toHaveBeenCalled()
    expect(onResizeEnd).not.toHaveBeenCalled()

    fireEvent.lostPointerCapture(handle, { pointerId: 1 })
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(440)
  })

  it('moves a step with ← and →, within the bounds, and ignores other keys', () => {
    const { handle, onResize, onResizeEnd, view } = renderHandle()

    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onResize).toHaveBeenLastCalledWith(456)
    expect(onResizeEnd).toHaveBeenLastCalledWith(456)
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(424)
    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(onResizeEnd).toHaveBeenCalledTimes(2)

    view.rerender(
      <ResizeHandle
        edge={HandleEdge.Left}
        label="Resize panel"
        size={320}
        bounds={() => BOUNDS}
        step={16}
        onResize={onResize}
        onResizeEnd={onResizeEnd}
      />,
    )
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(320)
  })

  it('on the sidebar’s right edge, widens the panel as you drag right, and with →', () => {
    const { handle, onResize, onResizeEnd } = renderHandle(440, HandleEdge.Right)
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('data-edge', 'right')

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 300, clientY: 500 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 400, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 250, clientY: 100 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: -1000, clientY: 100 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onResize.mock.calls).toEqual([[540], [390], [320]])
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(320)

    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(456)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(424)
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(onResizeEnd).toHaveBeenCalledTimes(3)
  })

  it('on the bottom bar’s top edge, makes the panel taller as you drag up, and with ↑; sideways moves change nothing', () => {
    const { handle, onResize, onResizeEnd } = renderHandle(440, HandleEdge.Top)
    expect(handle).toHaveAttribute('aria-orientation', 'horizontal')
    expect(handle).toHaveAttribute('data-edge', 'top')

    fireEvent.pointerDown(handle, { pointerId: 1, button: 0, clientX: 500, clientY: 800 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 800 })
    expect(onResize).not.toHaveBeenCalled()
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 700 })
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 100, clientY: 0 })
    fireEvent.pointerUp(handle, { pointerId: 1 })
    expect(onResize.mock.calls).toEqual([[540], [800]])
    expect(onResizeEnd).toHaveBeenCalledExactlyOnceWith(800)

    fireEvent.keyDown(handle, { key: 'ArrowUp' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(456)
    fireEvent.keyDown(handle, { key: 'ArrowDown' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(424)
    fireEvent.keyDown(handle, { key: 'ArrowLeft' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResizeEnd).toHaveBeenCalledTimes(3)
  })
})
