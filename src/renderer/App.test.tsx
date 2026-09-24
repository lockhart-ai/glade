import { act, render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../shared/bridge'
import { App } from './App'
import { GladeStoreProvider } from './store/react'
import { createGladeStore, type GladeStore } from './store/store'
import { fakeBridge, refuse, type FakeHandlers } from './store/test-bridge'

function renderApp(overrides: Partial<FakeHandlers> = {}): GladeStore {
  const store = createGladeStore(fakeBridge({ workspaces: [], tasks: [], uiState: [] }, overrides).bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  return store
}

it('shows a loading state until the store has loaded, then the placeholder', async () => {
  const store = renderApp()
  expect(screen.getByRole('main')).toHaveTextContent('Loading…')
  expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')

  await act(() => store.getState().hydrate())

  expect(screen.getByRole('main')).toHaveTextContent('Glade')
  expect(screen.getByRole('main')).not.toHaveAttribute('aria-busy')
})

it('says why when the store could not load', async () => {
  const store = renderApp({
    [CommandName.WorkspacesList]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk full')),
  })

  await act(() => store.getState().hydrate())

  expect(screen.getByRole('main')).toHaveTextContent('Glade couldn’t load: disk full')
})
