// The store's React binding: the app gets its store from context (so tests can hand it one on a fake bridge) and reads
// it through selectors, re-rendering only when the selected value changes.
import { createContext, use, type ReactNode } from 'react'
import { useStore } from 'zustand'
import type { GladeState } from './state'
import type { GladeStore } from './store'

const GladeStoreContext = createContext<GladeStore | null>(null)

export interface GladeStoreProviderProps {
  readonly store: GladeStore
  readonly children: ReactNode
}

export function GladeStoreProvider({ store, children }: GladeStoreProviderProps): React.JSX.Element {
  return <GladeStoreContext value={store}>{children}</GladeStoreContext>
}

/** Reads the store through `selector`. Must be used under a `GladeStoreProvider`. */
export function useGladeStore<T>(selector: (state: GladeState) => T): T {
  const store = use(GladeStoreContext)
  if (store === null) throw new Error('useGladeStore must be used under a GladeStoreProvider')
  return useStore(store, selector)
}

/** The store itself, to read or subscribe to it outside rendering. Must be used under a `GladeStoreProvider`. */
export function useGladeStoreApi(): GladeStore {
  const store = use(GladeStoreContext)
  if (store === null) throw new Error('useGladeStoreApi must be used under a GladeStoreProvider')
  return store
}
