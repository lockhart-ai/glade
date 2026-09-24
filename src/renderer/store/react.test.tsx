import { act, render, renderHook, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { GladeStoreProvider, useGladeStore, useGladeStoreApi } from './react'
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
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2', 'Acme Web')],
    tasks: [],
    uiState: [],
  })
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  render(
    <GladeStoreProvider store={store}>
      <SelectedWorkspace />
    </GladeStoreProvider>,
  )
  expect(screen.getByRole('paragraph')).toHaveTextContent('Acme API')

  await act(() => store.getState().openWorkspace('w2'))
  expect(screen.getByRole('paragraph')).toHaveTextContent('Acme Web')

  act(() => {
    fake.emit({ type: EventType.WorkspaceUpdated, workspace: sampleWorkspace('w2', 'Acme Mobile') })
  })
  expect(screen.getByRole('paragraph')).toHaveTextContent('Acme Mobile')
})

it('throws outside a GladeStoreProvider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  expect(() => renderHook(() => useGladeStore((state) => state.hydration))).toThrow(
    'useGladeStore must be used under a GladeStoreProvider',
  )
})

it('hands back the store itself under a GladeStoreProvider', () => {
  const store = createGladeStore(fakeBridge({ workspaces: [], tasks: [], uiState: [] }).bridge)

  const { result } = renderHook(() => useGladeStoreApi(), {
    wrapper: ({ children }) => <GladeStoreProvider store={store}>{children}</GladeStoreProvider>,
  })

  expect(result.current).toBe(store)
})

it('refuses to hand back the store outside a GladeStoreProvider', () => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined)

  expect(() => renderHook(() => useGladeStoreApi())).toThrow('useGladeStoreApi must be used under a GladeStoreProvider')
})
