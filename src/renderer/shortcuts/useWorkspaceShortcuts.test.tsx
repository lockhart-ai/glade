import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { ToastProvider } from '../components'
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
import { useWorkspaceShortcuts } from './useWorkspaceShortcuts'

function Harness(): React.JSX.Element {
  useWorkspaceShortcuts()
  return <textarea aria-label="Message the agent" />
}

interface Rendered extends FakeBridge {
  readonly store: GladeStore
  readonly unmount: () => void
}

async function renderShortcuts(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2', 'Glade'), sampleWorkspace('w3', 'Dotfiles')],
      tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w2')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      workspaceSelections: { w2: 't2' },
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  const { unmount } = render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <Harness />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { ...fake, store, unmount }
}

/** Presses a key with ⌘ (and whatever else `init` adds) in the window; false when the app took the key. */
function pressCommand(key: string, init: KeyboardEventInit = {}): boolean {
  return fireEvent.keyDown(window, { key, metaKey: true, ...init })
}

describe('⌘1 – ⌘9', () => {
  it('switch to the nth workspace, oldest first, restoring its selection, from anywhere', async () => {
    const { store } = await renderShortcuts()
    screen.getByRole('textbox', { name: 'Message the agent' }).focus()

    expect(pressCommand('2')).toBe(false)

    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't2' })
    })
    pressCommand('3')
    await vi.waitFor(() => {
      expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w3', selectedTaskId: null })
    })
  })

  it('do nothing for the shown workspace or past the last one, but still take the key', async () => {
    const { invoke } = await renderShortcuts()

    expect(pressCommand('1')).toBe(false)
    expect(pressCommand('9')).toBe(false)
    await act(() => Promise.resolve())

    expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesOpen, expect.anything())
  })

  it.each([
    ['1 alone', '1', { metaKey: false }],
    ['⌥⌘1, the right panel’s', '1', { altKey: true }],
    ['⌃⌘2', '2', { ctrlKey: true }],
    ['⇧⌘2', '2', { shiftKey: true }],
    ['⌘0', '0', {}],
  ])('ignore %s', async (_, key, init) => {
    const { invoke } = await renderShortcuts()

    expect(pressCommand(key, init)).toBe(true)
    await act(() => Promise.resolve())
    expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesOpen, expect.anything())
  })

  it('show a toast when the workspace can’t be opened', async () => {
    await renderShortcuts({
      [CommandName.WorkspacesOpen]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w2')),
    })

    pressCommand('2')

    expect(await screen.findByText('No workspace w2')).toBeInTheDocument()
  })
})

describe('⌘⇧N and ⌘O', () => {
  it.each([
    ['⌘⇧N', 'N', { shiftKey: true }],
    ['⌘O', 'o', {}],
  ])('%s chooses a folder and opens it as a workspace', async (_, key, init) => {
    const { store, invoke } = await renderShortcuts({
      [CommandName.DialogChooseFolder]: () => ({ path: '/code/blog' }),
    })

    expect(pressCommand(key, init)).toBe(false)

    await vi.waitFor(() => {
      expect(store.getState().selectedWorkspaceId).toBe('w4')
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesCreate, { rootPath: '/code/blog' })
  })

  it('add nothing when the dialog is cancelled', async () => {
    const { invoke } = await renderShortcuts()

    pressCommand('o')
    await act(() => Promise.resolve())

    expect(invoke).toHaveBeenCalledWith(CommandName.DialogChooseFolder, {})
    expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesCreate, expect.anything())
  })

  it.each([
    ['⌘N, a new task', 'n', {}],
    ['⌘⇧O', 'O', { shiftKey: true }],
    ['⌥⌘O', 'o', { altKey: true }],
    ['⌃⌘⇧N', 'N', { shiftKey: true, ctrlKey: true }],
  ])('ignore %s', async (_, key, init) => {
    const { invoke } = await renderShortcuts()

    expect(pressCommand(key, init)).toBe(true)
    expect(invoke).not.toHaveBeenCalledWith(CommandName.DialogChooseFolder, expect.anything())
  })

  it('show a toast when the folder can’t be added', async () => {
    await renderShortcuts({
      [CommandName.DialogChooseFolder]: () => ({ path: '/code/blog' }),
      [CommandName.WorkspacesCreate]: () =>
        refuse(bridgeError(BridgeErrorCode.InvalidRootPath, '/code/blog is not a folder')),
    })

    pressCommand('o')

    expect(await screen.findByText('/code/blog is not a folder')).toBeInTheDocument()
  })
})

it('stops listening once unmounted', async () => {
  const { invoke, unmount } = await renderShortcuts()
  unmount()

  pressCommand('2')
  pressCommand('o')

  expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesOpen, expect.anything())
  expect(invoke).not.toHaveBeenCalledWith(CommandName.DialogChooseFolder, expect.anything())
})
