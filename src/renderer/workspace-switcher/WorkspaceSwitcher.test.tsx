import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TaskActivity, UiStateKey, type Task } from '../../shared/domain'
import { ToastProvider } from '../components'
import { settleFloating } from '../components/settleFloating'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { SettingsSection } from '../settings/sections'
import { WorkspaceSwitcher } from './WorkspaceSwitcher'

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly revealedWorkspaces: string[]
}

function working(id: string, workspaceId: string): Task {
  return { ...sampleTask(id, workspaceId), activity: TaskActivity.Working, sessionId: 's' }
}

async function renderSwitcher(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const revealedWorkspaces: string[] = []
  const fake = fakeBridge(
    {
      workspaces: [
        sampleWorkspace('w1', 'Acme API'),
        sampleWorkspace('w2', 'Glade'),
        sampleWorkspace('w3', 'Dotfiles'),
      ],
      tasks: [
        working('t1', 'w1'),
        working('t2', 'w1'),
        working('t3', 'w1'),
        { ...working('t4', 'w2'), activity: TaskActivity.Waiting },
      ],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      workspaceSelections: { w2: 't4' },
      revealedWorkspaces,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <WorkspaceSwitcher />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, revealedWorkspaces }
}

function trigger(): HTMLElement {
  // While the menu is open, it's modal: the rest of the window is hidden from assistive technology.
  return screen.getByRole('button', { name: 'Switch workspace', hidden: true })
}

async function openSwitcher(): Promise<HTMLElement> {
  fireEvent.click(trigger())
  await settleFloating()
  return screen.getByRole('menu', { name: 'Workspaces' })
}

async function choose(name: string): Promise<void> {
  const menu = await openSwitcher()
  fireEvent.click(within(menu).getByRole('menuitem', { name: (accessible) => accessible.startsWith(name) }))
  await act(() => Promise.resolve())
}

describe('WorkspaceSwitcher', () => {
  it('shows the shown workspace in the header, closed until clicked', async () => {
    await renderSwitcher()

    expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('AAcme API/code/w1')
    expect(trigger()).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('lists every workspace, oldest first, with its badge, root and status, and a check on the shown one', async () => {
    await renderSwitcher()

    const menu = await openSwitcher()

    expect(trigger()).toHaveAttribute('aria-expanded', 'true')
    expect(within(menu).getByText('Workspaces')).toBeInTheDocument()
    const rows = within(menu).getAllByRole('menuitemradio')
    expect(rows.map((row) => row.textContent)).toEqual([
      'AAcme API/code/w13 active',
      'GGlade/code/w21 needs you',
      'DDotfiles/code/w3idle',
    ])
    expect(rows.map((row) => row.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false'])
    expect(rows[0]?.querySelector('svg')).not.toBeNull()
    expect(rows[1]?.querySelector('svg')).toBeNull()
    expect(rows.map((row) => row.querySelector('[data-tone]')?.getAttribute('data-tone'))).toEqual([
      'blue',
      'purple',
      'teal',
    ])
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['New workspace…⌘⇧N', 'Open folder as workspace…⌘O', 'Workspace settings…⌘,', 'Reveal root in Finder'])
  })

  it('keeps the statuses current as tasks change in the background', async () => {
    const { emit } = await renderSwitcher()
    const menu = await openSwitcher()

    act(() => {
      emit({ type: EventType.TaskUpdated, task: { ...working('t5', 'w3'), activity: TaskActivity.Waiting } })
    })

    expect(within(menu).getByRole('menuitemradio', { name: 'Dotfiles' })).toHaveTextContent('1 needs you')
  })

  it('switches to a workspace, restoring its selection, and closes', async () => {
    const { store, invoke } = await renderSwitcher()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Glade' }))

    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't4' })
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesOpen, { id: 'w2' })
    expect(screen.queryByRole('menu')).toBeNull()
    expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('GGlade/code/w2')
  })

  it('does nothing when choosing the shown workspace', async () => {
    const { invoke } = await renderSwitcher()
    const menu = await openSwitcher()

    fireEvent.click(within(menu).getByRole('menuitemradio', { name: 'Acme API' }))
    await act(() => Promise.resolve())

    expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesOpen, expect.anything())
  })

  it('closes when the header is clicked again', async () => {
    await renderSwitcher()
    await openSwitcher()

    fireEvent.click(trigger())

    expect(screen.queryByRole('menu')).toBeNull()
  })

  it.each(['New workspace…', 'Open folder as workspace…'])(
    '%s adds the chosen folder as a workspace and opens it',
    async (action) => {
      const { store } = await renderSwitcher({ [CommandName.DialogChooseFolder]: () => ({ path: '/code/blog' }) })

      await choose(action)

      await vi.waitFor(() => {
        expect(store.getState().selectedWorkspaceId).toBe('w4')
      })
      expect(store.getState().workspaces.map(({ rootPath }) => rootPath)).toContain('/code/blog')
    },
  )

  it('opens Settings at the workspace', async () => {
    const { store } = await renderSwitcher()

    await choose('Workspace settings…')

    expect(store.getState().settingsSection).toBe(SettingsSection.Workspace)
  })

  it('reveals the shown workspace’s root in Finder', async () => {
    const { revealedWorkspaces } = await renderSwitcher()

    await choose('Reveal root in Finder')

    expect(revealedWorkspaces).toEqual(['w1'])
  })

  it('shows a toast when an action fails', async () => {
    await renderSwitcher({
      [CommandName.WorkspacesReveal]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w1')),
    })

    await choose('Reveal root in Finder')

    expect(await screen.findByText('No workspace w1')).toBeInTheDocument()
  })
})
