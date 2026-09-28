import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../../shared/bridge'
import { refuse } from '../../store/test-bridge'
import { storeWrapper } from '../../store/test-wrapper'
import { COPIED_FEEDBACK_MS, CopyBlockButton } from './CodeCopy'

describe('CopyBlockButton', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('copies its text, shows Copied for about a second, then goes back to its icon', async () => {
    const copied: string[] = []
    const wrapper = storeWrapper({ copied })
    render(<CopyBlockButton getText={() => 'const limit = 60'} />, { wrapper: wrapper.wrapper })

    const button = screen.getByRole('button', { name: 'Copy code' })
    expect(button.querySelector('svg')).toHaveAttribute('data-icon', 'copy')

    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })

    expect(copied).toEqual(['const limit = 60'])
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copied' }).querySelector('svg')).toHaveAttribute('data-icon', 'check')
    expect(screen.getByRole('status')).toHaveTextContent('Copied')

    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS - 1)
    })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reads its text fresh at the moment it copies, not once at the first render', async () => {
    const copied: string[] = []
    let text = 'first'
    const wrapper = storeWrapper({ copied })
    render(<CopyBlockButton getText={() => text} />, { wrapper: wrapper.wrapper })

    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
      await Promise.resolve()
    })
    text = 'second'
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS)
    })
    await act(async () => {
      fireEvent.click(screen.getByRole('button'))
      await Promise.resolve()
    })

    expect(copied).toEqual(['first', 'second'])
  })

  it('restarts the feedback timer on a second copy before the first one clears it', async () => {
    const copied: string[] = []
    const wrapper = storeWrapper({ copied })
    render(<CopyBlockButton getText={() => 'x'} />, { wrapper: wrapper.wrapper })
    const button = screen.getByRole('button')

    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS - 1)
    })
    // A second copy just before the first's timeout: it keeps showing Copied, freshly timed from now.
    await act(async () => {
      fireEvent.click(button)
      await Promise.resolve()
    })
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(COPIED_FEEDBACK_MS - 1)
    })
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
    expect(copied).toEqual(['x', 'x'])
  })

  it('names what it copies, given a label', () => {
    const wrapper = storeWrapper({ copied: [] })
    render(<CopyBlockButton getText={() => 'x'} label="Copy command" />, { wrapper: wrapper.wrapper })

    expect(screen.getByRole('button', { name: 'Copy command' })).toBeInTheDocument()
  })

  it('shows a toast instead of Copied when the copy fails', async () => {
    const wrapper = storeWrapper(
      {},
      {
        [CommandName.ClipboardWriteText]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'No clipboard access')),
      },
    )
    render(<CopyBlockButton getText={() => 'x'} />, { wrapper: wrapper.wrapper })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy code' }))
      await Promise.resolve()
    })

    expect(screen.getByText('No clipboard access')).toBeInTheDocument()
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeInTheDocument()
  })
})
