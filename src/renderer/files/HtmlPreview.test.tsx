import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { HtmlPreview } from './HtmlPreview'

/** A ResizeObserver a test can fire, standing in for jsdom's missing layout (mirrors `../plugins/PluginPanel.test.tsx`). */
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
    if (observer.observed.some((element) => element.getAttribute('data-testid') === 'html-preview-slot')) {
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
    return this.dataset.testid === 'html-preview-slot' ? slotBox : new DOMRect()
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface Rendered {
  readonly store: GladeStore
  readonly main: FakeMain
  readonly emit: ReturnType<typeof fakeBridge>['emit']
  readonly rerender: (version: string | undefined) => void
  readonly unmount: () => void
}

async function renderPreview(
  version: string | undefined = 'v1',
  overrides: Partial<FakeHandlers> = {},
): Promise<Rendered> {
  const main: FakeMain = {
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1')],
    uiState: [],
  }
  const fake = fakeBridge(main, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const tree = (v: string | undefined): React.JSX.Element => (
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <HtmlPreview taskId="t1" path="report.html" version={v} />
      </ToastProvider>
    </GladeStoreProvider>
  )
  const { rerender, unmount } = render(tree(version))
  await screen.findByTestId('html-preview-slot')
  return {
    store,
    main,
    emit: fake.emit,
    rerender: (v) => {
      rerender(tree(v))
    },
    unmount,
  }
}

describe('HtmlPreview', () => {
  it('places the view over its slot, hides it on unmount, and reloads it when the file’s version changes', async () => {
    const { main, unmount, rerender } = await renderPreview('v1')

    await waitFor(() => {
      expect(main.placedHtmlPreviews).toEqual([
        { taskId: 't1', path: 'report.html', bounds: { x: 10, y: 20, width: 300, height: 200 } },
      ])
    })

    rerender('v1')
    expect(main.reloadedHtmlPreviews ?? []).toHaveLength(0)

    rerender('v2')
    await waitFor(() => {
      expect(main.reloadedHtmlPreviews).toEqual([{ taskId: 't1', path: 'report.html' }])
    })

    unmount()
    await waitFor(() => {
      expect(main.placedHtmlPreviews?.at(-1)).toEqual({ taskId: 't1', path: 'report.html', bounds: null })
    })
  })

  it('shows a quiet notice once something is blocked, and clears it on the next reload', async () => {
    const { emit, rerender } = await renderPreview('v1')
    expect(screen.queryByText(/this preview is offline/)).not.toBeInTheDocument()

    act(() => {
      emit({ type: EventType.HtmlPreviewBlocked, taskId: 't1', path: 'report.html' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Some content was blocked: this preview is offline.')

    rerender('v2')
    await waitFor(() => {
      expect(screen.queryByText(/this preview is offline/)).not.toBeInTheDocument()
    })
  })

  it('keeps the notice through a later resize: placing the view again never clears it', async () => {
    const { main, emit } = await renderPreview('v1')
    await waitFor(() => {
      expect(main.placedHtmlPreviews).toHaveLength(1)
    })

    act(() => {
      emit({ type: EventType.HtmlPreviewBlocked, taskId: 't1', path: 'report.html' })
    })
    expect(await screen.findByRole('status')).toHaveTextContent('Some content was blocked: this preview is offline.')

    // A resize places the view again, at a new box: the notice (a block, not this file's version) stays.
    slotBox = new DOMRect(10, 20, 400, 250)
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    await waitFor(() => {
      expect(main.placedHtmlPreviews?.at(-1)).toEqual({
        taskId: 't1',
        path: 'report.html',
        bounds: { x: 10, y: 20, width: 400, height: 250 },
      })
    })
    expect(screen.getByRole('status')).toHaveTextContent('Some content was blocked: this preview is offline.')
  })

  it('sends the box’s new bounds when the box itself resizes, as the panel around it narrows or the bottom panel opens', async () => {
    const { main } = await renderPreview('v1')
    await waitFor(() => {
      expect(main.placedHtmlPreviews).toEqual([
        { taskId: 't1', path: 'report.html', bounds: { x: 10, y: 20, width: 300, height: 200 } },
      ])
    })

    // The layout around the viewer moves (the right panel's splitter, the bottom panel opening): the slot's box
    // resizes without the window doing so, and the bounds sent follow it.
    slotBox = new DOMRect(10, 20, 400, 250)
    act(() => {
      resizeSlot()
    })
    await waitFor(() => {
      expect(main.placedHtmlPreviews?.at(-1)).toEqual({
        taskId: 't1',
        path: 'report.html',
        bounds: { x: 10, y: 20, width: 400, height: 250 },
      })
    })
  })

  it('shows a toast when placing the view fails', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'The preview went wrong')
    await renderPreview('v1', { [CommandName.FilesPlaceHtmlPreview]: () => refuse(failure) })

    expect(await screen.findByText(/The preview went wrong/)).toBeInTheDocument()
  })

  it('shows a toast when reloading the view fails', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'The reload went wrong')
    const { rerender } = await renderPreview('v1', { [CommandName.FilesReloadHtmlPreview]: () => refuse(failure) })

    rerender('v2')

    expect(await screen.findByText(/The reload went wrong/)).toBeInTheDocument()
  })
})
