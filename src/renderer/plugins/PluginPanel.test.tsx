import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { PluginStatus, type InstalledPlugin, type ValidPlugin } from '../../shared/plugins'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, type FakeBridge, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { PluginCard } from './PluginCard'
import { PluginPanel } from './PluginPanel'

const ICON = 'data:image/svg+xml;base64,PHN2Zy8+'

function validPlugin(id: string, name: string, overrides: Partial<ValidPlugin> = {}): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder: id,
    manifest: { id, name, version: '1.0.0', entry: 'index.html', icon: 'icon.svg' },
    iconUrl: ICON,
    enabled: true,
    ...overrides,
  }
}

const NEKOMATA = validPlugin('nekomata', 'Nekomata')
const POMODORO = validPlugin('pomodoro', 'Pomodoro', { iconUrl: null })

/** A ResizeObserver a test can fire, standing in for jsdom's missing layout. */
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
    // Nothing is ever unobserved: the hook disconnects instead.
  }
  disconnect(): void {
    this.entry.disconnected = true
  }
}

/** The slot's box, as the page would lay it out. */
let slotBox = { left: 700, top: 540, width: 680, height: 255 }

beforeEach(() => {
  observers.length = 0
  slotBox = { left: 700, top: 540, width: 680, height: 255 }
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== 'plugin-view-slot') return new DOMRect()
    return new DOMRect(slotBox.left, slotBox.top, slotBox.width, slotBox.height)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
  readonly rerender: (props: { collapsed: boolean; moving: boolean }) => void
}

async function renderPanel(
  plugins: InstalledPlugin[] | undefined,
  { collapsed = false, moving = false } = {},
  overrides: Partial<FakeHandlers> = {},
  extra: Partial<FakeMain> = {},
): Promise<Rendered> {
  const main: FakeMain = {
    workspaces: [],
    tasks: [],
    uiState: [],
    ...(plugins === undefined ? {} : { plugins }),
    ...extra,
  }
  const fake = fakeBridge(main, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const tree = (props: { collapsed: boolean; moving: boolean }): React.JSX.Element => (
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <PluginPanel {...props} />
      </ToastProvider>
    </GladeStoreProvider>
  )
  const { rerender } = render(tree({ collapsed, moving }))
  return {
    ...fake,
    store,
    main,
    rerender: (props) => {
      rerender(tree(props))
    },
  }
}

function placed(main: FakeMain): unknown[] {
  return (main.placedPluginViews ?? []).map(({ bounds }) => bounds)
}

const BOUNDS = { x: 700, y: 540, width: 680, height: 255 }

describe('PluginPanel', () => {
  it('reads the plugins folder, and shows the first enabled plugin by id with its view over the card', async () => {
    const { invoke, main } = await renderPanel([
      POMODORO,
      NEKOMATA,
      validPlugin('abacus', 'Abacus', { enabled: false }),
    ])

    const card = await screen.findByRole('region', { name: 'Nekomata' })
    expect(invoke).toHaveBeenCalledWith(CommandName.PluginsList, {})
    expect(card).toHaveTextContent('NekomataPlugin')
    await waitFor(() => {
      expect(main.placedPluginViews).toEqual([{ id: 'nekomata', bounds: BOUNDS }])
    })
  })

  it('shows nothing with no enabled plugin, leaving the terminal the whole bar', async () => {
    const { main } = await renderPanel([validPlugin('abacus', 'Abacus', { enabled: false })])

    await waitFor(() => {
      expect(main.plugins).toBeDefined()
    })
    expect(screen.queryByTestId('plugin-card')).toBeNull()
    expect(main.placedPluginViews).toBeUndefined()
  })

  it('shows nothing with no plugins at all', async () => {
    await renderPanel(undefined)

    expect(screen.queryByTestId('plugin-card')).toBeNull()
  })

  it('shows the status the plugin sets, and a new one as it changes', async () => {
    const { emit } = await renderPanel([NEKOMATA])
    await screen.findByRole('region', { name: 'Nekomata' })
    expect(screen.queryByTestId('plugin-status')).toBeNull()

    act(() => {
      emit({ type: EventType.PluginStatusChanged, id: 'nekomata', text: '5 cats · 4 kittens' })
    })
    expect(screen.getByTestId('plugin-status')).toHaveTextContent('5 cats · 4 kittens')

    act(() => {
      emit({ type: EventType.PluginStatusChanged, id: 'other', text: 'not mine' })
      emit({ type: EventType.PluginStatusChanged, id: 'nekomata', text: '' })
    })
    expect(screen.queryByTestId('plugin-status')).toBeNull()
  })

  it('shows the status main answers with when the view is placed', async () => {
    await renderPanel([NEKOMATA], {}, {}, { pluginStatuses: { nekomata: 'hello again' } })

    expect(await screen.findByTestId('plugin-status')).toHaveTextContent('hello again')
  })

  it('follows the slot as the window resizes or the slot does, telling main only of a change', async () => {
    const { main } = await renderPanel([NEKOMATA])
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS])
    })

    act(() => {
      window.dispatchEvent(new Event('resize'))
    })
    slotBox = { left: 500, top: 440, width: 680, height: 355 }
    act(() => {
      observers.at(-1)?.callback()
    })
    slotBox = { left: 300, top: 440, width: 680, height: 355 }
    act(() => {
      window.dispatchEvent(new Event('resize'))
    })

    await waitFor(() => {
      expect(placed(main)).toEqual([
        BOUNDS,
        { x: 500, y: 440, width: 680, height: 355 },
        { x: 300, y: 440, width: 680, height: 355 },
      ])
    })
    expect(observers.at(-1)?.observed).toEqual([screen.getByTestId('plugin-view-slot')])
  })

  it('hides the view while the bar slides or is collapsed, showing only the header, and places it again after', async () => {
    const { main, rerender } = await renderPanel([NEKOMATA])
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS])
    })

    rerender({ collapsed: false, moving: true })
    rerender({ collapsed: true, moving: false })
    expect(screen.getByTestId('plugin-view-slot')).not.toBeVisible()
    rerender({ collapsed: false, moving: true })
    rerender({ collapsed: false, moving: false })

    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS, null, BOUNDS])
    })
    expect(observers.slice(0, -1).every(({ disconnected }) => disconnected)).toBe(true)
  })

  it('hides the view as the card goes when the plugin is turned off, ignoring that main already destroyed it', async () => {
    const { main, emit, store } = await renderPanel([NEKOMATA])
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS])
    })
    main.plugins = [{ ...NEKOMATA, enabled: false }]

    act(() => {
      emit({ type: EventType.PluginsChanged, plugins: [{ ...NEKOMATA, enabled: false }] })
    })

    expect(screen.queryByTestId('plugin-card')).toBeNull()
    expect(store.getState().plugins).toEqual([{ ...NEKOMATA, enabled: false }])
  })

  it('says why when the view could not be placed for any other reason', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'The view went wrong')
    await renderPanel([NEKOMATA], {}, { [CommandName.PluginsPlaceView]: () => refuse(failure) })

    expect(await screen.findByText(/The view went wrong/)).toBeInTheDocument()
  })
})

describe('PluginCard', () => {
  it("shows the plugin's icon, or a puzzle piece when it has none", () => {
    const { rerender, container } = render(<PluginCard plugin={NEKOMATA} status="" showing place={vi.fn()} />)
    expect(container.querySelector('img')).toHaveAttribute('src', ICON)

    rerender(<PluginCard plugin={POMODORO} status="" showing place={vi.fn()} />)
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('svg')).not.toBeNull()
  })

  it('shows the status, with its dot', () => {
    render(<PluginCard plugin={NEKOMATA} status="5 cats · 4 kittens" showing place={vi.fn()} />)

    expect(screen.getByTestId('plugin-status')).toHaveTextContent('5 cats · 4 kittens')
  })

  it("doesn't place the view while it isn't showing", () => {
    const place = vi.fn()
    const { unmount } = render(<PluginCard plugin={NEKOMATA} status="" showing={false} place={place} />)
    unmount()

    expect(place).not.toHaveBeenCalled()
  })

  it('hides the view when it goes', () => {
    const place = vi.fn()
    const { unmount } = render(<PluginCard plugin={NEKOMATA} status="" showing place={place} />)

    unmount()

    expect(place.mock.calls).toEqual([[BOUNDS], [null]])
  })
})
