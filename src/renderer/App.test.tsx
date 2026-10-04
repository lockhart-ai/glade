import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../shared/bridge'
import { appCommand, AppCommandId } from '../shared/commands'
import { UiStateKey, type Workspace } from '../shared/domain'
import { App } from './App'
import { moduleClass } from './components/moduleClass'
import taskCardStyles from './layout/TaskCard.module.css'
import { MOTION_DURATION_PROPERTY } from './motion'
import { GladeStoreProvider } from './store/react'
import { createGladeStore, type GladeStore } from './store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from './store/test-bridge'
import { setHomeFolder } from '../shared/homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/sam')

interface RenderedApp extends FakeBridge {
  readonly store: GladeStore
  readonly main: FakeMain
}

async function renderApp(
  workspaces: Workspace[],
  overrides: Partial<FakeHandlers> = {},
  main: Partial<FakeMain> = {},
): Promise<RenderedApp> {
  const fakeMain: FakeMain = { workspaces, tasks: [], uiState: [], ...main }
  const fake = fakeBridge(fakeMain, overrides)
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store, main: fakeMain }
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
  // The sidebar starts with the strip for the traffic lights, as it does with a workspace.
  expect(sidebar.firstElementChild).toBe(within(sidebar).getByTestId('lights-strip'))
  expect(screen.getAllByTestId('lights-strip')).toHaveLength(1)
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

it('renders the window layout with the workspace, the chat, the task panel and the terminal', async () => {
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
  expect(within(terminal).getByRole('group', { name: 'Terminal tabs' })).toBeEmptyDOMElement()
  expect(within(terminal).getByRole('button', { name: 'New terminal' })).toBeInTheDocument()
  expect(terminal).toHaveTextContent('No terminal open. Start one with + or ⌘T.')
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

it('collapses the task list from its header, and shows it again from the top of the task card', async () => {
  const { store, main } = await renderApp([sampleWorkspace('w1')])
  // The sidebar holds the strip for the traffic lights while it's shown, and main was told it's open.
  expect(within(screen.getByRole('navigation', { name: 'Tasks' })).getByTestId('lights-strip')).toBeInTheDocument()
  await waitFor(() => {
    expect(main.trafficLightsCollapsed).toBe(false)
  })

  fireEvent.click(screen.getByRole('button', { name: 'Collapse task list' }))

  expect(store.getState().uiState[UiStateKey.SidebarCollapsed]).toBe('true')
  expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull()
  // Collapsed, there's no strip in the task card: the lights move into its header row instead (#357).
  const task = screen.getByRole('main', { name: 'Task' })
  expect(screen.queryAllByTestId('lights-strip')).toHaveLength(0)
  const titleBar = within(task).getByTestId('task-title-bar')
  await waitFor(() => {
    expect(main.trafficLightsCollapsed).toBe(true)
  })
  fireEvent.click(within(titleBar).getByRole('button', { name: 'Show task list' }))
  expect(screen.getByRole('navigation', { name: 'Tasks' })).toBeInTheDocument()
  expect(screen.queryByTestId('task-title-bar')).toBeNull()
  expect(within(screen.getByRole('navigation', { name: 'Tasks' })).getByTestId('lights-strip')).toBeInTheDocument()
  await waitFor(() => {
    expect(main.trafficLightsCollapsed).toBe(false)
  })
})

it('keeps each panel on screen, inert, while it slides shut, and the terminal showing until the bar is shut', async () => {
  document.documentElement.style.setProperty(MOTION_DURATION_PROPERTY, '200ms')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { emit } = await renderApp([sampleWorkspace('w1')])
    const terminal = screen.getByRole('region', { name: 'Terminal' })
    act(() => {
      emit({ type: EventType.MenuCommand, command: appCommand(AppCommandId.ToggleSidebar) })
      emit({ type: EventType.MenuCommand, command: appCommand(AppCommandId.ToggleRightPanel) })
      emit({ type: EventType.MenuCommand, command: appCommand(AppCommandId.ToggleBottomBar) })
    })

    // On their way out: still there, but nothing in them takes a click or the focus.
    expect(screen.getByTestId('sidebar-slot')).toHaveAttribute('inert')
    expect(screen.getByTestId('right-panel')).toHaveAttribute('inert')
    expect(screen.getByTestId('bottom-bar-slot')).toHaveAttribute('inert')
    expect(within(terminal).getByText(/^No terminal open/)).toBeVisible()
    // The sidebar's button in the task card is there at once, to bring it back.
    expect(
      within(screen.getByRole('main', { name: 'Task' })).getByRole('button', { name: 'Show task list' }),
    ).toBeInTheDocument()

    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(screen.queryByTestId('sidebar-slot')).toBeNull()
    expect(screen.queryByTestId('right-panel')).toBeNull()
    expect(screen.getByTestId('bottom-bar-slot')).not.toHaveAttribute('inert')
    expect(within(terminal).getByText(/^No terminal open/)).not.toBeVisible()
  } finally {
    vi.useRealTimers()
    document.documentElement.style.removeProperty(MOTION_DURATION_PROPERTY)
  }
})

it('keeps the task card’s title row from dragging the window while the sidebar or the right panel slides', async () => {
  // #358: it resizes with every frame of either slide, and a drag region that moves stalls the animation.
  document.documentElement.style.setProperty(MOTION_DURATION_PROPERTY, '200ms')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const { emit } = await renderApp([sampleWorkspace('w1')])
    const toggle = (id: AppCommandId): void => {
      act(() => {
        emit({ type: EventType.MenuCommand, command: appCommand(id) })
      })
    }
    const land = (): void => {
      act(() => {
        vi.advanceTimersByTime(200)
      })
    }
    const sliding = moduleClass(taskCardStyles, 'sliding')
    const titleBar = (): HTMLElement => screen.getByTestId('task-title-bar')

    // The sidebar slides shut: the row it hands over is there at once, but only drags once it's shut.
    toggle(AppCommandId.ToggleSidebar)
    expect(titleBar()).toHaveClass(sliding)
    land()
    expect(titleBar()).not.toHaveClass(sliding)

    // The right panel slides shut and open beside it, which resizes it.
    for (let slide = 0; slide < 2; slide += 1) {
      toggle(AppCommandId.ToggleRightPanel)
      expect(titleBar()).toHaveClass(sliding)
      land()
      expect(titleBar()).not.toHaveClass(sliding)
    }

    // The bottom bar's slide moves it not at all.
    toggle(AppCommandId.ToggleBottomBar)
    expect(titleBar()).not.toHaveClass(sliding)
    land()
  } finally {
    vi.useRealTimers()
    document.documentElement.style.removeProperty(MOTION_DURATION_PROPERTY)
  }
})

it('collapses the bottom bar to its tab row, and toggles the panels from the menu bar', async () => {
  const { store, emit } = await renderApp([sampleWorkspace('w1')])
  const choose = (id: AppCommandId): void => {
    act(() => {
      emit({ type: EventType.MenuCommand, command: appCommand(id) })
    })
  }
  const terminal = screen.getByRole('region', { name: 'Terminal' })

  fireEvent.click(within(terminal).getByRole('button', { name: 'Collapse bottom panel' }))
  expect(within(terminal).getByText(/^No terminal open/)).not.toBeVisible()
  choose(AppCommandId.ToggleBottomBar)
  expect(within(terminal).getByText(/^No terminal open/)).toBeVisible()

  choose(AppCommandId.ToggleSidebar)
  expect(screen.queryByRole('navigation', { name: 'Tasks' })).toBeNull()
  choose(AppCommandId.ToggleRightPanel)
  expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull()
  expect(store.getState().uiState).toMatchObject({
    [UiStateKey.SidebarCollapsed]: 'true',
    [UiStateKey.RightPanelCollapsed]: 'true',
    [UiStateKey.BottomBarCollapsed]: 'false',
  })
})

it('keeps the task list in the first-run window, where only the bottom bar collapses', async () => {
  const { store, emit } = await renderApp([])

  expect(screen.queryByRole('button', { name: 'Collapse task list' })).toBeNull()
  expect(store.getState().uiState[UiStateKey.SidebarCollapsed]).toBeUndefined()
  act(() => {
    emit({ type: EventType.MenuCommand, command: appCommand(AppCommandId.ToggleBottomBar) })
  })
  expect(screen.getByRole('button', { name: 'Show bottom panel' })).toBeInTheDocument()
})

it('sizes the task list and bottom bar from UI state, keeps the sizes you resize them to, and keeps them while collapsed', async () => {
  const uiState = [
    { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
    { key: UiStateKey.SidebarWidth, value: '400' },
    { key: UiStateKey.BottomBarHeight, value: '250' },
  ]
  const store = createGladeStore(fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [], uiState }).bridge)
  render(
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  const shell = screen.getByTestId('window-top-edge').parentElement
  const size = (property: string): string | undefined => shell?.style.getPropertyValue(property)
  expect(size('--sidebar-width')).toBe('400px')
  expect(size('--bottom-bar-height')).toBe('250px')
  // The task card's minimum width has room for the right panel while it shows.
  const row = screen.getByRole('main', { name: 'Task' }).parentElement
  expect(row).toHaveAttribute('data-right-panel', 'true')

  // jsdom lays nothing out, so there's only room for each panel's minimum; the key press stores it.
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize task list' }), { key: 'ArrowRight' })
  fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize bottom panel' }), { key: 'ArrowUp' })
  await act(async () => {
    await Promise.resolve()
  })
  expect(store.getState().uiState).toMatchObject({
    [UiStateKey.SidebarWidth]: '240',
    [UiStateKey.BottomBarHeight]: '120',
  })
  expect(size('--sidebar-width')).toBe('240px')
  expect(size('--bottom-bar-height')).toBe('120px')

  // Collapsed and shown again, both come back at the size you left them.
  fireEvent.click(screen.getByRole('button', { name: 'Collapse task list' }))
  fireEvent.click(screen.getByRole('button', { name: 'Collapse bottom panel' }))
  expect(screen.queryByRole('separator', { name: 'Resize task list' })).toBeNull()
  expect(screen.queryByRole('separator', { name: 'Resize bottom panel' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
  expect(row).toHaveAttribute('data-right-panel', 'false')
  fireEvent.click(screen.getByRole('button', { name: 'Show task list' }))
  fireEvent.click(screen.getByRole('button', { name: 'Show bottom panel' }))
  expect(screen.getByRole('separator', { name: 'Resize task list' })).toHaveAttribute('aria-valuenow', '240')
  expect(screen.getByRole('separator', { name: 'Resize bottom panel' })).toHaveAttribute('aria-valuenow', '120')
  expect(size('--sidebar-width')).toBe('240px')
})
