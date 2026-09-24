// Test helper: renders a component under a store on the in-memory stand-in for main, and a toast provider.
import type { ReactNode } from 'react'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from './react'
import { createGladeStore, type GladeStore } from './store'
import {
  fakeBridge,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from './test-bridge'

export interface StoreWrapper {
  /** For `render`'s `wrapper` option. */
  readonly wrapper: (props: { readonly children: ReactNode }) => React.JSX.Element
  readonly store: GladeStore
  readonly fake: FakeBridge
}

/**
 * A workspace `w1` with a task `t1`, and nothing else, unless `main` says otherwise; `overrides` replace some of the
 * fake main's handlers. Hydrate `store` to load it.
 */
export function storeWrapper(main: Partial<FakeMain> = {}, overrides: Partial<FakeHandlers> = {}): StoreWrapper {
  const fake = fakeBridge(
    { workspaces: [sampleWorkspace('w1')], tasks: [sampleTask('t1', 'w1')], uiState: [], ...main },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <GladeStoreProvider store={store}>
      <ToastProvider>{children}</ToastProvider>
    </GladeStoreProvider>
  )
  return { wrapper, store, fake }
}
