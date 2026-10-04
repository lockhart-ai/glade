import { StrictMode, type ReactNode } from 'react'
import { createRoot, type RootOptions } from 'react-dom/client'
import { CommandName, type GladeBridge } from '../shared/bridge'
import { setHomeFolder } from '../shared/homeFolder'
import { App } from './App'
import { MenuBarPage } from './menu-bar/MenuBarPage'
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

/** The route of the menu bar popover's page, in its own window (`src/main/menu-bar`). */
export const MENU_BAR_HASH = '#menu-bar'

/**
 * The menu bar popover's page: what's in flight, which it asks main for straight away. Ready once it has it (or failed
 * to, when it shows nothing in flight).
 */
export function menuBarPage(bridge: GladeBridge): React.JSX.Element {
  const loaded = bridge.invoke(CommandName.MenuBarGet, {}).then(({ snapshot }) => snapshot)
  return (
    <ReadySignal until={loaded}>
      <MenuBarPage bridge={bridge} initial={loaded} />
    </ReadySignal>
  )
}

/**
 * The page a window shows, by its location's hash: the menu bar popover's, or the app. Either shows paths from the
 * home folder the window was told (`src/shared/homeFolder`).
 */
export function pageFor(hash: string, bridge: GladeBridge): React.JSX.Element {
  setHomeFolder(bridge.homeFolder)
  return hash === MENU_BAR_HASH ? menuBarPage(bridge) : appPage(bridge)
}

/**
 * Renders a page (the app, or in dev another page such as the component gallery) into the page's root element, with
 * the root's `options`, such as its error callbacks (`./errors/reportErrors`).
 */
export function mountApp(root: HTMLElement | null, page: ReactNode, options?: RootOptions): void {
  if (root === null) throw new Error('Missing #root element')

  createRoot(root, options).render(<StrictMode>{page}</StrictMode>)
}
