import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { Effort, PermissionMode, UiStateKey } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, sampleWorkspace, type FakeBridge, type FakeHandlers } from '../store/test-bridge'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'
import { Permission, permissionModeOf } from './SettingsSections'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
}

async function renderSettings(
  section: SettingsSection | null = SettingsSection.Agent,
  overrides: Partial<FakeHandlers> = {},
  withWorkspace = true,
): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: withWorkspace ? [{ ...sampleWorkspace('w1'), rootPath: '/Users/sam/code/api' }] : [],
      tasks: [],
      uiState: withWorkspace ? [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }] : [],
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <button type="button">Elsewhere</button>
      <SettingsDialog />
    </GladeStoreProvider>,
  )
  if (section !== null) {
    act(() => {
      store.getState().openSettings(section)
    })
  }
  await settleFloating()
  return { ...fake, store }
}

function settingsUpdates(invoke: FakeBridge['invoke']): unknown[] {
  return invoke.mock.calls.filter(([command]) => command === CommandName.SettingsUpdate).map(([, request]) => request)
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog', { name: 'Settings' })
}

describe('SettingsDialog', () => {
  it('shows nothing until Settings is opened', async () => {
    await renderSettings(null)

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('lists the sections, then the workspace under its own heading, with the one shown marked and focused', async () => {
    await renderSettings()

    const nav = within(dialog()).getByRole('navigation', { name: 'Settings sections' })
    expect(
      within(nav)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['General', 'Agent', 'Notifications', 'Appearance', 'Keyboard', 'Plugins', 'Control', 'Acme API'])
    expect(nav).toHaveTextContent('Workspace')
    const agent = within(nav).getByRole('button', { name: 'Agent' })
    expect(agent).toHaveAttribute('aria-current', 'page')
    expect(agent).toHaveFocus()
    expect(within(dialog()).getByRole('heading', { level: 2 })).toHaveTextContent('Agent')
  })

  it('moves between sections from the nav', async () => {
    const { store } = await renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Plugins' }))

    expect(store.getState().settingsSection).toBe(SettingsSection.Plugins)
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Plugins')
    expect(await screen.findByText('No plugins installed.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Plugins' })).toHaveAttribute('aria-current', 'page')
    expect(screen.getByRole('button', { name: 'Agent' })).not.toHaveAttribute('aria-current')

    fireEvent.click(screen.getByRole('button', { name: 'Acme API' }))

    expect(store.getState().settingsSection).toBe(SettingsSection.Workspace)
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toBeInTheDocument()
  })

  it('closes with the close button, Esc, or a click outside', async () => {
    const { store } = await renderSettings()

    fireEvent.click(screen.getByRole('button', { name: 'Close settings' }))
    expect(store.getState().settingsSection).toBeNull()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    act(() => {
      store.getState().openSettings()
    })
    await settleFloating()
    fireEvent.keyDown(dialog(), { key: 'Escape' })
    expect(store.getState().settingsSection).toBeNull()

    act(() => {
      store.getState().openSettings()
    })
    await settleFloating()
    fireEvent.mouseDown(document.body)
    expect(store.getState().settingsSection).toBeNull()
  })

  describe('Agent', () => {
    it('shows the defaults for new tasks, the permissions, and the status and title toggles', async () => {
      await renderSettings()

      expect(screen.getByRole('button', { name: 'Model: Opus 5.5' })).toHaveAttribute('aria-haspopup', 'menu')
      expect(screen.getByRole('radiogroup', { name: 'Effort' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'High' })).toBeChecked()
      expect(screen.getByRole('radio', { name: 'Allow all' })).toBeChecked()
      expect(screen.getByRole('radio', { name: 'Ask first' })).toBeEnabled()
      expect(screen.getByRole('radio', { name: 'Allow edits' })).toBeDisabled()
      expect(screen.getByRole('switch', { name: 'Status summary' })).toBeChecked()
      expect(screen.getByRole('switch', { name: 'Task titles' })).toBeChecked()
      expect(screen.queryByText(/Auto-compact/)).not.toBeInTheDocument()
    })

    it('saves each change at once', async () => {
      const { invoke, store } = await renderSettings()

      fireEvent.click(screen.getByRole('button', { name: 'Model: Opus 5.5' }))
      await settleFloating()
      const menu = screen.getByRole('menu', { name: 'Model' })
      expect(within(menu).getByRole('menuitemradio', { name: 'Opus 5.5' })).toHaveAttribute('aria-checked', 'true')
      fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Sonnet 5' }))
      await settleFloating()
      fireEvent.click(screen.getByRole('radio', { name: 'Low' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Status summary' }))
      fireEvent.click(screen.getByRole('switch', { name: 'Task titles' }))
      await act(async () => {
        await Promise.resolve()
      })

      expect(settingsUpdates(invoke)).toEqual([
        { patch: { defaultModel: 'claude-sonnet-5' } },
        { patch: { defaultEffort: Effort.Low } },
        { patch: { statusSummary: false } },
        { patch: { taskTitles: false } },
      ])
      expect(store.getState().settings).toEqual({
        ...DEFAULT_SETTINGS,
        defaultModel: 'claude-sonnet-5',
        defaultEffort: Effort.Low,
        statusSummary: false,
        taskTitles: false,
      })
      expect(screen.getByRole('button', { name: 'Model: Sonnet 5' })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: 'Low' })).toBeChecked()
      expect(screen.getByRole('switch', { name: 'Status summary' })).not.toBeChecked()
    })

    it('sets the permission mode new tasks start in: Ask first is the ask mode, and Allow edits stays disabled', async () => {
      const { invoke, store } = await renderSettings()

      fireEvent.click(screen.getByRole('radio', { name: 'Ask first' }))
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked()
      expect(store.getState().settings.defaultPermissionMode).toBe(PermissionMode.AskBeforeEdits)

      fireEvent.click(screen.getByRole('radio', { name: 'Allow edits' }))
      fireEvent.click(screen.getByRole('radio', { name: 'Allow all' }))
      await act(async () => {
        await Promise.resolve()
      })

      expect(screen.getByRole('radio', { name: 'Allow all' })).toBeChecked()
      expect(settingsUpdates(invoke)).toEqual([
        { patch: { defaultPermissionMode: PermissionMode.AskBeforeEdits } },
        { patch: { defaultPermissionMode: PermissionMode.AllowAll } },
      ])
    })

    it('opens on the ask mode when that is the default', async () => {
      const settings = { ...DEFAULT_SETTINGS, defaultPermissionMode: PermissionMode.AskBeforeEdits }
      await renderSettings(SettingsSection.Agent, { [CommandName.SettingsGet]: () => ({ settings }) })

      expect(screen.getByRole('radio', { name: 'Ask first' })).toBeChecked()
    })

    it('has no permission mode for Allow edits, which is not one yet', () => {
      expect(permissionModeOf(Permission.AllowEdits)).toBeNull()
      expect(permissionModeOf(Permission.AskFirst)).toBe(PermissionMode.AskBeforeEdits)
      expect(permissionModeOf(Permission.AllowAll)).toBe(PermissionMode.AllowAll)
    })
  })

  describe('Notifications', () => {
    it('turns notifications and their sound on and off, and has no sound to change while they are off', async () => {
      const { invoke, store } = await renderSettings(SettingsSection.Notifications)

      const notifications = screen.getByRole('switch', { name: 'Notifications' })
      const sound = screen.getByRole('switch', { name: 'Sound' })
      expect(notifications).toBeChecked()
      expect(sound).not.toBeChecked()

      fireEvent.click(sound)
      await act(async () => {
        await Promise.resolve()
      })
      expect(screen.getByRole('switch', { name: 'Sound' })).toBeChecked()
      fireEvent.click(notifications)
      await act(async () => {
        await Promise.resolve()
      })

      expect(settingsUpdates(invoke)).toEqual([
        { patch: { notificationSound: true } },
        { patch: { notifications: false } },
      ])
      expect(store.getState().settings.notifications).toBe(false)
      expect(screen.getByRole('switch', { name: 'Sound' })).toBeDisabled()
    })
  })

  it('shows the shortcuts in Keyboard, each a keycap you can click to rebind', async () => {
    await renderSettings(SettingsSection.Keyboard)

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Keyboard')
    const global = screen.getByRole('region', { name: 'Global' })
    expect(within(global).getByRole('button', { name: 'Settings: ⌘,' })).toHaveTextContent('⌘,')
    expect(within(dialog()).queryByRole('textbox')).not.toBeInTheDocument()
  })

  it.each([
    [SettingsSection.General, 'General', 'Nothing to set here yet.'],
    [SettingsSection.Appearance, 'Appearance', 'Glade has one theme, dark. Nothing to change here yet.'],
  ])('shows %s with nothing to set', async (section, title, text) => {
    await renderSettings(section)

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(title)
    expect(screen.getByText(text)).toBeInTheDocument()
    expect(within(dialog()).queryByRole('switch')).not.toBeInTheDocument()
  })

  describe('Workspace', () => {
    it("shows the workspace's name and root, under its name", async () => {
      await renderSettings(SettingsSection.Workspace)

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Acme API')
      expect(screen.getByRole('button', { name: 'Acme API' })).toHaveAttribute('aria-current', 'page')
      expect(screen.getByRole('textbox', { name: 'Workspace name' })).toHaveValue('Acme API')
      expect(screen.getByText('~/code/api')).toHaveAttribute('title', '/Users/sam/code/api')
    })

    it('renames the workspace, trimmed, on Enter or when the field loses focus, and ignores a blank or same name', async () => {
      const { invoke, store } = await renderSettings(SettingsSection.Workspace)
      const field = screen.getByRole('textbox', { name: 'Workspace name' })
      const updates = (): unknown[] =>
        invoke.mock.calls.filter(([command]) => command === CommandName.WorkspacesUpdate).map(([, request]) => request)

      fireEvent.change(field, { target: { value: '  Acme  ' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      await act(async () => {
        await Promise.resolve()
      })
      expect(updates()).toEqual([{ id: 'w1', patch: { name: 'Acme' } }])
      expect(store.getState().workspaces[0]?.name).toBe('Acme')
      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Acme')

      fireEvent.change(field, { target: { value: ' ' } })
      fireEvent.blur(field)
      expect(field).toHaveValue('Acme')
      fireEvent.change(field, { target: { value: 'Acme' } })
      fireEvent.keyDown(field, { key: 'a' })
      fireEvent.blur(field)
      expect(updates()).toHaveLength(1)
    })

    it('moves the workspace to the folder you choose, and does nothing when you cancel or keep the same one', async () => {
      const chooseFolder = vi.fn<FakeHandlers[CommandName.DialogChooseFolder]>(() => ({ path: '/code/acme' }))
      const { invoke, store } = await renderSettings(SettingsSection.Workspace, {
        [CommandName.DialogChooseFolder]: chooseFolder,
      })
      const updates = (): unknown[] =>
        invoke.mock.calls.filter(([command]) => command === CommandName.WorkspacesUpdate).map(([, request]) => request)

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
        await Promise.resolve()
      })
      expect(updates()).toEqual([{ id: 'w1', patch: { rootPath: '/code/acme' } }])
      expect(store.getState().workspaces[0]?.rootPath).toBe('/code/acme')

      chooseFolder.mockReturnValueOnce({ path: null }).mockReturnValueOnce({ path: '/code/acme' })
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
          await Promise.resolve()
        })
      }
      expect(updates()).toHaveLength(1)
    })

    it('says why a change was refused', async () => {
      await renderSettings(SettingsSection.Workspace, {
        [CommandName.DialogChooseFolder]: () => ({ path: '/code/acme-web' }),
        [CommandName.WorkspacesUpdate]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidRootPath, '/code/acme-web is already the workspace Acme Web')),
      })

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Change…' }))
        await Promise.resolve()
      })

      expect(await screen.findByRole('alert')).toHaveTextContent('/code/acme-web is already the workspace Acme Web')
    })

    it('falls back to Agent, with no Workspace section, when no workspace is open', async () => {
      await renderSettings(SettingsSection.Workspace, {}, false)

      expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Agent')
      expect(screen.queryByText('Workspace')).not.toBeInTheDocument()
    })
  })
})
