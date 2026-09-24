import { StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { GladeBridge } from '../shared/bridge'
import { App } from './App'
import { GladeStoreProvider } from './store/react'
import { createGladeStore } from './store/store'

/** The app with its store, which starts loading from main over `bridge` straight away. */
export function appPage(bridge: GladeBridge): React.JSX.Element {
  const store = createGladeStore(bridge)
  void store.getState().hydrate()
  return (
    <GladeStoreProvider store={store}>
      <App />
    </GladeStoreProvider>
  )
}

/** Renders a page (the app, or in dev another page such as the component gallery) into the page's root element. */
export function mountApp(root: HTMLElement | null, page: ReactNode): void {
  if (root === null) throw new Error('Missing #root element')

  createRoot(root).render(<StrictMode>{page}</StrictMode>)
}
