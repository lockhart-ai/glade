import { screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommandName } from '../shared/bridge'
import { mountApp } from './mount'
import { fakeBridge, sampleWorkspace } from './store/test-bridge'

afterEach(() => {
  document.body.innerHTML = ''
})

it('renders the app into the root element and loads the store from main', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const { bridge, invoke } = fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [], uiState: [] })

  mountApp(root, bridge)

  expect(await screen.findByText('Glade')).toBeInTheDocument()
  expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesList, {})
})

it('throws when there is no root element', () => {
  const { bridge } = fakeBridge({ workspaces: [], tasks: [], uiState: [] })

  expect(() => {
    mountApp(null, bridge)
  }).toThrow('Missing #root element')
})
