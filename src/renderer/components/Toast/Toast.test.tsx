import { faCheck } from '@fortawesome/free-solid-svg-icons'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MOTION_DURATION_PROPERTY } from '../../motion'
import { moduleClass } from '../moduleClass'
import { DEFAULT_TOAST_TIMEOUT, ToastAnchor, ToastProvider, useToast, type ToastApi } from './Toast'
import styles from './Toast.module.css'

const cls = (name: string): string => moduleClass(styles, name)

/** Renders a provider and hands back its API. */
function renderProvider(): ToastApi {
  let api: ToastApi | undefined
  function Capture(): React.JSX.Element {
    api = useToast()
    return <p>App</p>
  }
  render(
    <ToastProvider className="extra">
      <Capture />
    </ToastProvider>,
  )
  if (api === undefined) throw new Error('No toast API')
  return api
}

function region(): HTMLElement {
  return screen.getByRole('region', { name: 'Notifications' })
}

describe('Toast', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('renders its children and an empty, polite toast region', () => {
    renderProvider()

    expect(screen.getByText('App')).toBeInTheDocument()
    expect(region()).toHaveClass(cls('region'), 'extra')
    expect(region()).toHaveAttribute('aria-live', 'polite')
    expect(region()).toBeEmptyDOMElement()
  })

  it('shows a toast with an icon and an action', () => {
    const api = renderProvider()
    act(() => {
      api.show({ message: 'Marked done.', icon: faCheck, action: { label: 'Undo', onAction: vi.fn() } })
    })
    const toast = within(region()).getByText('Marked done.').parentElement

    expect(toast).toHaveClass(cls('toast'))
    expect(toast?.querySelector('svg')).toHaveAttribute('data-icon', 'check')
    expect(within(region()).getByRole('button', { name: 'Undo' })).toBeInTheDocument()
  })

  it('shows a plain toast with no icon or action', () => {
    const api = renderProvider()
    act(() => {
      api.show({ message: 'Copied.' })
    })

    expect(within(region()).getByText('Copied.').parentElement?.querySelector('svg')).toBeNull()
    expect(within(region()).queryByRole('button')).toBeNull()
  })

  it('dismisses itself after the default timeout', () => {
    const api = renderProvider()
    act(() => {
      api.show({ message: 'Copied.' })
    })

    act(() => {
      vi.advanceTimersByTime(DEFAULT_TOAST_TIMEOUT - 1)
    })
    expect(screen.getByText('Copied.')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.queryByText('Copied.')).toBeNull()
  })

  it('takes its own timeout, and times each toast separately', () => {
    const api = renderProvider()
    act(() => {
      api.show({ message: 'First', timeout: 1000 })
      api.show({ message: 'Second', timeout: 3000 })
    })

    expect(
      within(region())
        .getAllByText(/First|Second/)
        .map((node) => node.textContent),
    ).toEqual(['First', 'Second'])
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(screen.queryByText('First')).toBeNull()
    expect(screen.getByText('Second')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.queryByText('Second')).toBeNull()
  })

  it('runs the action and dismisses the toast when the action is chosen', () => {
    const api = renderProvider()
    const onAction = vi.fn()
    act(() => {
      api.show({ message: 'Marked done.', action: { label: 'Undo', onAction } })
    })
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

    expect(onAction).toHaveBeenCalledOnce()
    expect(screen.queryByText('Marked done.')).toBeNull()
  })

  it('dismisses a toast by id', () => {
    const api = renderProvider()
    let id = 0
    act(() => {
      id = api.show({ message: 'First' })
      api.show({ message: 'Second' })
    })
    act(() => {
      api.dismiss(id)
    })

    expect(screen.queryByText('First')).toBeNull()
    expect(screen.getByText('Second')).toBeInTheDocument()
  })

  it('sits at the bottom of the window while no anchor is mounted', () => {
    renderProvider()

    expect(region().parentElement).toBe(document.body)
    expect(region()).toHaveClass(cls('window'))
  })

  it('moves to the latest mounted anchor, and back as anchors unmount', () => {
    let api: ToastApi | undefined
    function Capture(): null {
      api = useToast()
      return null
    }
    function Anchors({ count }: { readonly count: number }): React.JSX.Element {
      return (
        <ToastProvider>
          <Capture />
          <div data-testid="first">
            <ToastAnchor className="above-input" />
          </div>
          {count > 1 && (
            <div data-testid="second">
              <ToastAnchor />
            </div>
          )}
        </ToastProvider>
      )
    }
    const { rerender } = render(<Anchors count={2} />)
    act(() => {
      api?.show({ message: 'Copied.' })
    })

    const second = within(screen.getByTestId('second')).getByTestId('toast-anchor')
    expect(second).toHaveClass(cls('anchor'))
    expect(region().parentElement).toBe(second)
    expect(region()).toHaveClass(cls('anchored'))
    expect(region()).toHaveTextContent('Copied.')

    rerender(<Anchors count={1} />)
    const first = within(screen.getByTestId('first')).getByTestId('toast-anchor')
    expect(first).toHaveClass(cls('anchor'), 'above-input')
    expect(region().parentElement).toBe(first)
    expect(region()).toHaveTextContent('Copied.')
  })

  describe('with motion on', () => {
    beforeEach(() => {
      document.documentElement.style.setProperty(MOTION_DURATION_PROPERTY, '200ms')
    })

    afterEach(() => {
      document.documentElement.style.removeProperty(MOTION_DURATION_PROPERTY)
    })

    it('rises in, and fades out when dismissed, inert, before it goes', () => {
      const api = renderProvider()
      let id = 0
      act(() => {
        id = api.show({ message: 'Copied.' })
      })
      const toast = screen.getByText('Copied.').parentElement
      expect(toast).toHaveClass(cls('toast'))
      expect(toast).not.toHaveClass(cls('leaving'))

      act(() => {
        api.dismiss(id)
      })
      expect(toast).toHaveClass(cls('leaving'))
      expect(toast).toHaveAttribute('inert')
      act(() => {
        vi.advanceTimersByTime(199)
      })
      expect(screen.getByText('Copied.')).toBeInTheDocument()
      act(() => {
        vi.advanceTimersByTime(1)
      })
      expect(screen.queryByText('Copied.')).toBeNull()
    })

    it('fades out on its own timeout too, leaving the others', () => {
      const api = renderProvider()
      act(() => {
        api.show({ message: 'First', timeout: 1000 })
        api.show({ message: 'Second', timeout: 5000 })
      })
      act(() => {
        vi.advanceTimersByTime(1000)
      })
      expect(screen.getByText('First').parentElement).toHaveClass(cls('leaving'))
      expect(screen.getByText('Second').parentElement).not.toHaveClass(cls('leaving'))
      act(() => {
        vi.advanceTimersByTime(200)
      })
      expect(screen.queryByText('First')).toBeNull()
      expect(screen.getByText('Second')).toBeInTheDocument()
    })

    it('forgets a fading toast if the provider goes first', () => {
      let api: ToastApi | undefined
      function Capture(): null {
        api = useToast()
        return null
      }
      const { unmount } = render(
        <ToastProvider>
          <Capture />
        </ToastProvider>,
      )
      act(() => {
        const id = api?.show({ message: 'Copied.' }) ?? 0
        api?.dismiss(id)
      })
      unmount()
      expect(vi.getTimerCount()).toBe(0)
    })
  })

  it('refuses an anchor outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => render(<ToastAnchor />)).toThrow('ToastAnchor must be used inside a ToastProvider')
  })

  it('refuses to work outside a provider', () => {
    function Orphan(): React.JSX.Element {
      useToast()
      return <p />
    }
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect(() => render(<Orphan />)).toThrow('useToast must be used inside a ToastProvider')
  })
})
