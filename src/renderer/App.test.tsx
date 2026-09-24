import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../shared/bridge'
import type { Workspace } from '../shared/domain'
import { App } from './App'
import { GladeStoreProvider } from './store/react'
import { createGladeStore, type GladeStore } from './store/store'
import { fakeBridge, refuse, sampleWorkspace, type FakeHandlers } from './store/test-bridge'

async function renderApp(workspaces: Workspace[], overrides: Partial<FakeHandlers> = {}): Promise<GladeStore> {
  const store = createGladeStore(fakeBridge({ workspaces, tasks: [], uiState: [] }, overrides).bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return store
}

it('shows a loading state until the store has loaded', () => {
  const store = createGladeStore(fakeBridge({ workspaces: [], tasks: [], uiState: [] }).bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )

  expect(screen.getByRole('main')).toHaveTextContent('Loading…')
  expect(screen.getByRole('main')).toHaveAttribute('aria-busy', 'true')
  expect(screen.queryByRole('navigation')).toBeNull()
})

it('shows the first-run screen when there is no workspace', async () => {
  await renderApp([])

  const sidebar = screen.getByRole('navigation', { name: 'Tasks' })
  expect(within(sidebar).getByRole('region', { name: 'Workspace' })).toHaveTextContent(
    'No workspaceOpen a folder to begin',
  )
  expect(sidebar).toHaveTextContent('Tasks will appear here once you open a workspace.')
  expect(screen.getByRole('main', { name: 'Welcome' })).toBeInTheDocument()
  expect(screen.queryByRole('main', { name: 'Task' })).toBeNull()
  expect(screen.getByRole('region', { name: 'Terminal' })).toBeInTheDocument()
})

it('lands in the empty workspace once a folder is chosen', async () => {
  await renderApp([], { [CommandName.DialogChooseFolder]: () => ({ path: '/Users/sam/code/acme-api' }) })

  fireEvent.click(screen.getByRole('button', { name: 'Open folder…' }))

  expect(await screen.findByRole('main', { name: 'Task' })).toBeInTheDocument()
  expect(screen.queryByRole('main', { name: 'Welcome' })).toBeNull()
  const sidebar = screen.getByRole('navigation', { name: 'Tasks' })
  expect(within(sidebar).getByRole('region', { name: 'Workspace' })).toHaveTextContent('Acme API~/code/acme-api')
  expect(sidebar).not.toHaveTextContent('Tasks will appear here')
})

it('renders the window layout with the workspace, the chat, and a placeholder in each other region', async () => {
  await renderApp([sampleWorkspace('w1')])

  expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('Acme API/code/w1')
  const sidebar = screen.getByRole('navigation', { name: 'Tasks' })
  expect(within(sidebar).getByRole('searchbox', { name: 'Search tasks' })).toBeInTheDocument()
  expect(within(sidebar).getByRole('region', { name: 'Active' })).toHaveTextContent('Active0')

  const main = screen.getByRole('main', { name: 'Task' })
  expect(within(main).getByRole('region', { name: 'Task header' })).toHaveTextContent('Task header')
  expect(
    within(within(main).getByRole('region', { name: 'Chat' })).getByRole('log', { name: 'Conversation' }),
  ).toBeInTheDocument()
  expect(within(main).getByTestId('input-bar')).toHaveTextContent('Input bar')

  const panel = within(main).getByRole('complementary', { name: 'Task panel' })
  expect(panel).toHaveTextContent('Tabs')
  expect(panel).toHaveTextContent('Right panel')

  const terminal = screen.getByRole('region', { name: 'Terminal' })
  expect(terminal).toHaveTextContent('Terminal tabs')
  expect(within(terminal).getByText('Terminal')).toBeInTheDocument()
})

it('says why when the store could not load', async () => {
  await renderApp([], {
    [CommandName.WorkspacesList]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk full')),
  })

  expect(screen.getByRole('main')).toHaveTextContent('Glade couldn’t load: disk full')
  expect(screen.queryByRole('navigation')).toBeNull()
})
