import { act, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { CommandName } from '../shared/bridge'
import { appPage, mountApp } from './mount'
import { fakeBridge, sampleWorkspace } from './store/test-bridge'

afterEach(() => {
  document.body.innerHTML = ''
})

it('renders the app into the root element and loads its store from main', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const { bridge, invoke } = fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [], uiState: [] })

  mountApp(root, appPage(bridge))

  expect(await screen.findByText('Glade')).toBeInTheDocument()
  expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesList, {})
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
