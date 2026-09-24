import type { MenuItemConstructorOptions } from 'electron'
import { EMPTY_MENU_STATE, type Command, type MenuState } from '../../shared/commands'
import { menuTemplate, type MenuOptions } from './template'

/** The part of Electron's `Menu` the menu bar uses, so tests can stand in a fake. */
export interface MenuApi<M> {
  buildFromTemplate(template: MenuItemConstructorOptions[]): M
  setApplicationMenu(menu: M): void
}

export interface AppMenuOptions<M> extends MenuOptions {
  readonly menu: MenuApi<M>
  /** Sends a chosen item's command to the window, which runs it. */
  readonly send: (command: Command) => void
}

/** The app's menu bar. */
export interface AppMenu {
  /** Shows what the window now shows: rebuilds the menu bar when it's changed. */
  update(state: MenuState): void
}

/**
 * Sets the app's menu bar, with nothing to act on until the window reports what it shows (`update`). Choosing an item
 * sends its command to the window. The menu bar is rebuilt then too, since macOS flips a checkbox item (Switch
 * workspace ▸) as it's chosen, and the window may not change what it reports.
 */
export function installAppMenu<M>({ menu, send, ...options }: AppMenuOptions<M>): AppMenu {
  let state = EMPTY_MENU_STATE
  let built = ''
  const build = (): void => {
    menu.setApplicationMenu(menu.buildFromTemplate(menuTemplate(state, options, run)))
  }
  const run = (command: Command): void => {
    send(command)
    build()
  }
  build()
  return {
    update(next) {
      const key = JSON.stringify(next)
      if (key === built) return
      built = key
      state = next
      build()
    },
  }
}
