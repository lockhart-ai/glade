import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, refuse, type FakeBridge, type FakeHandlers } from '../store/test-bridge'
import { FirstRun } from './FirstRun'

interface Rendered {
  store: GladeStore
  fake: FakeBridge
}

async function renderFirstRun(overrides: Partial<FakeHandlers> = {}): Promise<Rendered> {
  const fake = fakeBridge({ workspaces: [], tasks: [], uiState: [] }, overrides)
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <FirstRun />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { store, fake }
}

const chosen = { [CommandName.DialogChooseFolder]: () => ({ path: '/code/acme-api' }) }

it('welcomes the user with the Glade mark', async () => {
  await renderFirstRun()

  const main = screen.getByRole('main', { name: 'Welcome' })
  expect(main).toHaveTextContent('Welcome to Glade')
  expect(main).toHaveTextContent('A workspace is a folder you point Glade at. Every task runs inside it.')
  expect(main).toHaveTextContent('Add more workspaces later from the Workspace menu.')
  expect(main.querySelector('img')).toHaveAttribute('alt', '')
})

describe.each(['Open folder…', 'Create a new folder…'])('%s', (label) => {
  it('adds the chosen folder as a workspace and opens it', async () => {
    const { store, fake } = await renderFirstRun(chosen)

    fireEvent.click(screen.getByRole('button', { name: label }))

    await waitFor(() => {
      expect(store.getState().selectedWorkspaceId).toBe('w1')
    })
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.DialogChooseFolder, {})
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.WorkspacesCreate, { rootPath: '/code/acme-api' })
    expect(store.getState().workspaces).toHaveLength(1)
  })

  it('does nothing when the dialog is cancelled', async () => {
    const { store, fake } = await renderFirstRun()

    fireEvent.click(screen.getByRole('button', { name: label }))

    await waitFor(() => {
      expect(fake.invoke).toHaveBeenCalledWith(CommandName.DialogChooseFolder, {})
    })
    expect(fake.invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesCreate, expect.anything())
    expect(store.getState().workspaces).toHaveLength(0)
    expect(screen.getByRole('region', { name: 'Notifications' })).toBeEmptyDOMElement()
  })
})

it('shows why in a toast when the folder is not a valid root', async () => {
  const { store } = await renderFirstRun({
    ...chosen,
    [CommandName.WorkspacesCreate]: () =>
      refuse(bridgeError(BridgeErrorCode.InvalidRootPath, '/code/acme-api is not a folder')),
  })

  fireEvent.click(screen.getByRole('button', { name: 'Open folder…' }))

  expect(await screen.findByText('/code/acme-api is not a folder')).toBeInTheDocument()
  expect(store.getState().workspaces).toHaveLength(0)
  expect(screen.getByRole('main', { name: 'Welcome' })).toBeInTheDocument()
})
