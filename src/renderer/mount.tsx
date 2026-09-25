import { StrictMode, type ReactNode } from 'react'
import { createRoot, type RootOptions } from 'react-dom/client'
import type { GladeBridge } from '../shared/bridge'
import { App } from './App'
import { ReadySignal } from './ready'
import { GladeStoreProvider } from './store/react'
import { createGladeStore } from './store/store'

/** The app with its store, which starts loading from main over `bridge` straight away. Ready once it has loaded. */
export function appPage(bridge: GladeBridge): React.JSX.Element {
  const store = createGladeStore(bridge)
  const hydrated = store.getState().hydrate()
  return (
    <GladeStoreProvider store={store}>
      <ReadySignal until={hydrated}>
        <App />
      </ReadySignal>
    </GladeStoreProvider>
  )
}

/**
 * Renders a page (the app, or in dev another page such as the component gallery) into the page's root element, with
 * the root's `options`, such as its error callbacks (`./errors/reportErrors`).
 */
export function mountApp(root: HTMLElement | null, page: ReactNode, options?: RootOptions): void {
  if (root === null) throw new Error('Missing #root element')

  createRoot(root, options).render(<StrictMode>{page}</StrictMode>)
}
