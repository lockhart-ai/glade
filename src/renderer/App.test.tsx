import { act, render, screen, within } from '@testing-library/react'
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

it('shows a loading state until the store has loaded, then the window layout', async () => {
  const store = renderApp()
  expect(screen.getByRole('main')).toHaveTextContent('Loading…')
  expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByRole('navigation')).toBeNull()

  await act(() => store.getState().hydrate())

  expect(screen.getByRole('main', { name: 'Task' })).not.toHaveAttribute('aria-busy')
})

it('renders the window layout with a placeholder in each region', async () => {
  const store = renderApp()
  await act(() => store.getState().hydrate())

  expect(screen.getByRole('navigation', { name: 'Tasks' })).toHaveTextContent('Sidebar')

  const main = screen.getByRole('main', { name: 'Task' })
  expect(within(main).getByRole('region', { name: 'Task header' })).toHaveTextContent('Task header')
  expect(within(main).getByRole('region', { name: 'Chat' })).toHaveTextContent('Chat')
  expect(within(main).getByTestId('input-bar')).toHaveTextContent('Input bar')

  const panel = within(main).getByRole('complementary', { name: 'Task panel' })
  expect(panel).toHaveTextContent('Tabs')
  expect(panel).toHaveTextContent('Right panel')

  const terminal = screen.getByRole('region', { name: 'Terminal' })
  expect(terminal).toHaveTextContent('Terminal tabs')
  expect(within(terminal).getByText('Terminal')).toBeInTheDocument()
})

it('says why when the store could not load', async () => {
  const store = renderApp({
    [CommandName.WorkspacesList]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk full')),
  })

  await act(() => store.getState().hydrate())

  expect(screen.getByRole('main')).toHaveTextContent('Glade couldn’t load: disk full')
  expect(screen.queryByRole('navigation')).toBeNull()
})
