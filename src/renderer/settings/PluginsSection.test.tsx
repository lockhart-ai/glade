import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  PluginCapability,
  PluginSettingType,
  PluginStatus,
  type InstalledPlugin,
  type PluginSetting,
  type ValidPlugin,
} from '../../shared/plugins'
import { ToastProvider } from '../components'
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
    manifest: { id, name, version: '1.0.0', entry: 'index.html', icon: 'icon.svg', capabilities: [], settings: [] },
    iconUrl: ICON,
    enabled: true,
    granted: [],
    settings: {},
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
      <ToastProvider>
        <SettingsDialog />
      </ToastProvider>
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

  it('reloads a plugin by hand, without rereading the folder', async () => {
    const { invoke } = await renderPlugins([POMODORO])
    await read()

    fireEvent.click(screen.getByRole('button', { name: 'Reload Pomodoro' }))

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.PluginsReload, { id: 'pomodoro' })
    })
    expect(invoke.mock.calls.filter(([command]) => command === CommandName.PluginsList)).toHaveLength(1)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows why a reload failed, and gives an invalid plugin no Reload button', async () => {
    await renderPlugins([POMODORO, BROKEN], {
      [CommandName.PluginsReload]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No plugin pomodoro')),
    })
    await read()

    const broken = within(list()).getByRole('listitem', { name: 'weather-strip' })
    expect(within(broken).queryByRole('button')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Reload Pomodoro' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No plugin pomodoro')
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

describe('Settings › Plugins: settings', () => {
  const STYLE: PluginSetting = {
    type: PluginSettingType.Select,
    key: 'style',
    label: 'Art style',
    options: [
      { value: 'ink', label: 'Ink' },
      { value: 'chalk', label: 'Chalk' },
      { value: 'neon', label: 'Neon' },
    ],
    default: 'ink',
  }
  const PACE: PluginSetting = {
    type: PluginSettingType.Select,
    key: 'pace',
    label: 'Pace',
    options: [
      { value: 'slow', label: 'Slow' },
      { value: 'fast', label: 'Fast' },
    ],
    default: 'fast',
  }
  const SKETCHPAD = validPlugin('sketchpad', 'Sketchpad', {
    manifest: {
      ...validPlugin('sketchpad', 'Sketchpad').manifest,
      capabilities: [PluginCapability.Machine],
      settings: [STYLE, PACE],
    },
    settings: { style: 'ink', pace: 'fast' },
  })

  function sketchpad(): HTMLElement {
    return within(list()).getByRole('listitem', { name: 'Sketchpad' })
  }

  /** Opens a setting's select and picks an option from its menu. */
  async function choose(select: RegExp, option: string): Promise<void> {
    fireEvent.click(within(sketchpad()).getByRole('button', { name: select }))
    await settleFloating()
    fireEvent.click(within(screen.getByRole('menu')).getByRole('menuitemradio', { name: option }))
    await settleFloating()
  }

  it('shows a select for each setting a plugin declares, under its capability switch, at the value chosen', async () => {
    await renderPlugins([POMODORO, { ...SKETCHPAD, settings: { style: 'ink', pace: 'slow' } }])
    await read()

    const row = sketchpad()
    expect(row).toHaveTextContent('Art style')
    expect(within(row).getByRole('button', { name: 'Sketchpad: Art style: Ink' })).toHaveTextContent('Ink')
    expect(within(row).getByRole('button', { name: 'Sketchpad: Pace: Slow' })).toHaveTextContent('Slow')
    // Capabilities first, then the settings in the order declared.
    expect(row.textContent).toMatch(/Can see your Mac's CPU, GPU and Docker load.*Art style.*Pace/)
    const pomodoro = within(list()).getByRole('listitem', { name: 'Pomodoro' })
    expect(within(pomodoro).queryByRole('button', { name: /: / })).not.toBeInTheDocument()
  })

  it('lists the options in the order declared, with the one chosen checked', async () => {
    await renderPlugins([{ ...SKETCHPAD, settings: { style: 'chalk', pace: 'fast' } }])
    await read()

    fireEvent.click(within(sketchpad()).getByRole('button', { name: /^Sketchpad: Art style/ }))
    await settleFloating()

    const options = within(screen.getByRole('menu', { name: 'Art style' })).getAllByRole('menuitemradio')
    expect(options.map((option) => option.textContent)).toEqual(['Ink', 'Chalk', 'Neon'])
    expect(options.map((option) => option.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
  })

  it('chooses another option, saving it at once, whether the plugin is on or off, and leaves the others alone', async () => {
    const off = { ...SKETCHPAD, enabled: false }
    const { invoke, main } = await renderPlugins([off])
    await read()

    await choose(/^Sketchpad: Art style/, 'Neon')

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.PluginsSetSetting, {
        id: 'sketchpad',
        key: 'style',
        value: 'neon',
      })
    })
    expect(within(sketchpad()).getByRole('button', { name: 'Sketchpad: Art style: Neon' })).toBeInTheDocument()
    expect(within(sketchpad()).getByRole('button', { name: 'Sketchpad: Pace: Fast' })).toBeInTheDocument()
    expect(main.plugins).toEqual([{ ...off, settings: { style: 'neon', pace: 'fast' } }])
  })

  it('shows the value at once, before main has answered', async () => {
    let answer: (response: { plugins: InstalledPlugin[] }) => void = () => undefined
    await renderPlugins([SKETCHPAD], {
      [CommandName.PluginsSetSetting]: () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    })
    await read()

    await choose(/^Sketchpad: Pace/, 'Slow')

    expect(within(sketchpad()).getByRole('button', { name: 'Sketchpad: Pace: Slow' })).toBeInTheDocument()
    await act(async () => {
      answer({ plugins: [{ ...SKETCHPAD, settings: { style: 'ink', pace: 'slow' } }] })
      await Promise.resolve()
    })
    expect(within(sketchpad()).getByRole('button', { name: 'Sketchpad: Pace: Slow' })).toBeInTheDocument()
  })

  it('shows why a choice failed, and the plugins as they are now', async () => {
    const { main } = await renderPlugins([SKETCHPAD])
    await read()
    // Updated since Settings › Plugins read it: it no longer offers Neon.
    const fewer = { ...STYLE, options: STYLE.options.slice(0, 2) }
    main.plugins = [{ ...SKETCHPAD, manifest: { ...SKETCHPAD.manifest, settings: [fewer, PACE] } }]

    await choose(/^Sketchpad: Art style/, 'Neon')

    expect(await screen.findByRole('alert')).toHaveTextContent('sketchpad has no setting style that offers neon')
    await waitFor(() => {
      expect(within(sketchpad()).getByRole('button', { name: 'Sketchpad: Art style: Ink' })).toBeInTheDocument()
    })
  })

  it('refuses a plugin that has gone since the list was read', async () => {
    const { main } = await renderPlugins([SKETCHPAD])
    await read()
    main.plugins = []

    await choose(/^Sketchpad: Art style/, 'Chalk')

    expect(await screen.findByRole('alert')).toHaveTextContent('No plugin sketchpad')
    await waitFor(() => {
      expect(within(list()).queryByRole('listitem')).not.toBeInTheDocument()
    })
  })

  it('shows the value main broadcasts', async () => {
    const { emit } = await renderPlugins([SKETCHPAD])
    await read()

    act(() => {
      emit({ type: EventType.PluginsChanged, plugins: [{ ...SKETCHPAD, settings: { style: 'chalk', pace: 'fast' } }] })
    })

    expect(within(sketchpad()).getByRole('button', { name: 'Sketchpad: Art style: Chalk' })).toBeInTheDocument()
  })
})

describe('Settings › Plugins: capabilities', () => {
  const LABEL = "Can see your Mac's CPU, GPU and Docker load"
  const GAUGE = validPlugin('gauge', 'Load Gauge', {
    manifest: { ...validPlugin('gauge', 'Load Gauge').manifest, capabilities: [PluginCapability.Machine] },
  })

  it('shows a switch for each capability a plugin asks for, off until turned on, and none when it asks for none', async () => {
    await renderPlugins([GAUGE, POMODORO])
    await read()

    const gauge = within(list()).getByRole('listitem', { name: 'Load Gauge' })
    expect(gauge).toHaveTextContent(LABEL)
    expect(within(gauge).getByRole('switch', { name: `Load Gauge: ${LABEL}` })).not.toBeChecked()
    expect(within(gauge).getByRole('switch', { name: 'Load Gauge' })).toBeChecked()
    const pomodoro = within(list()).getByRole('listitem', { name: 'Pomodoro' })
    expect(pomodoro).not.toHaveTextContent(LABEL)
    expect(within(pomodoro).getAllByRole('switch')).toHaveLength(1)
  })

  it('turns the capability on and off, saving each change at once, whether the plugin is on or off', async () => {
    const off = { ...GAUGE, enabled: false }
    const { invoke, main } = await renderPlugins([off])
    await read()
    const toggle = within(list()).getByRole('switch', { name: `Load Gauge: ${LABEL}` })

    fireEvent.click(toggle)
    expect(toggle).toBeChecked()
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.PluginsSetCapability, {
        id: 'gauge',
        capability: PluginCapability.Machine,
        granted: true,
      })
    })
    expect(main.plugins).toEqual([{ ...off, granted: [PluginCapability.Machine] }])
    expect(within(list()).getByRole('switch', { name: 'Load Gauge' })).not.toBeChecked()

    fireEvent.click(toggle)
    await waitFor(() => {
      expect(toggle).not.toBeChecked()
    })
    expect(main.plugins).toEqual([off])
  })

  it('shows why the switch failed, and the plugins as they are now', async () => {
    const { main } = await renderPlugins([GAUGE])
    await read()
    // Reinstalled since Settings › Plugins read it, without asking for the machine's readings any more.
    main.plugins = [{ ...GAUGE, manifest: { ...GAUGE.manifest, capabilities: [], settings: [] } }]

    fireEvent.click(within(list()).getByRole('switch', { name: `Load Gauge: ${LABEL}` }))

    expect(await screen.findByRole('alert')).toHaveTextContent("gauge doesn't ask for machine")
    await waitFor(() => {
      expect(within(list()).queryByText(LABEL)).not.toBeInTheDocument()
    })
  })

  it('refuses a plugin that has gone since the list was read', async () => {
    const { main } = await renderPlugins([GAUGE])
    await read()
    main.plugins = []

    fireEvent.click(within(list()).getByRole('switch', { name: `Load Gauge: ${LABEL}` }))

    expect(await screen.findByRole('alert')).toHaveTextContent('No plugin gauge')
  })
})
