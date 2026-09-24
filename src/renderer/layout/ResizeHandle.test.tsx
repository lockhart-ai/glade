import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ResizeHandle } from './ResizeHandle'

const BOUNDS = { min: 320, max: 800 }

function renderHandle(width = 440) {
  const onResize = vi.fn()
  const onResizeEnd = vi.fn()
  const bounds = vi.fn(() => BOUNDS)
  const view = render(
    <ResizeHandle width={width} bounds={bounds} step={16} onResize={onResize} onResizeEnd={onResizeEnd} />,
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
      <ResizeHandle width={320} bounds={() => BOUNDS} step={16} onResize={onResize} onResizeEnd={onResizeEnd} />,
    )
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(onResizeEnd).toHaveBeenLastCalledWith(320)
  })
})
