import { act, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommandName } from '../shared/bridge'
import { READY_ATTRIBUTE } from '../shared/ready'
import { EMPTY_MENU_BAR_SNAPSHOT } from '../shared/menuBar'
import { appPage, MENU_BAR_HASH, mountApp, pageFor } from './mount'
import { NOTHING_IN_FLIGHT } from './menu-bar/menuBarModel'
import { fakeBridge, sampleWorkspace } from './store/test-bridge'

afterEach(() => {
  document.body.innerHTML = ''
})

it('renders the app into the root element and loads its store from main', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const { bridge, invoke } = fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [], uiState: [] })

  mountApp(root, appPage(bridge))

  expect(await screen.findByRole('main', { name: 'Task' })).toBeInTheDocument()
  expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesList, {})
})

it('marks the app ready once its store has loaded', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const { bridge } = fakeBridge({ workspaces: [], tasks: [], uiState: [] })

  mountApp(root, appPage(bridge))

  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute(READY_ATTRIBUTE)
  })
  expect(screen.getByRole('main', { name: 'Welcome' })).toBeInTheDocument()
  document.documentElement.removeAttribute(READY_ATTRIBUTE)
})

it("renders the menu bar popover's page in its window, asking main what's in flight, and marks it ready", async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const { bridge, invoke } = fakeBridge({ workspaces: [], tasks: [], uiState: [], menuBar: EMPTY_MENU_BAR_SNAPSHOT })

  mountApp(root, pageFor(MENU_BAR_HASH, bridge))

  expect(await screen.findByText(NOTHING_IN_FLIGHT)).toBeInTheDocument()
  expect(screen.getByRole('dialog', { name: 'Glade' })).toBeInTheDocument()
  expect(invoke).toHaveBeenCalledWith(CommandName.MenuBarGet, {})
  expect(invoke).not.toHaveBeenCalledWith(CommandName.WorkspacesList, {})
  await waitFor(() => {
    expect(document.documentElement).toHaveAttribute(READY_ATTRIBUTE)
  })
  document.documentElement.removeAttribute(READY_ATTRIBUTE)
})

it('renders the app for any other route', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const { bridge } = fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [], uiState: [] })

  mountApp(root, pageFor('#gallery', bridge))

  expect(await screen.findByRole('main', { name: 'Task' })).toBeInTheDocument()
})

it('renders another page when given one', () => {
  const root = document.createElement('div')
  document.body.append(root)

  act(() => {
    mountApp(root, <p>Gallery</p>)
  })

  expect(screen.getByText('Gallery')).toBeInTheDocument()
  expect(screen.queryByRole('main')).toBeNull()
})

it('throws when there is no root element', () => {
  expect(() => {
    mountApp(null, <p>Gallery</p>)
  }).toThrow('Missing #root element')
})
