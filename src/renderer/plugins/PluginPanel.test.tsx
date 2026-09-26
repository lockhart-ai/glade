import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import { PluginStatus, type InstalledPlugin, type ValidPlugin } from '../../shared/plugins'
import { serializeRelaunchNotice } from '../../shared/relaunchNotice'
import {
  ConfirmDialog,
  Menu,
  MenuAnchorKind,
  MenuEntryKind,
  Popover,
  ToastProvider,
  useToast,
  type ToastApi,
} from '../components'
import { DEFAULT_PLUGIN_WIDTH, MIN_PLUGIN_WIDTH, MIN_TERMINAL_WIDTH, RESIZE_STEP } from '../panels/panelSize'
import { RelaunchNotice } from '../relaunch-notice/RelaunchNotice'
import { SettingsDialog } from '../settings/SettingsDialog'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from '../store/test-bridge'
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

/** Every other element's box: none, unless a test lays its overlays out somewhere. */
let otherBox = new DOMRect()

beforeEach(() => {
  observers.length = 0
  slotBox = { left: 700, top: 540, width: 680, height: 255 }
  otherBox = new DOMRect()
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.dataset.testid !== 'plugin-view-slot') return otherBox
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

/** The bottom bar the card sits in, as wide as the design's window makes it, with the gap beside the terminal. */
const BAR_WIDTH = 1904
const GAP = 8

/** Lays the card's slot out in a bar this wide: its parent is the bar. */
function layOutBar(width = BAR_WIDTH): void {
  const bar = screen.getByTestId('plugin-slot').parentElement
  if (bar === null) throw new Error('The slot is not in a bar')
  Object.defineProperty(bar, 'clientWidth', { configurable: true, value: width })
  bar.style.columnGap = `${String(GAP)}px`
}

function widthEntry(value: string): UiStateEntry {
  return { key: UiStateKey.PluginWidth, value }
}

/** The card's width as its slot sets it. */
function shownWidth(): string {
  return screen.getByTestId('plugin-slot').style.getPropertyValue('--plugin-width')
}

function handle(): HTMLElement {
  return screen.getByRole('separator', { name: 'Resize plugin panel' })
}

function storedWidth(store: GladeStore): string | undefined {
  return store.getState().uiState[UiStateKey.PluginWidth]
}

describe('PluginPanel split', () => {
  beforeEach(() => {
    Element.prototype.setPointerCapture = vi.fn()
  })

  it('starts at the design’s width, with the limits the stylesheet caps it to', async () => {
    await renderPanel([NEKOMATA])
    await screen.findByRole('region', { name: 'Nekomata' })

    const slot = screen.getByTestId('plugin-slot')
    expect(shownWidth()).toBe(`${String(DEFAULT_PLUGIN_WIDTH)}px`)
    expect(slot.style.getPropertyValue('--plugin-min-width')).toBe(`${String(MIN_PLUGIN_WIDTH)}px`)
    expect(slot.style.getPropertyValue('--terminal-min-width')).toBe(`${String(MIN_TERMINAL_WIDTH)}px`)
    expect(handle()).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle()).toHaveAttribute('aria-valuenow', String(DEFAULT_PLUGIN_WIDTH))
  })

  it.each([
    ['the width you left it at', '520', '520px'],
    ['the minimum, for a width below it', '100', `${String(MIN_PLUGIN_WIDTH)}px`],
    ['the design’s width, for a width that isn’t a number', 'wide', `${String(DEFAULT_PLUGIN_WIDTH)}px`],
    ['a width too big for any window, which the stylesheet caps', '9000', '9000px'],
  ])('opens at %s', async (_, stored, shown) => {
    await renderPanel([NEKOMATA], {}, {}, { uiState: [widthEntry(stored)] })
    await screen.findByRole('region', { name: 'Nekomata' })

    expect(shownWidth()).toBe(shown)
  })

  it('shows each width as you drag without keeping it, keeps the one you let go at, and the view follows', async () => {
    const { store, main } = await renderPanel([NEKOMATA])
    await screen.findByRole('region', { name: 'Nekomata' })
    layOutBar()

    fireEvent.pointerDown(handle(), { pointerId: 1, button: 0, clientX: 1200 })
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1100 })
    expect(shownWidth()).toBe('780px')
    expect(storedWidth(store)).toBeUndefined()
    // The slot resized under the view, which follows it.
    slotBox = { left: 600, top: 540, width: 780, height: 255 }
    act(() => {
      observers.at(-1)?.callback()
    })
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: 1000 })
    fireEvent.pointerUp(handle(), { pointerId: 1, clientX: 1000 })

    await waitFor(() => {
      expect(storedWidth(store)).toBe('880')
    })
    expect(shownWidth()).toBe('880px')
    expect(main.uiState).toContainEqual(widthEntry('880'))
    expect(placed(main)).toContainEqual({ x: 600, y: 540, width: 780, height: 255 })
  })

  it('stops at both extremes: the terminal keeps its minimum, and the card its own', async () => {
    const { store } = await renderPanel([NEKOMATA])
    await screen.findByRole('region', { name: 'Nekomata' })
    layOutBar()
    const widest = BAR_WIDTH - GAP - MIN_TERMINAL_WIDTH

    fireEvent.pointerDown(handle(), { pointerId: 1, button: 0, clientX: 1200 })
    fireEvent.pointerMove(handle(), { pointerId: 1, clientX: -5000 })
    fireEvent.pointerUp(handle(), { pointerId: 1 })
    await waitFor(() => {
      expect(storedWidth(store)).toBe(String(widest))
    })

    fireEvent.pointerDown(handle(), { pointerId: 2, button: 0, clientX: 400 })
    fireEvent.pointerMove(handle(), { pointerId: 2, clientX: 5000 })
    fireEvent.pointerUp(handle(), { pointerId: 2 })
    await waitFor(() => {
      expect(storedWidth(store)).toBe(String(MIN_PLUGIN_WIDTH))
    })
  })

  it('steps with ← and →, within its limits, from the width a smaller window holds it to', async () => {
    const { store } = await renderPanel([NEKOMATA], {}, {}, { uiState: [widthEntry('1500')] })
    await screen.findByRole('region', { name: 'Nekomata' })
    // The window at its minimum: 1100 less the outer padding.
    layOutBar(1084)
    const widest = 1084 - GAP - MIN_TERMINAL_WIDTH

    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })
    await waitFor(() => {
      expect(storedWidth(store)).toBe(String(widest))
    })
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    await waitFor(() => {
      expect(storedWidth(store)).toBe(String(widest - RESIZE_STEP))
    })
    fireEvent.keyDown(handle(), { key: 'ArrowUp' })
    expect(storedWidth(store)).toBe(String(widest - RESIZE_STEP))

    await act(() => store.getState().setUiState(widthEntry(String(MIN_PLUGIN_WIDTH + 4))))
    expect(shownWidth()).toBe(`${String(MIN_PLUGIN_WIDTH + 4)}px`)
    fireEvent.keyDown(handle(), { key: 'ArrowRight' })
    await waitFor(() => {
      expect(storedWidth(store)).toBe(String(MIN_PLUGIN_WIDTH))
    })
  })

  it('has only the card’s minimum to go on when it isn’t in a bar', async () => {
    const { store } = await renderPanel([NEKOMATA])
    await screen.findByRole('region', { name: 'Nekomata' })
    // Out of the page (it's being torn down), it has no bar to measure.
    vi.spyOn(screen.getByTestId('plugin-slot'), 'parentElement', 'get').mockReturnValue(null)

    fireEvent.keyDown(handle(), { key: 'ArrowLeft' })

    await waitFor(() => {
      expect(storedWidth(store)).toBe(String(MIN_PLUGIN_WIDTH))
    })
  })

  it('has no handle while the bar is collapsed or sliding, and keeps its width for when it opens', async () => {
    const { rerender } = await renderPanel([NEKOMATA], {}, {}, { uiState: [widthEntry('520')] })
    await screen.findByRole('region', { name: 'Nekomata' })

    rerender({ collapsed: false, moving: true })
    expect(screen.queryByRole('separator')).toBeNull()
    rerender({ collapsed: true, moving: false })
    expect(screen.queryByRole('separator')).toBeNull()
    expect(shownWidth()).toBe('520px')
    rerender({ collapsed: false, moving: false })
    expect(handle()).toBeInTheDocument()
    expect(shownWidth()).toBe('520px')
  })

  it('keeps its width while the plugin is off, and comes back at it when it’s on again', async () => {
    const { emit, main } = await renderPanel([NEKOMATA], {}, {}, { uiState: [widthEntry('520')] })
    await screen.findByRole('region', { name: 'Nekomata' })

    act(() => {
      emit({ type: EventType.PluginsChanged, plugins: [{ ...NEKOMATA, enabled: false }] })
    })
    expect(screen.queryByTestId('plugin-slot')).toBeNull()
    expect(screen.queryByRole('separator')).toBeNull()
    expect(main.uiState).toContainEqual(widthEntry('520'))

    act(() => {
      emit({ type: EventType.PluginsChanged, plugins: [NEKOMATA] })
    })
    await screen.findByRole('region', { name: 'Nekomata' })
    expect(shownWidth()).toBe('520px')
  })
})

/** Hands out the toast API from inside a `ToastProvider`. */
function Toaster({ onApi }: { onApi: (api: ToastApi) => void }): null {
  const api = useToast()
  useEffect(() => {
    onApi(api)
  }, [api, onApi])
  return null
}

/** Closes an overlay a test opened. */
type CloseOverlay = () => Promise<void>

/** An overlay a test opens over the card (or away from it), and how it closes again. */
interface OverlayCase {
  readonly name: string
  readonly open: (store: GladeStore) => Promise<CloseOverlay>
}

/** Every kind of overlay the page has: each registers itself, so the card's view hides while it's over the card. */
const OVERLAYS: readonly OverlayCase[] = [
  {
    // The task, terminal tab and other context menus, and the workspace switcher, are all a Menu.
    name: 'a context menu',
    open: async () => {
      const menu = (open: boolean): React.JSX.Element => (
        <Menu
          label="Terminal tab actions"
          entries={[{ kind: MenuEntryKind.Item, label: 'Rename…', onSelect: vi.fn() }]}
          anchor={{ kind: MenuAnchorKind.Point, x: 900, y: 600 }}
          open={open}
          onClose={vi.fn()}
        />
      )
      const { rerender } = render(menu(true))
      await screen.findByRole('menu')
      return async () => {
        rerender(menu(false))
        await Promise.resolve()
      }
    },
  },
  {
    name: 'a popover',
    open: async () => {
      const anchor = document.createElement('button')
      document.body.append(anchor)
      const popover = (open: boolean): React.JSX.Element => (
        <Popover label="Context" anchor={anchor} open={open} onClose={vi.fn()}>
          <p>Context window</p>
        </Popover>
      )
      const { rerender } = render(popover(true))
      await screen.findByText('Context window')
      return async () => {
        rerender(popover(false))
        await Promise.resolve()
      }
    },
  },
  {
    name: 'a confirmation',
    open: async () => {
      const dialog = (open: boolean): React.JSX.Element => (
        <ConfirmDialog
          open={open}
          title="Delete “Fix flaky login test”?"
          message="It goes for good."
          confirmLabel="Delete"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        />
      )
      const { rerender } = render(dialog(true))
      await screen.findByRole('alertdialog')
      return async () => {
        rerender(dialog(false))
        await Promise.resolve()
      }
    },
  },
  {
    name: 'the Settings modal',
    open: async (store) => {
      render(
        <GladeStoreProvider store={store}>
          <ToastProvider>
            <SettingsDialog />
          </ToastProvider>
        </GladeStoreProvider>,
      )
      act(() => {
        store.getState().openSettings()
      })
      await screen.findByRole('dialog', { name: 'Settings' })
      return async () => {
        act(() => {
          store.getState().closeSettings()
        })
        await Promise.resolve()
      }
    },
  },
  {
    name: 'a toast',
    open: async () => {
      let api: ToastApi | undefined
      render(
        <ToastProvider>
          <Toaster
            onApi={(given) => {
              api = given
            }}
          />
        </ToastProvider>,
      )
      let id = 0
      act(() => {
        id = api?.show({ message: 'Marked done' }) ?? 0
      })
      await screen.findByText('Marked done')
      return async () => {
        act(() => {
          api?.dismiss(id)
        })
        await waitFor(() => {
          expect(screen.queryByText('Marked done')).toBeNull()
        })
      }
    },
  },
  {
    name: 'the relaunch notice',
    open: async (store) => {
      render(
        <GladeStoreProvider store={store}>
          <RelaunchNotice />
        </GladeStoreProvider>,
      )
      const notice = serializeRelaunchNotice({ taskIds: ['t1'] })
      await act(() => store.getState().setUiState({ key: UiStateKey.RelaunchNotice, value: notice }))
      await screen.findByRole('status', { name: 'Glade quit unexpectedly' })
      return async () => {
        await act(() => store.getState().setUiState({ key: UiStateKey.RelaunchNotice, value: '' }))
      }
    },
  },
]

/** A workspace with a task, for the relaunch notice to name. */
const WITH_TASK: Partial<FakeMain> = {
  workspaces: [sampleWorkspace('w1')],
  tasks: [sampleTask('t1', 'w1', 'Fix flaky login test')],
  uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
}

/** Where overlays land: over the card's body, and well away from it. */
const OVER_THE_CARD = new DOMRect(800, 500, 300, 200)
const AWAY_FROM_THE_CARD = new DOMRect(20, 40, 300, 200)

describe('PluginPanel under overlays', () => {
  it.each(OVERLAYS)(
    'hides the view while $name is open over it, and places it again once it closes',
    async ({ open }) => {
      const { main, store } = await renderPanel([NEKOMATA], {}, {}, WITH_TASK)
      await waitFor(() => {
        expect(placed(main)).toEqual([BOUNDS])
      })
      otherBox = OVER_THE_CARD

      const close = await open(store)
      await waitFor(() => {
        expect(placed(main)).toEqual([BOUNDS, null])
      })
      // Marked covered, so a capture doesn't wait for a view over it.
      expect(screen.getByTestId('plugin-view-slot')).toHaveAttribute('data-native-view-covered')
      await close()

      await waitFor(() => {
        expect(placed(main)).toEqual([BOUNDS, null, BOUNDS])
      })
      expect(screen.getByTestId('plugin-view-slot')).not.toHaveAttribute('data-native-view-covered')
    },
  )

  it.each(OVERLAYS)('leaves the view be while $name is open away from it', async ({ open }) => {
    const { main, store } = await renderPanel([NEKOMATA], {}, {}, WITH_TASK)
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS])
    })
    otherBox = AWAY_FROM_THE_CARD

    const close = await open(store)
    await close()

    expect(placed(main)).toEqual([BOUNDS])
  })

  it('keeps the view hidden when it first shows under an overlay, until the overlay goes', async () => {
    const settingsCase = OVERLAYS.find(({ name }) => name === 'the Settings modal')
    const main: FakeMain = { workspaces: [], tasks: [], uiState: [], plugins: [NEKOMATA] }
    const fake = fakeBridge(main)
    const store = createGladeStore(fake.bridge)
    await act(() => store.getState().hydrate())
    otherBox = OVER_THE_CARD
    const close = await settingsCase?.open(store)

    render(
      <GladeStoreProvider store={store}>
        <ToastProvider>
          <PluginPanel collapsed={false} moving={false} />
        </ToastProvider>
      </GladeStoreProvider>,
    )
    await waitFor(() => {
      expect(placed(main)).toEqual([null])
    })
    await close?.()

    await waitFor(() => {
      expect(placed(main)).toEqual([null, BOUNDS])
    })
  })

  it('follows an overlay that moves onto the card after it opens, and off it again', async () => {
    const { main, store } = await renderPanel([NEKOMATA])
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS])
    })
    otherBox = AWAY_FROM_THE_CARD
    const close = await OVERLAYS[0]?.open(store)
    const menu = screen.getByRole('menu')
    expect(placed(main)).toEqual([BOUNDS])

    // Positioned over the card (as Floating UI does, through its style), then its animation ends away from it.
    otherBox = OVER_THE_CARD
    menu.style.left = '800px'
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS, null])
    })
    otherBox = AWAY_FROM_THE_CARD
    fireEvent.animationEnd(menu)
    await waitFor(() => {
      expect(placed(main)).toEqual([BOUNDS, null, BOUNDS])
    })
    await close?.()
    expect(placed(main)).toEqual([BOUNDS, null, BOUNDS])
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
