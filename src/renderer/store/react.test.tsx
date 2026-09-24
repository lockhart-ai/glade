import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { GladeStoreProvider, useGladeStore } from './react'
import { selectSelectedWorkspace } from './state'
import { createGladeStore } from './store'
import { fakeBridge, sampleWorkspace } from './test-bridge'

afterEach(() => {
  vi.restoreAllMocks()
})

function SelectedWorkspace(): React.JSX.Element {
  const workspace = useGladeStore(selectSelectedWorkspace)
  return <p>{workspace?.name ?? 'None'}</p>
}

it('reads the store through a selector and re-renders when the selected value changes', async () => {
  const fake = fakeBridge({ workspaces: [sampleWorkspace('w1')], tasks: [], uiState: [] })
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  render(
    <GladeStoreProvider store={store}>
      <SelectedWorkspace />
    </GladeStoreProvider>,
  )
  expect(screen.getByRole('paragraph')).toHaveTextContent('None')

  await act(() => store.getState().selectWorkspace('w1'))
  expect(screen.getByRole('paragraph')).toHaveTextContent('Acme API')

  act(() => {
    fake.emit({ type: EventType.WorkspaceUpdated, workspace: { ...sampleWorkspace('w1'), name: 'Acme Web' } })
  })
  expect(screen.getByRole('paragraph')).toHaveTextContent('Acme Web')
})

it('throws outside a GladeStoreProvider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  expect(() => renderHook(() => useGladeStore((state) => state.hydration))).toThrow(
    'useGladeStore must be used under a GladeStoreProvider',
  )
})
