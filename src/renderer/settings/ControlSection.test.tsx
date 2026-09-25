import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { connectCommand, controlUrl, DEFAULT_CONTROL_PORT } from '../../shared/control'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, type FakeBridge, type FakeHandlers, type FakeMain } from '../store/test-bridge'
import { PORT_PROBLEM } from './ControlSection'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
}

const SWITCH = 'Let agents control Glade'
const URL = controlUrl(DEFAULT_CONTROL_PORT)

async function renderControl(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fullMain: FakeMain = { workspaces: [], tasks: [], uiState: [], copied: [], ...main }
  const fake = fakeBridge(fullMain, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  act(() => {
    store.getState().openSettings(SettingsSection.Control)
  })
  await settleFloating()
  return { ...fake, store, main: fullMain }
}

function toggle(): HTMLElement {
  return screen.getByRole('switch', { name: SWITCH })
}

function command(): HTMLElement {
  return screen.getByLabelText('Connect command')
}

function port(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Port' })
}

const ON = { settings: { ...DEFAULT_SETTINGS, controlEnabled: true } }

describe('Settings › Control', () => {
  it('is listed after Plugins, and off shows the switch alone', async () => {
    const { invoke } = await renderControl()

    const nav = screen.getByRole('navigation', { name: 'Settings sections' })
    const labels = within(nav)
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels.slice(-2)).toEqual(['Plugins', 'Control'])
    expect(screen.getByRole('heading', { name: 'Control' })).toBeInTheDocument()
    expect(toggle()).not.toBeChecked()
    expect(screen.getByText('glade-control')).toBeInTheDocument()
    expect(screen.queryByText('Endpoint')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy' })).not.toBeInTheDocument()
    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.ControlStatus, {})
    })
  })

  it('turned on, shows the endpoint, the command with its token, Regenerate token, the port and the note', async () => {
    const { invoke } = await renderControl()

    fireEvent.click(toggle())

    await waitFor(() => {
      expect(command()).toHaveTextContent(connectCommand(URL, 'token-1'))
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { controlEnabled: true } })
    expect(toggle()).toBeChecked()
    expect(screen.getByLabelText('Endpoint URL')).toHaveTextContent(URL)
    expect(screen.getByRole('button', { name: 'Regenerate token' })).toBeInTheDocument()
    expect(port()).toHaveValue(String(DEFAULT_CONTROL_PORT))
    expect(screen.getByText("Glade's own tasks get these tools too, from their next session.")).toBeInTheDocument()
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('copies the command, token and all', async () => {
    const { main } = await renderControl(ON)
    await waitFor(() => {
      expect(command()).toBeInTheDocument()
    })

    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))

    await waitFor(() => {
      expect(main.copied).toEqual([connectCommand(URL, 'token-1')])
    })
  })

  it('regenerates the token, and the command shows the new one', async () => {
    const { invoke } = await renderControl(ON)
    await waitFor(() => {
      expect(command()).toHaveTextContent('token-1')
    })

    fireEvent.click(screen.getByRole('button', { name: 'Regenerate token' }))

    await waitFor(() => {
      expect(command()).toHaveTextContent(connectCommand(URL, 'token-2'))
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.ControlRegenerateToken, {})
  })

  it('saves a new port on Return, and the endpoint moves to it', async () => {
    const { invoke } = await renderControl(ON)

    fireEvent.change(port(), { target: { value: ' 45300 ' } })
    fireEvent.keyDown(port(), { key: 'Enter' })

    await waitFor(() => {
      expect(screen.getByLabelText('Endpoint URL')).toHaveTextContent(controlUrl(45300))
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { controlPort: 45300 } })
    expect(port()).toHaveValue('45300')
  })

  it('saves a new port when the field loses focus, and not when it is unchanged', async () => {
    const { invoke } = await renderControl(ON)

    fireEvent.blur(port())
    fireEvent.change(port(), { target: { value: '50000' } })
    fireEvent.keyDown(port(), { key: 'a' })
    fireEvent.blur(port())

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { controlPort: 50000 } })
    })
    const updates = invoke.mock.calls.filter(([name]) => name === CommandName.SettingsUpdate)
    expect(updates).toHaveLength(1)
  })

  it.each([['80'], ['70000'], ['45233.5'], ['port'], ['']])(
    'refuses %j for a port, saying why, and goes back to the one it had',
    async (typed) => {
      const { invoke } = await renderControl(ON)

      fireEvent.change(port(), { target: { value: typed } })
      fireEvent.blur(port())

      expect(await screen.findByRole('alert')).toHaveTextContent(PORT_PROBLEM)
      expect(port()).toHaveValue(String(DEFAULT_CONTROL_PORT))
      expect(invoke).not.toHaveBeenCalledWith(CommandName.SettingsUpdate, expect.anything())
      // A good one clears it.
      fireEvent.change(port(), { target: { value: '45240' } })
      fireEvent.blur(port())
      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      })
    },
  )

  it('says so when the chosen port is taken and another is in use', async () => {
    await renderControl({ ...ON, controlFallbackPort: 45235 })

    expect(await screen.findByRole('status')).toHaveTextContent(
      '45233 is in use, so Glade is listening on 45235. A command copied before points at 45233.',
    )
    expect(screen.getByLabelText('Endpoint URL')).toHaveTextContent(controlUrl(45235))
    expect(command()).toHaveTextContent(controlUrl(45235))
  })

  it("shows the error when it can't listen, with no command to copy", async () => {
    await renderControl({ ...ON, controlError: 'Ports 45233–45242 are all in use.' })

    expect(await screen.findByRole('status')).toHaveTextContent('Ports 45233–45242 are all in use.')
    expect(screen.getByLabelText('Endpoint URL')).toHaveTextContent('Not listening')
    expect(screen.queryByLabelText('Connect command')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
  })

  it('follows the endpoint as main broadcasts it', async () => {
    const { emit } = await renderControl(ON)
    await waitFor(() => {
      expect(command()).toBeInTheDocument()
    })

    act(() => {
      emit({
        type: EventType.ControlChanged,
        status: {
          enabled: true,
          chosenPort: DEFAULT_CONTROL_PORT,
          port: 45239,
          url: controlUrl(45239),
          token: 'token-9',
          error: null,
        },
      })
    })

    expect(command()).toHaveTextContent(connectCommand(controlUrl(45239), 'token-9'))
  })

  it('says why when reading the endpoint or regenerating fails', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'control.status failed: the database is locked')
    await renderControl(ON, {
      [CommandName.ControlStatus]: () => refuse(failure),
      [CommandName.ControlRegenerateToken]: () =>
        refuse(bridgeError(BridgeErrorCode.Internal, 'control.regenerateToken failed: disk full')),
    })

    expect(await screen.findByRole('alert')).toHaveTextContent('the database is locked')
    fireEvent.click(screen.getByRole('button', { name: 'Regenerate token' }))
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('disk full')
    })
  })

  it("doesn't say anything once it's closed before the endpoint is read", async () => {
    let answer: (() => void) | undefined
    const { store } = await renderControl(ON, {
      [CommandName.ControlStatus]: () =>
        new Promise((_resolve, reject) => {
          answer = () => {
            reject(new Error('late'))
          }
        }),
    })

    act(() => {
      store.getState().closeSettings()
    })
    await act(async () => {
      answer?.()
      await Promise.resolve()
    })

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })
})
