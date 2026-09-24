import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import type { GladeBridge } from '../shared/bridge'
import { App } from './App'
import { GladeStoreProvider } from './store/react'
import { createGladeStore } from './store/store'

/** Renders the app into the page's root element, and starts loading its store from main over `bridge`. */
export function mountApp(root: HTMLElement | null, bridge: GladeBridge): void {
  if (root === null) throw new Error('Missing #root element')

  const store = createGladeStore(bridge)
  void store.getState().hydrate()
  createRoot(root).render(
    <StrictMode>
      <GladeStoreProvider store={store}>
        <App />
      </GladeStoreProvider>
    </StrictMode>,
  )
}
