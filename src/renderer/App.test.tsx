import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../shared/bridge'
import { UiStateKey, type Workspace } from '../shared/domain'
import { App } from './App'
import { GladeStoreProvider } from './store/react'
import { createGladeStore, type GladeStore } from './store/store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeHandlers } from './store/test-bridge'

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
  // With no task selected there is no task header.
  await renderApp([sampleWorkspace('w1')])

  expect(screen.getByRole('region', { name: 'Workspace' })).toHaveTextContent('Acme API/code/w1')
  const sidebar = screen.getByRole('navigation', { name: 'Tasks' })
  expect(within(sidebar).getByRole('searchbox', { name: 'Search tasks' })).toBeInTheDocument()
  expect(within(sidebar).getByRole('region', { name: 'Active' })).toHaveTextContent('Active0')

  const main = screen.getByRole('main', { name: 'Task' })
  expect(within(main).queryByRole('region', { name: 'Task header' })).toBeNull()
  expect(
    within(within(main).getByRole('region', { name: 'Chat' })).getByRole('log', { name: 'Conversation' }),
  ).toBeInTheDocument()
  // No task is selected, so the input bar is empty but for the toasts, which stand above it.
  const inputBar = within(main).getByTestId('input-bar')
  expect(inputBar).toHaveTextContent(/^$/)
  expect(within(inputBar).queryByRole('textbox')).toBeNull()
  expect(within(inputBar).getByRole('region', { name: 'Notifications' })).toBeInTheDocument()

  const panel = within(main).getByRole('complementary', { name: 'Task panel' })
  expect(within(panel).getByRole('tab', { name: /^Tool calls/ })).toHaveAttribute('aria-selected', 'true')

  const terminal = screen.getByRole('region', { name: 'Terminal' })
  expect(terminal).toHaveTextContent('Terminal tabs')
  expect(within(terminal).getByText('Terminal')).toBeInTheDocument()
})

it("puts the selected task's context meter in the input bar", async () => {
  const task = { ...sampleTask('t1', 'w1'), contextUsedTokens: 76_000, contextWindowTokens: 200_000 }
  const uiState = [
    { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
    { key: UiStateKey.SelectedTaskId, value: 't1' },
  ]
  const store = createGladeStore(fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [task], uiState }).bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())

  const slot = within(screen.getByTestId('input-bar')).getByTestId('context-meter-slot')
  expect(within(slot).getByRole('meter', { name: 'Context used' })).toHaveTextContent('38% · 76k / 200k')
})

it('says why when the store could not load', async () => {
  await renderApp([], {
    [CommandName.WorkspacesList]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk full')),
  })

  expect(screen.getByRole('main')).toHaveTextContent('Glade couldn’t load: disk full')
  expect(screen.queryByRole('navigation')).toBeNull()
})
