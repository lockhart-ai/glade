import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { PluginStatus, type InstalledPlugin, type ValidPlugin } from '../../shared/plugins'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, type FakeBridge, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'

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

const POMODORO = validPlugin('pomodoro', 'Pomodoro', {
  manifest: { ...validPlugin('pomodoro', 'Pomodoro').manifest, version: '0.4.2' },
})
const ABACUS = validPlugin('abacus', 'Abacus', { iconUrl: null, enabled: false })
const BROKEN: InstalledPlugin = {
  status: PluginStatus.Invalid,
  folder: 'weather-strip',
  reason: "entry: Expected a path inside the plugin's folder",
}

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
}

async function renderPlugins(plugins: InstalledPlugin[], overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const main: FakeMain = { workspaces: [], tasks: [], uiState: [], plugins }
  const fake = fakeBridge(main, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  act(() => {
    store.getState().openSettings(SettingsSection.Plugins)
  })
  await settleFloating()
  return { ...fake, store, main }
}

function list(): HTMLElement {
  return screen.getByRole('list', { name: 'Plugins' })
}

/** Waits for the plugins folder to have been read since Settings › Plugins opened. */
async function read(): Promise<void> {
  await waitFor(() => {
    expect(list()).toHaveAttribute('aria-busy', 'false')
  })
}

describe('Settings › Plugins', () => {
  it('reads the plugins folder as it opens, and lists each plugin with its icon, name, version and toggle', async () => {
    const { invoke } = await renderPlugins([ABACUS, POMODORO])
    await read()

    expect(invoke).toHaveBeenCalledWith(CommandName.PluginsList, {})
    const rows = within(list()).getAllByRole('listitem')
    expect(rows.map((row) => row.getAttribute('aria-label'))).toEqual(['Abacus', 'Pomodoro'])
    const pomodoro = within(list()).getByRole('listitem', { name: 'Pomodoro' })
    expect(pomodoro).toHaveTextContent('Pomodoro0.4.2')
    expect(pomodoro.querySelector('img')).toHaveAttribute('src', ICON)
    expect(within(pomodoro).getByRole('switch', { name: 'Pomodoro' })).toBeChecked()
    // One without an icon gets a stand-in.
    const abacus = within(list()).getByRole('listitem', { name: 'Abacus' })
    expect(abacus.querySelector('img')).toBeNull()
    expect(abacus.querySelector('svg')).not.toBeNull()
    expect(within(abacus).getByRole('switch', { name: 'Abacus' })).not.toBeChecked()
    expect(screen.queryByText('No plugins installed.')).not.toBeInTheDocument()
  })

  it('lists an invalid plugin by its folder, with why, and no toggle', async () => {
    await renderPlugins([POMODORO, BROKEN])
    await read()

    const broken = within(list()).getByRole('listitem', { name: 'weather-strip' })
    expect(broken).toHaveTextContent("weather-stripentry: Expected a path inside the plugin's folder")
    expect(within(broken).queryByRole('switch')).not.toBeInTheDocument()
    expect(within(list()).getAllByRole('switch')).toHaveLength(1)
  })

  it('says there are none once the folder has been read and is empty', async () => {
    const { invoke } = await renderPlugins([])

    await read()

    expect(screen.getByText('No plugins installed.')).toBeInTheDocument()
    expect(within(list()).queryAllByRole('listitem')).toEqual([])
    expect(invoke).toHaveBeenCalledWith(CommandName.PluginsList, {})
  })

  it("doesn't say there are none before the folder has been read", async () => {
    let answer: (plugins: InstalledPlugin[]) => void = () => undefined
    await renderPlugins([], {
      [CommandName.PluginsList]: () =>
        new Promise((resolve) => {
          answer = (plugins) => {
            resolve({ plugins })
          }
        }),
    })

    expect(list()).toHaveAttribute('aria-busy', 'true')
    expect(screen.queryByText('No plugins installed.')).not.toBeInTheDocument()

    await act(async () => {
      answer([POMODORO])
      await Promise.resolve()
    })
    await read()
    expect(within(list()).getByRole('listitem', { name: 'Pomodoro' })).toBeInTheDocument()
  })

  it('turns a plugin off and on, saving each change at once', async () => {
    const { invoke, main } = await renderPlugins([POMODORO])
    await read()
    const toggle = within(list()).getByRole('switch', { name: 'Pomodoro' })

    fireEvent.click(toggle)
    expect(toggle).not.toBeChecked()
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.PluginsSetEnabled, { id: 'pomodoro', enabled: false })
    })
    expect(main.plugins).toEqual([{ ...POMODORO, enabled: false }])

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(toggle).toBeChecked()
    })
    expect(main.plugins).toEqual([POMODORO])
  })

  it('shows why a toggle failed, and the plugins as they are now', async () => {
    const { main } = await renderPlugins([POMODORO, ABACUS])
    await read()
    // The folder was removed since Settings › Plugins read it.
    main.plugins = [ABACUS]

    fireEvent.click(within(list()).getByRole('switch', { name: 'Pomodoro' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No plugin pomodoro')
    await waitFor(() => {
      expect(within(list()).queryByRole('listitem', { name: 'Pomodoro' })).not.toBeInTheDocument()
    })
  })

  it('shows the plugins main broadcasts', async () => {
    const { emit } = await renderPlugins([POMODORO])
    await read()

    act(() => {
      emit({ type: EventType.PluginsChanged, plugins: [POMODORO, ABACUS] })
    })

    expect(within(list()).getAllByRole('listitem')).toHaveLength(2)
  })

  it('reads the folder again each time it opens, finding plugins added and removed since', async () => {
    const { store, main, invoke } = await renderPlugins([POMODORO])
    await read()

    main.plugins = [ABACUS]
    act(() => {
      store.getState().openSettings(SettingsSection.Agent)
    })
    act(() => {
      store.getState().openSettings(SettingsSection.Plugins)
    })
    await read()

    expect(invoke.mock.calls.filter(([command]) => command === CommandName.PluginsList)).toHaveLength(2)
    expect(
      within(list())
        .getAllByRole('listitem')
        .map((row) => row.getAttribute('aria-label')),
    ).toEqual(['Abacus'])
  })

  it('opens the plugins folder', async () => {
    const { main } = await renderPlugins([])
    await read()

    fireEvent.click(screen.getByRole('button', { name: 'Open plugins folder' }))

    await waitFor(() => {
      expect(main.openedPluginsFolder).toBe(1)
    })
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it("shows why the folder couldn't be opened", async () => {
    await renderPlugins([], {
      [CommandName.PluginsOpenFolder]: () =>
        refuse(bridgeError(BridgeErrorCode.Internal, "Couldn't open the plugins folder: no Finder")),
    })
    await read()

    fireEvent.click(screen.getByRole('button', { name: 'Open plugins folder' }))

    expect(await screen.findByRole('alert')).toHaveTextContent("Couldn't open the plugins folder: no Finder")
  })

  it("shows why the folder couldn't be read, and no empty state", async () => {
    await renderPlugins([], {
      [CommandName.PluginsList]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'plugins.list failed: EIO')),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('plugins.list failed: EIO')
    await read()
  })

  it('leaves the list alone when it closes before the folder has been read', async () => {
    let answer: () => void = () => undefined
    const { store } = await renderPlugins([], {
      [CommandName.PluginsList]: () =>
        new Promise((resolve) => {
          answer = () => {
            resolve(refuse(bridgeError(BridgeErrorCode.Internal, 'too late')))
          }
        }),
    })

    act(() => {
      store.getState().closeSettings()
    })
    await act(async () => {
      answer()
      await Promise.resolve()
    })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
