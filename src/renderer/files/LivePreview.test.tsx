import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { LivePreview } from './LivePreview'

/** A ResizeObserver a test can fire, standing in for jsdom's missing layout (mirrors `./HtmlPreview.test.tsx`). */
const observers: { callback: () => void; observed: Element[]; disconnected: boolean }[] = []
class TestResizeObserver {
  readonly entry: { callback: () => void; observed: Element[]; disconnected: boolean }
  constructor(callback: () => void) {
    this.entry = { callback, observed: [], disconnected: false }
    observers.push(this.entry)
  }
  observe(element: Element): void {
    this.entry.observed.push(element)
  }
  unobserve(): void {
    // Never called: the hook disconnects instead.
  }
  disconnect(): void {
    this.entry.disconnected = true
  }
}

/** Fires every observer watching the slot, as the page's layout would when the box it sits in resizes. */
function resizeSlot(): void {
  for (const observer of observers) {
    if (observer.observed.some((element) => element.getAttribute('data-testid') === 'live-preview-slot')) {
      observer.callback()
    }
  }
}

let slotBox = new DOMRect(10, 20, 300, 200)

beforeEach(() => {
  observers.length = 0
  slotBox = new DOMRect(10, 20, 300, 200)
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.dataset.testid === 'live-preview-slot' ? slotBox : new DOMRect()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const URL = 'http://localhost:3000/'

interface Rendered {
  readonly store: GladeStore
  readonly main: FakeMain
  readonly emit: ReturnType<typeof fakeBridge>['emit']
  readonly unmount: () => void
}

async function renderPreview(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const main: FakeMain = {
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1')],
    uiState: [],
  }
  const fake = fakeBridge(main, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const { unmount } = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <LivePreview taskId="t1" url={URL} />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await screen.findByTestId('live-preview-slot')
  return { store, main, emit: fake.emit, unmount }
}

describe('LivePreview', () => {
  it('places the view over its slot, and hides it on unmount', async () => {
    const { main, unmount } = await renderPreview()

    await waitFor(() => {
      expect(main.placedLivePreviews).toEqual([
        { taskId: 't1', url: URL, bounds: { x: 10, y: 20, width: 300, height: 200 } },
      ])
    })

    unmount()
    await waitFor(() => {
      expect(main.placedLivePreviews?.at(-1)).toEqual({ taskId: 't1', url: URL, bounds: null })
    })
  })

  it('shows a quiet notice naming the host once something is blocked, and clears it once told to', async () => {
    const { emit, store } = await renderPreview()
    expect(screen.queryByText(/blocked/)).not.toBeInTheDocument()

    act(() => {
      emit({ type: EventType.LivePreviewBlocked, taskId: 't1', path: URL, host: 'fonts.googleapis.com' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Some content was blocked: fonts.googleapis.com isn’t localhost.',
    )

    act(() => {
      store.getState().clearLivePreviewBlocked('t1', URL)
    })
    await waitFor(() => {
      expect(screen.queryByText(/blocked/)).not.toBeInTheDocument()
    })
  })

  it('keeps the notice through a later resize: placing the view again never clears it', async () => {
    const { main, emit } = await renderPreview()
    await waitFor(() => {
      expect(main.placedLivePreviews).toHaveLength(1)
    })

    act(() => {
      emit({ type: EventType.LivePreviewBlocked, taskId: 't1', path: URL, host: 'fonts.googleapis.com' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent('fonts.googleapis.com')

    slotBox = new DOMRect(10, 20, 400, 250)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    await waitFor(() => {
      expect(main.placedLivePreviews?.at(-1)).toEqual({
        taskId: 't1',
        url: URL,
        bounds: { x: 10, y: 20, width: 400, height: 250 },
      })
    })
    expect(screen.getByRole('status')).toHaveTextContent('fonts.googleapis.com')
  })

  it('sends the box’s new bounds when the box itself resizes', async () => {
    const { main } = await renderPreview()
    await waitFor(() => {
      expect(main.placedLivePreviews).toEqual([
        { taskId: 't1', url: URL, bounds: { x: 10, y: 20, width: 300, height: 200 } },
      ])
    })

    slotBox = new DOMRect(10, 20, 400, 250)
    act(() => {
      resizeSlot()
    })
    await waitFor(() => {
      expect(main.placedLivePreviews?.at(-1)).toEqual({
        taskId: 't1',
        url: URL,
        bounds: { x: 10, y: 20, width: 400, height: 250 },
      })
    })
  })

  it('shows a toast when placing the view fails', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'The preview went wrong')
    await renderPreview({ [CommandName.FilesPlaceLivePreview]: () => refuse(failure) })

    expect(await screen.findByText(/The preview went wrong/)).toBeInTheDocument()
  })
})
