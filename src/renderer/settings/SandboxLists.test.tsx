// The sandbox in Settings (P15-06, #451): the switch and the Glade-wide lists in Settings › Agent, a workspace's lists
// in Settings › Workspace, over a fake main that keeps and refuses grants as main does (`../store/test-bridge`).
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType, type SandboxGrantsResponse } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import {
  FolderAccess,
  SandboxGrantKind,
  SandboxGrantScope,
  SETTINGS_GRANT_REFUSALS,
  type Grant,
  type SettingsGrantTarget,
} from '../../shared/sandbox'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { ToastProvider } from '../components'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from '../store/test-bridge'
import { BLANK_DOMAIN, grantFailureMessage } from './SandboxLists'
import { SettingsSection } from './sections'
import { SettingsDialog } from './SettingsDialog'
import { setHomeFolder } from '../../shared/homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/sam')

const read = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.Read })
const readWrite = (path: string): Grant => ({ kind: SandboxGrantKind.Folder, path, access: FolderAccess.ReadWrite })
const domain = (host: string): Grant => ({ kind: SandboxGrantKind.Domain, domain: host })

const GLADE: SettingsGrantTarget = { scope: SandboxGrantScope.Glade }
const WORKSPACE: SettingsGrantTarget = { scope: SandboxGrantScope.Workspace, workspaceId: 'w1' }
const ROOT = '/Users/sam/code/api'

const GLADE_GRANTS: readonly Grant[] = [
  read('/Users/sam/.nvm'),
  read('/Users/sam/.config/git'),
  readWrite('/Users/sam/.npm'),
  domain('pypi.org'),
  domain('files.pythonhosted.org'),
]
const WORKSPACE_GRANTS: readonly Grant[] = [
  read('/Users/sam/code/acme-shared'),
  readWrite('/Users/sam/code/acme-web/src/api'),
  domain('github.com'),
  domain('api.stripe.com'),
]

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
}

interface Setup {
  readonly section?: SettingsSection
  /** Whether the sandbox is on; on unless told otherwise (the default is off until P15's last PR). */
  readonly enabled?: boolean
  readonly glade?: readonly Grant[]
  readonly workspace?: readonly Grant[]
  readonly overrides?: Partial<FakeHandlers>
}

async function renderSettings({
  section = SettingsSection.Agent,
  enabled = true,
  glade = [],
  workspace = [],
  overrides = {},
}: Setup = {}): Promise<Rendered> {
  const main: FakeMain = {
    workspaces: [{ ...sampleWorkspace('w1'), rootPath: ROOT }],
    tasks: [],
    uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
    settings: { ...DEFAULT_SETTINGS, sandboxEnabled: enabled },
    sandboxGrants: { glade, 'workspace:w1': workspace },
  }
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
    store.getState().openSettings(section)
  })
  await settleFloating()
  return { ...fake, store, main }
}

/** The requests a `sandbox.*` command was sent, oldest first. */
function requests(invoke: FakeBridge['invoke'], command: CommandName): unknown[] {
  return invoke.mock.calls.filter(([sent]) => sent === command).map(([, request]) => request)
}

function list(name: string): HTMLElement {
  return screen.getByRole('list', { name })
}

/** What a list's rows read as, in order: each row's name. */
function rows(name: string): (string | null)[] {
  return within(list(name))
    .queryAllByRole('listitem')
    .map((row) => row.getAttribute('aria-label'))
}

function row(listName: string, name: string): HTMLElement {
  return within(list(listName)).getByRole('listitem', { name })
}

/** Clicks something and lets what it started (a command, a menu opening) finish. */
async function click(element: HTMLElement): Promise<void> {
  fireEvent.click(element)
  await settleFloating()
}

/** Chooses an access from a folder row's select. */
async function chooseAccess(select: HTMLElement, access: string): Promise<void> {
  await click(select)
  await click(within(screen.getByRole('menu', { name: 'Access' })).getByRole('menuitemradio', { name: access }))
}

/** A command main hasn't answered yet, to answer or refuse by hand. */
function held<Response>(): {
  answer: () => Promise<Response>
  resolve: (response: Response) => void
  reject: (error: unknown) => void
} {
  let resolve: (response: Response) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<Response>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { answer: () => promise, resolve, reject }
}

describe('Settings › Agent › Sandbox', () => {
  it('has the Sandbox group under the task defaults: the switch, then the Glade-wide lists', async () => {
    await renderSettings({ glade: GLADE_GRANTS })

    const group = screen.getByRole('region', { name: 'Sandbox' })
    expect(within(group).getByRole('heading', { level: 3, name: 'Sandbox' })).toBeInTheDocument()
    expect(within(group).getByRole('switch', { name: 'Run agents in a sandbox' })).toBeChecked()
    expect(group).toHaveTextContent('They can use only their workspace and what you allow.')
    expect(group).toHaveTextContent('Folders the agents in every workspace can use, like a toolchain they all need.')
    expect(group).toHaveTextContent(
      'Domains the agents in every workspace can reach, from their commands and web fetches.',
    )
    expect(rows('Glade-wide folders')).toEqual(['~/.nvm', '~/.config/git', '~/.npm'])
    expect(rows('Glade-wide domains')).toEqual(['pypi.org', 'files.pythonhosted.org'])
    expect(group).toHaveTextContent(
      'Each workspace has its own folders and domains too, in its settings under Workspace.',
    )
  })

  it('shows each folder’s access in a select, and a remove button on every row', async () => {
    await renderSettings({ glade: GLADE_GRANTS })

    expect(within(row('Glade-wide folders', '~/.nvm')).getByRole('button', { name: /^Access/ })).toHaveAccessibleName(
      'Access to ~/.nvm: Read-only',
    )
    expect(within(row('Glade-wide folders', '~/.npm')).getByRole('button', { name: /^Access/ })).toHaveAccessibleName(
      'Access to ~/.npm: Read-write',
    )
    for (const name of ['~/.nvm', '~/.config/git', '~/.npm']) {
      expect(within(row('Glade-wide folders', name)).getByRole('button', { name: `Remove ${name}` })).toBeEnabled()
    }
    for (const name of ['pypi.org', 'files.pythonhosted.org']) {
      const domainRow = row('Glade-wide domains', name)
      expect(within(domainRow).getByRole('button', { name: `Remove ${name}` })).toBeEnabled()
      // A domain has no access to choose.
      expect(within(domainRow).queryByRole('button', { name: /^Access/ })).not.toBeInTheDocument()
    }
  })

  it('starts with both lists empty, and says so', async () => {
    const { invoke } = await renderSettings()

    expect(rows('Glade-wide folders')).toEqual([])
    expect(list('Glade-wide folders')).toHaveTextContent('No folders yet.')
    expect(list('Glade-wide domains')).toHaveTextContent('No domains yet.')
    expect(requests(invoke, CommandName.SandboxListGrants)).toEqual([{ target: GLADE }])
  })

  it('says nothing of a list until main has answered, rather than that nothing is granted', async () => {
    const listing = held<SandboxGrantsResponse>()
    await renderSettings({ overrides: { [CommandName.SandboxListGrants]: listing.answer } })

    expect(list('Glade-wide folders')).toHaveAttribute('aria-busy', 'true')
    expect(list('Glade-wide folders')).not.toHaveTextContent('No folders yet.')
    expect(list('Glade-wide domains')).not.toHaveTextContent('No domains yet.')

    await act(async () => {
      listing.resolve({ grants: [domain('pypi.org')] })
      await Promise.resolve()
    })

    expect(list('Glade-wide folders')).toHaveAttribute('aria-busy', 'false')
    expect(list('Glade-wide folders')).toHaveTextContent('No folders yet.')
    expect(rows('Glade-wide domains')).toEqual(['pypi.org'])
  })

  it('says why when the lists can’t be read, and nothing once Settings has closed', async () => {
    const listing = held<SandboxGrantsResponse>()
    const { store } = await renderSettings({ overrides: { [CommandName.SandboxListGrants]: listing.answer } })

    await act(async () => {
      listing.reject(bridgeError(BridgeErrorCode.Internal, 'sandbox.listGrants failed: the database is locked'))
      await Promise.resolve()
    })
    expect(screen.getByRole('alert')).toHaveTextContent('sandbox.listGrants failed: the database is locked')

    // Closed before main answers: nothing is left to say it to.
    const late = held<SandboxGrantsResponse>()
    const closing = await renderSettings({ overrides: { [CommandName.SandboxListGrants]: late.answer } })
    act(() => {
      store.getState().closeSettings()
      closing.store.getState().closeSettings()
    })
    await act(async () => {
      late.reject(bridgeError(BridgeErrorCode.Internal, 'sandbox.listGrants failed: too late'))
      await Promise.resolve()
    })
    expect(screen.queryByText(/too late/)).not.toBeInTheDocument()
  })

  describe('the switch', () => {
    it('turns the sandbox off and on, saving each change at once', async () => {
      const { invoke, store } = await renderSettings()
      const toggle = screen.getByRole('switch', { name: 'Run agents in a sandbox' })

      await click(toggle)
      expect(toggle).not.toBeChecked()
      expect(store.getState().settings.sandboxEnabled).toBe(false)
      await click(toggle)
      expect(toggle).toBeChecked()

      expect(requests(invoke, CommandName.SettingsUpdate)).toEqual([
        { patch: { sandboxEnabled: false } },
        { patch: { sandboxEnabled: true } },
      ])
    })

    it('opens off while that is the setting, as it is until the sandbox is released', async () => {
      await renderSettings({ enabled: DEFAULT_SETTINGS.sandboxEnabled })

      expect(screen.getByRole('switch', { name: 'Run agents in a sandbox' })).not.toBeChecked()
    })

    it('dims and disables both lists while it’s off, keeping what’s granted, and says what off means', async () => {
      const { invoke } = await renderSettings({ enabled: false, glade: GLADE_GRANTS })

      expect(rows('Glade-wide folders')).toEqual(['~/.nvm', '~/.config/git', '~/.npm'])
      expect(rows('Glade-wide domains')).toEqual(['pypi.org', 'files.pythonhosted.org'])
      for (const name of ['Glade-wide folders', 'Glade-wide domains']) {
        expect(list(name).className).toContain('dimmed')
        for (const button of within(list(name)).getAllByRole('button')) expect(button).toBeDisabled()
      }
      expect(screen.getByRole('button', { name: 'Add a Glade-wide folder' })).toBeDisabled()
      expect(screen.getByRole('button', { name: 'Add a Glade-wide domain' })).toBeDisabled()
      const group = screen.getByRole('region', { name: 'Sandbox' })
      expect(group).toHaveTextContent(
        'While the sandbox is off, agents can use any folder and reach any domain, as before. These lists apply again when it’s back on.',
      )
      expect(group).not.toHaveTextContent('Each workspace has its own folders and domains too')
      // The switch itself is never dimmed: it's how you turn it back on.
      expect(screen.getByRole('switch', { name: 'Run agents in a sandbox' })).toBeEnabled()

      // Nothing a disabled control is clicked for reaches main.
      fireEvent.click(within(row('Glade-wide domains', 'pypi.org')).getByRole('button', { name: 'Remove pypi.org' }))
      fireEvent.click(screen.getByRole('button', { name: 'Add a Glade-wide domain' }))
      await settleFloating()
      expect(requests(invoke, CommandName.SandboxRemoveGrant)).toEqual([])
      expect(screen.queryByRole('textbox', { name: 'Domain' })).not.toBeInTheDocument()
    })

    it('undims the lists when it’s turned back on, and puts away a row being added while it’s off', async () => {
      await renderSettings({ glade: GLADE_GRANTS })
      await click(screen.getByRole('button', { name: 'Add a Glade-wide domain' }))
      fireEvent.change(screen.getByRole('textbox', { name: 'Domain' }), { target: { value: 'github.com' } })
      const toggle = screen.getByRole('switch', { name: 'Run agents in a sandbox' })

      await click(toggle)
      expect(list('Glade-wide domains').className).toContain('dimmed')
      expect(screen.queryByRole('textbox', { name: 'Domain' })).not.toBeInTheDocument()

      await click(toggle)
      expect(list('Glade-wide domains').className).not.toContain('dimmed')
      expect(screen.getByRole('button', { name: 'Add a Glade-wide domain' })).toBeEnabled()
      // What was typed is still there.
      expect(screen.getByRole('textbox', { name: 'Domain' })).toHaveValue('github.com')
    })
  })

  describe('adding a folder', () => {
    const picking = (path: string | null): Partial<FakeHandlers> => ({
      [CommandName.DialogChooseFolder]: () => ({ path }),
    })

    it('opens the folder picker, then a row to pick its access, read-only to start, with Add focused', async () => {
      const { invoke } = await renderSettings({ glade: GLADE_GRANTS, overrides: picking('/Users/sam/.cargo') })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))

      expect(requests(invoke, CommandName.DialogChooseFolder)).toHaveLength(1)
      expect(rows('Glade-wide folders')).toEqual(['~/.nvm', '~/.config/git', '~/.npm', 'New folder ~/.cargo'])
      const pending = row('Glade-wide folders', 'New folder ~/.cargo')
      expect(pending.className).toContain('grantPending')
      expect(within(pending).getByText('~/.cargo')).toHaveAttribute('title', '/Users/sam/.cargo')
      expect(within(pending).getByRole('button', { name: 'Access to ~/.cargo: Read-only' })).toBeInTheDocument()
      expect(within(pending).getByRole('button', { name: 'Add' })).toHaveFocus()
      expect(within(pending).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      // Nothing is granted until Add.
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
    })

    it('adds it read-only, closes the row, and gives Add… the focus back', async () => {
      const { invoke, main } = await renderSettings({ overrides: picking('/Users/sam/.cargo') })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      await click(within(row('Glade-wide folders', 'New folder ~/.cargo')).getByRole('button', { name: 'Add' }))

      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([
        { target: GLADE, grant: read('/Users/sam/.cargo') },
      ])
      expect(main.sandboxGrants?.glade).toEqual([read('/Users/sam/.cargo')])
      expect(rows('Glade-wide folders')).toEqual(['~/.cargo'])
      expect(list('Glade-wide folders')).not.toHaveTextContent('No folders yet.')
      expect(
        within(row('Glade-wide folders', '~/.cargo')).getByRole('button', { name: 'Access to ~/.cargo: Read-only' }),
      ).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Add a Glade-wide folder' })).toHaveFocus()
    })

    it('adds it read-write when that’s chosen in the row first', async () => {
      const { invoke } = await renderSettings({ overrides: picking('/Users/sam/.npm') })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      const pending = row('Glade-wide folders', 'New folder ~/.npm')
      await chooseAccess(within(pending).getByRole('button', { name: /^Access/ }), 'Read-write')
      expect(within(pending).getByRole('button', { name: 'Access to ~/.npm: Read-write' })).toBeInTheDocument()
      // Choosing the access grants nothing by itself.
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
      await click(within(pending).getByRole('button', { name: 'Add' }))

      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([
        { target: GLADE, grant: readWrite('/Users/sam/.npm') },
      ])
      expect(
        within(row('Glade-wide folders', '~/.npm')).getByRole('button', { name: 'Access to ~/.npm: Read-write' }),
      ).toBeInTheDocument()
    })

    it('adds nothing when the folder picker is cancelled', async () => {
      const { invoke } = await renderSettings({ overrides: picking(null) })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))

      expect(requests(invoke, CommandName.DialogChooseFolder)).toHaveLength(1)
      expect(rows('Glade-wide folders')).toEqual([])
      expect(list('Glade-wide folders')).toHaveTextContent('No folders yet.')
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('adds nothing on Cancel, and gives Add… the focus back', async () => {
      const { invoke } = await renderSettings({ overrides: picking('/Users/sam/.cargo') })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      await click(within(row('Glade-wide folders', 'New folder ~/.cargo')).getByRole('button', { name: 'Cancel' }))

      expect(rows('Glade-wide folders')).toEqual([])
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
      expect(screen.getByRole('button', { name: 'Add a Glade-wide folder' })).toHaveFocus()
    })

    it('takes another folder when Add… is clicked again, in place of the one waiting', async () => {
      const chooseFolder = vi
        .fn<FakeHandlers[CommandName.DialogChooseFolder]>()
        .mockReturnValueOnce({ path: '/Users/sam/.cargo' })
        .mockReturnValueOnce({ path: '/Users/sam/.rustup' })
        .mockReturnValue({ path: null })
      await renderSettings({ overrides: { [CommandName.DialogChooseFolder]: chooseFolder } })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      expect(rows('Glade-wide folders')).toEqual(['New folder ~/.rustup'])
      expect(
        within(row('Glade-wide folders', 'New folder ~/.rustup')).getByRole('button', { name: 'Add' }),
      ).toHaveFocus()

      // Cancelled the third time, the one waiting stays.
      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      expect(rows('Glade-wide folders')).toEqual(['New folder ~/.rustup'])
    })

    it('says why a duplicate is refused, under the list, and keeps the row open', async () => {
      await renderSettings({ glade: [readWrite('/Users/sam/.npm')], overrides: picking('/Users/sam/.npm') })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      await click(within(row('Glade-wide folders', 'New folder ~/.npm')).getByRole('button', { name: 'Add' }))

      expect(screen.getByRole('alert')).toHaveTextContent(SETTINGS_GRANT_REFUSALS.duplicateFolder)
      expect(screen.getByRole('alert')).not.toHaveTextContent('sandbox.addGrant')
      expect(rows('Glade-wide folders')).toEqual(['~/.npm', 'New folder ~/.npm'])

      // Cancel puts the reason away with the row.
      await click(within(row('Glade-wide folders', 'New folder ~/.npm')).getByRole('button', { name: 'Cancel' }))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      expect(rows('Glade-wide folders')).toEqual(['~/.npm'])
    })

    it('upgrades a folder that’s there read-only when it’s added again read-write, in its place', async () => {
      await renderSettings({
        glade: [read('/Users/sam/.npm'), read('/Users/sam/.nvm')],
        overrides: picking('/Users/sam/.npm'),
      })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      const pending = row('Glade-wide folders', 'New folder ~/.npm')
      await chooseAccess(within(pending).getByRole('button', { name: /^Access/ }), 'Read-write')
      await click(within(pending).getByRole('button', { name: 'Add' }))

      expect(rows('Glade-wide folders')).toEqual(['~/.npm', '~/.nvm'])
      expect(
        within(row('Glade-wide folders', '~/.npm')).getByRole('button', { name: 'Access to ~/.npm: Read-write' }),
      ).toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    })

    it('says why when main refuses the folder, or the picker can’t open', async () => {
      const chooseFolder = vi
        .fn<FakeHandlers[CommandName.DialogChooseFolder]>()
        .mockImplementationOnce(() =>
          refuse(bridgeError(BridgeErrorCode.Internal, 'dialog.chooseFolder failed: no window')),
        )
        .mockReturnValue({ path: '/Users/sam/notes[1]' })
      await renderSettings({
        overrides: {
          [CommandName.DialogChooseFolder]: chooseFolder,
          [CommandName.SandboxAddGrant]: () =>
            refuse(
              bridgeError(
                BridgeErrorCode.InvalidRequest,
                'sandbox.addGrant: Can\'t grant "/Users/sam/notes[1]": a pattern, not a folder',
              ),
            ),
        },
      })

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      expect(screen.getByRole('alert')).toHaveTextContent('dialog.chooseFolder failed: no window')
      expect(rows('Glade-wide folders')).toEqual([])

      await click(screen.getByRole('button', { name: 'Add a Glade-wide folder' }))
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
      await click(within(row('Glade-wide folders', 'New folder ~/notes[1]')).getByRole('button', { name: 'Add' }))
      expect(screen.getByRole('alert')).toHaveTextContent('Can\'t grant "/Users/sam/notes[1]": a pattern, not a folder')
      expect(rows('Glade-wide folders')).toEqual(['New folder ~/notes[1]'])
    })
  })

  describe('adding a domain', () => {
    const openRow = async (): Promise<HTMLElement> => {
      await click(screen.getByRole('button', { name: 'Add a Glade-wide domain' }))
      return screen.getByRole('textbox', { name: 'Domain' })
    }

    it('opens a row with a field, focused, with Add and Cancel', async () => {
      const { invoke } = await renderSettings({ glade: GLADE_GRANTS })

      const field = await openRow()

      expect(rows('Glade-wide domains')).toEqual(['pypi.org', 'files.pythonhosted.org', 'New domain'])
      const pending = row('Glade-wide domains', 'New domain')
      expect(pending.className).toContain('grantPending')
      expect(field).toHaveFocus()
      expect(field).toHaveAttribute('placeholder', 'example.com')
      expect(within(pending).getByRole('button', { name: 'Add' })).toBeInTheDocument()
      expect(within(pending).getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
    })

    it('adds what’s typed with Add, closes the row, and gives Add… the focus back', async () => {
      const { invoke } = await renderSettings()

      fireEvent.change(await openRow(), { target: { value: 'github.com' } })
      await click(within(row('Glade-wide domains', 'New domain')).getByRole('button', { name: 'Add' }))

      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([{ target: GLADE, grant: domain('github.com') }])
      expect(rows('Glade-wide domains')).toEqual(['github.com'])
      expect(list('Glade-wide domains')).not.toHaveTextContent('No domains yet.')
      expect(screen.getByRole('button', { name: 'Add a Glade-wide domain' })).toHaveFocus()
    })

    it('adds with ↵ in the field, and takes a wildcard for every host under a domain', async () => {
      const { invoke } = await renderSettings()

      const field = await openRow()
      fireEvent.change(field, { target: { value: '*.Example.com' } })
      fireEvent.keyDown(field, { key: 'Enter' })
      await settleFloating()

      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([{ target: GLADE, grant: domain('*.Example.com') }])
      // As main keeps it: lower case.
      expect(rows('Glade-wide domains')).toEqual(['*.example.com'])
      // The next one starts from an empty field.
      expect(await openRow()).toHaveValue('')
    })

    it('cancels with Esc in the field, without closing Settings, or with Cancel', async () => {
      const { invoke } = await renderSettings()

      const field = await openRow()
      fireEvent.change(field, { target: { value: 'github.com' } })
      fireEvent.keyDown(field, { key: 'Escape' })
      await settleFloating()

      expect(screen.getByRole('dialog', { name: 'Settings' })).toBeInTheDocument()
      expect(screen.queryByRole('textbox', { name: 'Domain' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Add a Glade-wide domain' })).toHaveFocus()

      await openRow()
      await click(within(row('Glade-wide domains', 'New domain')).getByRole('button', { name: 'Cancel' }))
      expect(rows('Glade-wide domains')).toEqual([])
      expect(list('Glade-wide domains')).toHaveTextContent('No domains yet.')
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
    })

    it('goes back to the open field when Add… is clicked again, keeping what’s typed', async () => {
      await renderSettings()

      const field = await openRow()
      fireEvent.change(field, { target: { value: 'git' } })
      screen.getByRole('button', { name: 'Add a Glade-wide domain' }).focus()
      await click(screen.getByRole('button', { name: 'Add a Glade-wide domain' }))

      expect(rows('Glade-wide domains')).toEqual(['New domain'])
      expect(field).toHaveValue('git')
      expect(field).toHaveFocus()
    })

    it.each(['', '   '])('refuses a blank field (%j) with a reason, without asking main', async (blank) => {
      const { invoke } = await renderSettings()

      const field = await openRow()
      fireEvent.change(field, { target: { value: blank } })
      await click(within(row('Glade-wide domains', 'New domain')).getByRole('button', { name: 'Add' }))

      expect(screen.getByRole('alert')).toHaveTextContent(BLANK_DOMAIN)
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
      expect(field).toHaveFocus()
    })

    it.each(['https://github.com', 'github.com/acme', 'two words', '*.com', 'api.*.example.com'])(
      'says why %j isn’t a domain, under the list, and keeps the row to put it right',
      async (value) => {
        const { invoke } = await renderSettings()

        const field = await openRow()
        fireEvent.change(field, { target: { value } })
        fireEvent.keyDown(field, { key: 'Enter' })
        await settleFloating()

        expect(screen.getByRole('alert')).toHaveTextContent(`Can't grant "${value}": not a domain`)
        expect(screen.getByRole('alert')).not.toHaveTextContent('sandbox.addGrant')
        expect(rows('Glade-wide domains')).toEqual(['New domain'])
        expect(field).toHaveValue(value)
        expect(field).toHaveFocus()

        // Put right, it's added, and the reason goes.
        fireEvent.change(field, { target: { value: 'github.com' } })
        fireEvent.keyDown(field, { key: 'Enter' })
        await settleFloating()
        expect(screen.queryByRole('alert')).not.toBeInTheDocument()
        expect(rows('Glade-wide domains')).toEqual(['github.com'])
        expect(requests(invoke, CommandName.SandboxAddGrant)).toHaveLength(2)
      },
    )

    it('says a domain is already in the list, in whatever case it’s typed', async () => {
      await renderSettings({ glade: [domain('pypi.org')] })

      const field = await openRow()
      fireEvent.change(field, { target: { value: 'PyPI.org' } })
      await click(within(row('Glade-wide domains', 'New domain')).getByRole('button', { name: 'Add' }))

      expect(screen.getByRole('alert')).toHaveTextContent(SETTINGS_GRANT_REFUSALS.duplicateDomain)
      expect(rows('Glade-wide domains')).toEqual(['pypi.org', 'New domain'])
    })

    it('ignores other keys in the field', async () => {
      const { invoke } = await renderSettings()

      const field = await openRow()
      fireEvent.keyDown(field, { key: 'g' })

      expect(screen.getByRole('textbox', { name: 'Domain' })).toBe(field)
      expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([])
    })
  })

  describe('changing and removing', () => {
    it('changes a folder’s access from its select, either way', async () => {
      const { invoke, main } = await renderSettings({ glade: GLADE_GRANTS })

      await chooseAccess(screen.getByRole('button', { name: 'Access to ~/.nvm: Read-only' }), 'Read-write')
      expect(screen.getByRole('button', { name: 'Access to ~/.nvm: Read-write' })).toBeInTheDocument()
      await chooseAccess(screen.getByRole('button', { name: 'Access to ~/.npm: Read-write' }), 'Read-only')
      expect(screen.getByRole('button', { name: 'Access to ~/.npm: Read-only' })).toBeInTheDocument()

      expect(requests(invoke, CommandName.SandboxSetFolderAccess)).toEqual([
        { target: GLADE, path: '/Users/sam/.nvm', access: FolderAccess.ReadWrite },
        { target: GLADE, path: '/Users/sam/.npm', access: FolderAccess.Read },
      ])
      expect(main.sandboxGrants?.glade?.slice(0, 3)).toEqual([
        readWrite('/Users/sam/.nvm'),
        read('/Users/sam/.config/git'),
        read('/Users/sam/.npm'),
      ])
      // The rows keep their places.
      expect(rows('Glade-wide folders')).toEqual(['~/.nvm', '~/.config/git', '~/.npm'])
    })

    it('offers both accesses, with the folder’s own checked', async () => {
      await renderSettings({ glade: GLADE_GRANTS })

      await click(screen.getByRole('button', { name: 'Access to ~/.npm: Read-write' }))

      const options = within(screen.getByRole('menu', { name: 'Access' })).getAllByRole('menuitemradio')
      expect(options.map((option) => [option.textContent, option.getAttribute('aria-checked')])).toEqual([
        ['Read-only', 'false'],
        ['Read-write', 'true'],
      ])
    })

    it('removes a folder or a domain, and gives its list’s Add… the focus', async () => {
      const { invoke } = await renderSettings({ glade: GLADE_GRANTS })

      await click(screen.getByRole('button', { name: 'Remove ~/.config/git' }))
      expect(rows('Glade-wide folders')).toEqual(['~/.nvm', '~/.npm'])
      expect(screen.getByRole('button', { name: 'Add a Glade-wide folder' })).toHaveFocus()

      await click(screen.getByRole('button', { name: 'Remove pypi.org' }))
      expect(rows('Glade-wide domains')).toEqual(['files.pythonhosted.org'])
      expect(screen.getByRole('button', { name: 'Add a Glade-wide domain' })).toHaveFocus()

      expect(requests(invoke, CommandName.SandboxRemoveGrant)).toEqual([
        { target: GLADE, grant: { kind: SandboxGrantKind.Folder, path: '/Users/sam/.config/git' } },
        { target: GLADE, grant: domain('pypi.org') },
      ])
    })

    it('says the lists are empty again once the last of each is removed', async () => {
      await renderSettings({ glade: [read('/Users/sam/.nvm'), domain('pypi.org')] })

      await click(screen.getByRole('button', { name: 'Remove ~/.nvm' }))
      await click(screen.getByRole('button', { name: 'Remove pypi.org' }))

      expect(list('Glade-wide folders')).toHaveTextContent('No folders yet.')
      expect(list('Glade-wide domains')).toHaveTextContent('No domains yet.')
    })

    it('shows a change only once main has saved it, and says why when it couldn’t', async () => {
      const failure = bridgeError(BridgeErrorCode.Internal, 'sandbox.removeGrant failed: the database is locked')
      await renderSettings({
        glade: GLADE_GRANTS,
        overrides: {
          [CommandName.SandboxRemoveGrant]: () => refuse(failure),
          [CommandName.SandboxSetFolderAccess]: () =>
            refuse(bridgeError(BridgeErrorCode.Internal, 'sandbox.setFolderAccess failed: the database is locked')),
        },
      })

      await click(screen.getByRole('button', { name: 'Remove pypi.org' }))
      expect(rows('Glade-wide domains')).toEqual(['pypi.org', 'files.pythonhosted.org'])
      expect(screen.getByRole('alert')).toHaveTextContent('sandbox.removeGrant failed: the database is locked')

      await click(screen.getByRole('button', { name: 'Remove ~/.nvm' }))
      expect(rows('Glade-wide folders')).toEqual(['~/.nvm', '~/.config/git', '~/.npm'])
      await chooseAccess(screen.getByRole('button', { name: 'Access to ~/.nvm: Read-only' }), 'Read-write')
      expect(screen.getByRole('button', { name: 'Access to ~/.nvm: Read-only' })).toBeInTheDocument()
      expect(
        screen.getAllByRole('alert').some((alert) => alert.textContent.includes('sandbox.setFolderAccess failed')),
      ).toBe(true)
    })
  })

  describe('long and many', () => {
    it('shows a long path on one line, whole on hover', async () => {
      const deep = `/Users/sam/${Array.from({ length: 30 }, (_, index) => `level-${String(index)}`).join('/')}`
      await renderSettings({ glade: [read(deep)] })

      const shown = deep.replace('/Users/sam', '~')
      const value = within(row('Glade-wide folders', shown)).getByText(shown)
      expect(value).toHaveAttribute('title', deep)
      expect(value.className).toContain('grantValue')
    })

    it('lists hundreds of rows in order, and changes one without losing the rest', async () => {
      const folders = Array.from({ length: 150 }, (_, index) => read(`/Users/sam/tools/tool-${String(index)}`))
      const domains = Array.from({ length: 150 }, (_, index) => domain(`host-${String(index)}.example.com`))
      const { invoke } = await renderSettings({ glade: [...folders, ...domains] })
      // By label, not role: working out every button's role and name among hundreds is slow in jsdom.
      const labels = (name: string): (string | null)[] =>
        Array.from(list(name).children, (item) => item.getAttribute('aria-label'))

      expect(labels('Glade-wide folders')).toEqual(folders.map((_, index) => `~/tools/tool-${String(index)}`))
      expect(labels('Glade-wide domains')).toEqual(domains.map((_, index) => `host-${String(index)}.example.com`))

      await click(screen.getByLabelText('Remove host-75.example.com'))
      await click(screen.getByLabelText('Access to ~/tools/tool-149: Read-only'))
      await click(screen.getByText('Read-write', { selector: '[role="menuitemradio"] *, [role="menuitemradio"]' }))

      expect(labels('Glade-wide domains')).toHaveLength(149)
      expect(labels('Glade-wide domains')).not.toContain('host-75.example.com')
      expect(screen.getByLabelText('Access to ~/tools/tool-149: Read-write')).toBeInTheDocument()
      expect(labels('Glade-wide folders')).toHaveLength(150)
      expect(requests(invoke, CommandName.SandboxSetFolderAccess)).toEqual([
        { target: GLADE, path: '/Users/sam/tools/tool-149', access: FolderAccess.ReadWrite },
      ])
      // Three hundred rows take jsdom a second or two, and several times that on a loaded machine.
    }, 30_000)
  })

  it('follows main’s broadcasts of the Glade-wide grants, and leaves a workspace’s out', async () => {
    const { emit } = await renderSettings({ glade: [domain('pypi.org')] })

    act(() => {
      emit({ type: EventType.SandboxGrantsChanged, target: WORKSPACE, grants: [domain('github.com')] })
      emit({
        type: EventType.SandboxGrantsChanged,
        target: GLADE,
        grants: [domain('pypi.org'), read('/Users/sam/.nvm')],
      })
    })

    expect(rows('Glade-wide folders')).toEqual(['~/.nvm'])
    expect(rows('Glade-wide domains')).toEqual(['pypi.org'])
  })
})

describe('Settings › Workspace › Sandbox', () => {
  it('has the Sandbox group under Name and Root folder, saying what it’s for', async () => {
    await renderSettings({ section: SettingsSection.Workspace, workspace: WORKSPACE_GRANTS })

    const group = screen.getByRole('region', { name: 'Sandbox' })
    expect(group).toHaveTextContent(
      'What this workspace’s agents can use, on top of the Glade-wide folders and domains in Agent. Allow for this workspace, on a permission card, adds here.',
    )
    expect(group).toHaveTextContent('The workspace root, then the folders you’ve allowed.')
    expect(group).toHaveTextContent('The domains you’ve allowed.')
    expect(screen.getByText(/and what its agents may use/)).toBeInTheDocument()
    // The switch is Agent's alone.
    expect(screen.queryByRole('switch', { name: 'Run agents in a sandbox' })).not.toBeInTheDocument()
  })

  it('lists the root first, read-write and fixed, then the granted folders, then the domains', async () => {
    const { invoke } = await renderSettings({ section: SettingsSection.Workspace, workspace: WORKSPACE_GRANTS })

    expect(requests(invoke, CommandName.SandboxListGrants)).toEqual([{ target: WORKSPACE }])
    expect(rows('Folders')).toEqual(['~/code/api', '~/code/acme-shared', '~/code/acme-web/src/api'])
    expect(rows('Domains')).toEqual(['github.com', 'api.stripe.com'])
    const root = row('Folders', '~/code/api')
    expect(root).toHaveTextContent('Workspace root')
    expect(root).toHaveTextContent('Read-write')
    // Nothing to change or remove on the root.
    expect(within(root).queryAllByRole('button')).toEqual([])
    expect(
      within(row('Folders', '~/code/acme-shared')).getByRole('button', {
        name: 'Access to ~/code/acme-shared: Read-only',
      }),
    ).toBeInTheDocument()
    expect(
      within(row('Folders', '~/code/acme-web/src/api')).getByRole('button', {
        name: 'Remove ~/code/acme-web/src/api',
      }),
    ).toBeInTheDocument()
  })

  it('shows the root alone, before the grants are read and with none', async () => {
    const listing = held<SandboxGrantsResponse>()
    await renderSettings({
      section: SettingsSection.Workspace,
      overrides: { [CommandName.SandboxListGrants]: listing.answer },
    })
    expect(rows('Folders')).toEqual(['~/code/api'])

    await act(async () => {
      listing.resolve({ grants: [] })
      await Promise.resolve()
    })

    expect(rows('Folders')).toEqual(['~/code/api'])
    expect(list('Folders')).not.toHaveTextContent('No folders yet.')
    expect(list('Domains')).toHaveTextContent('No domains yet.')
  })

  it('adds, changes and removes in the workspace’s own lists, leaving the Glade-wide ones alone', async () => {
    const { invoke, main } = await renderSettings({
      section: SettingsSection.Workspace,
      glade: GLADE_GRANTS,
      overrides: { [CommandName.DialogChooseFolder]: () => ({ path: '/Users/sam/code/acme-shared' }) },
    })

    await click(screen.getByRole('button', { name: 'Add a folder' }))
    const pending = row('Folders', 'New folder ~/code/acme-shared')
    await chooseAccess(within(pending).getByRole('button', { name: /^Access/ }), 'Read-write')
    await click(within(pending).getByRole('button', { name: 'Add' }))
    await click(screen.getByRole('button', { name: 'Add a domain' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Domain' }), { target: { value: 'github.com' } })
    await click(within(row('Domains', 'New domain')).getByRole('button', { name: 'Add' }))

    expect(rows('Folders')).toEqual(['~/code/api', '~/code/acme-shared'])
    expect(rows('Domains')).toEqual(['github.com'])
    expect(requests(invoke, CommandName.SandboxAddGrant)).toEqual([
      { target: WORKSPACE, grant: readWrite('/Users/sam/code/acme-shared') },
      { target: WORKSPACE, grant: domain('github.com') },
    ])

    await chooseAccess(screen.getByRole('button', { name: 'Access to ~/code/acme-shared: Read-write' }), 'Read-only')
    expect(requests(invoke, CommandName.SandboxSetFolderAccess)).toEqual([
      { target: WORKSPACE, path: '/Users/sam/code/acme-shared', access: FolderAccess.Read },
    ])
    expect(main.sandboxGrants?.['workspace:w1']).toEqual([read('/Users/sam/code/acme-shared'), domain('github.com')])

    await click(screen.getByRole('button', { name: 'Remove ~/code/acme-shared' }))
    await click(screen.getByRole('button', { name: 'Remove github.com' }))
    expect(rows('Folders')).toEqual(['~/code/api'])
    expect(rows('Domains')).toEqual([])
    expect(main.sandboxGrants?.glade).toEqual(GLADE_GRANTS)
  })

  it.each([
    ['the root itself', ROOT, SETTINGS_GRANT_REFUSALS.workspaceRoot],
    ['a folder inside the root', `${ROOT}/packages/api`, SETTINGS_GRANT_REFUSALS.insideWorkspaceRoot],
  ])('says why %s is refused: its agents can already use it', async (_, path, reason) => {
    const { main } = await renderSettings({
      section: SettingsSection.Workspace,
      overrides: { [CommandName.DialogChooseFolder]: () => ({ path }) },
    })

    await click(screen.getByRole('button', { name: 'Add a folder' }))
    await click(within(list('Folders')).getByRole('button', { name: 'Add' }))

    expect(screen.getByRole('alert')).toHaveTextContent(reason)
    expect(main.sandboxGrants?.['workspace:w1']).toEqual([])
    expect(rows('Folders')).toHaveLength(2)
  })

  it('shows a grant made on a permission card while it’s open: main’s broadcast for this workspace', async () => {
    const { emit, store } = await renderSettings({ section: SettingsSection.Workspace, workspace: [] })
    expect(rows('Folders')).toEqual(['~/code/api'])

    act(() => {
      // Allow for this workspace, on a card in one of its tasks.
      emit({
        type: EventType.SandboxGrantsChanged,
        target: WORKSPACE,
        grants: [readWrite('/Users/sam/code/acme-web'), domain('registry.npmjs.org')],
      })
      // Another workspace's, and the Glade-wide ones, aren't this list's.
      emit({
        type: EventType.SandboxGrantsChanged,
        target: { scope: SandboxGrantScope.Workspace, workspaceId: 'w2' },
        grants: [domain('other.example.com')],
      })
      emit({ type: EventType.SandboxGrantsChanged, target: GLADE, grants: [domain('pypi.org')] })
    })

    expect(rows('Folders')).toEqual(['~/code/api', '~/code/acme-web'])
    expect(screen.getByRole('button', { name: 'Access to ~/code/acme-web: Read-write' })).toBeInTheDocument()
    expect(rows('Domains')).toEqual(['registry.npmjs.org'])
    // Kept for when their own lists open.
    expect(store.getState().sandboxGrants).toEqual({
      'workspace:w1': [readWrite('/Users/sam/code/acme-web'), domain('registry.npmjs.org')],
      'workspace:w2': [domain('other.example.com')],
      glade: [domain('pypi.org')],
    })
  })

  it('takes a card’s grant that lands while a row is being added, keeping the row', async () => {
    const { emit } = await renderSettings({ section: SettingsSection.Workspace })
    await click(screen.getByRole('button', { name: 'Add a domain' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Domain' }), { target: { value: 'github.c' } })

    act(() => {
      emit({ type: EventType.SandboxGrantsChanged, target: WORKSPACE, grants: [domain('registry.npmjs.org')] })
    })

    expect(rows('Domains')).toEqual(['registry.npmjs.org', 'New domain'])
    expect(screen.getByRole('textbox', { name: 'Domain' })).toHaveValue('github.c')
  })

  it('dims and disables its lists too while the sandbox is off, the root included, and says where to turn it on', async () => {
    await renderSettings({ section: SettingsSection.Workspace, enabled: false, workspace: WORKSPACE_GRANTS })

    expect(rows('Folders')).toEqual(['~/code/api', '~/code/acme-shared', '~/code/acme-web/src/api'])
    for (const name of ['Folders', 'Domains']) {
      expect(list(name).className).toContain('dimmed')
      for (const button of within(list(name)).getAllByRole('button')) expect(button).toBeDisabled()
    }
    expect(screen.getByRole('button', { name: 'Add a folder' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add a domain' })).toBeDisabled()
    expect(screen.getByRole('region', { name: 'Sandbox' })).toHaveTextContent(
      'The sandbox is off in Agent, so these are dimmed too. They apply again when it’s back on.',
    )
    // The rest of the section still works.
    expect(screen.getByRole('textbox', { name: 'Workspace name' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Change…' })).toBeEnabled()
  })

  it('has no note under its lists while the sandbox is on', async () => {
    await renderSettings({ section: SettingsSection.Workspace })

    const group = screen.getByRole('region', { name: 'Sandbox' })
    expect(group).not.toHaveTextContent('The sandbox is off')
    expect(group).not.toHaveTextContent('Each workspace has its own folders and domains too')
  })

  it('follows the root when the workspace moves', async () => {
    await renderSettings({
      section: SettingsSection.Workspace,
      overrides: { [CommandName.DialogChooseFolder]: () => ({ path: '/Users/sam/code/acme' }) },
    })

    await click(screen.getByRole('button', { name: 'Change…' }))

    expect(rows('Folders')).toEqual(['~/code/acme'])
  })
})

describe('grantFailureMessage', () => {
  it('gives main’s reason alone for a refused grant, and the whole failure for anything else', () => {
    expect(
      grantFailureMessage(
        bridgeError(BridgeErrorCode.InvalidRequest, 'sandbox.addGrant: That folder is already in the list.'),
      ),
    ).toBe('That folder is already in the list.')
    expect(
      grantFailureMessage(
        bridgeError(BridgeErrorCode.InvalidRequest, 'sandbox.removeGrant: Can\'t grant "/": the whole disk'),
      ),
    ).toBe('Can\'t grant "/": the whole disk')
    // A reason that names a command of its own keeps it.
    expect(grantFailureMessage(bridgeError(BridgeErrorCode.InvalidRequest, 'Use sandbox.addGrant: please'))).toBe(
      'Use sandbox.addGrant: please',
    )
    expect(grantFailureMessage(bridgeError(BridgeErrorCode.NotFound, 'sandbox.listGrants: No workspace w9'))).toBe(
      'sandbox.listGrants: No workspace w9',
    )
    expect(grantFailureMessage(new Error('The window is gone'))).toBe('The window is gone')
    expect(grantFailureMessage('offline')).toBe('offline')
  })
})
