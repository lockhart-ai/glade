/**
 * The menu bar icon e2e mode uses in place of Electron's `Tray`, which would put a real icon in the menu bar: it shows
 * nothing, only records what it was asked to show, and can be clicked as the icon would. The app puts it on the main
 * process's global object (`E2E_MENU_BAR_GLOBAL`), with the menu bar's state, for a spec to read and click through
 * Playwright's `app.evaluate`.
 */
import type { E2eMenuBar } from '../e2e'
import { Glyph, type MenuBarAppearance } from './glyph'
import type { CreateTray, MenuBar } from './menu-bar'
import type { Bounds } from './position'

/** Where the recorded icon says it is: at the right of a menu bar on a 1920-wide screen. */
export const RECORDED_TRAY_BOUNDS: Bounds = { x: 1600, y: 0, width: 32, height: 24 }

/** A recorded icon: what it shows, and a way to click it. */
export interface RecordingTray {
  /** Makes the icon, as `Tray` would, recording it. */
  readonly createTray: CreateTray
  /** Whether an icon is in the (recorded) menu bar. */
  readonly shown: boolean
  /** The text beside its glyph. */
  readonly title: string
  /** The glyph it shows: plain, or with the dot for a light or dark menu bar. */
  readonly glyph: Glyph
  /** Clicks it. Throws when there's no icon. */
  click(): void
}

interface Recorded {
  title: string
  glyph: Glyph
  readonly onClick: () => void
}

export function createRecordingTray(): RecordingTray {
  let current: Recorded | null = null
  return {
    createTray: ({ onClick }) => {
      const recorded: Recorded = { title: '', glyph: Glyph.Plain, onClick }
      current = recorded
      return {
        setGlyph: (glyph) => {
          recorded.glyph = glyph
        },
        setTitle: (title) => {
          recorded.title = title
        },
        bounds: () => RECORDED_TRAY_BOUNDS,
        destroy: () => {
          if (current === recorded) current = null
        },
      }
    },
    get shown() {
      return current !== null
    },
    get title() {
      return current?.title ?? ''
    },
    get glyph() {
      return current?.glyph ?? Glyph.Plain
    },
    click() {
      if (current === null) throw new Error('There is no menu bar icon to click')
      current.onClick()
    },
  }
}

/** The menu bar's appearance, as e2e mode has it: dark until a spec switches it (`E2eMenuBar.appearance`). */
export interface RecordedAppearance {
  appearance: MenuBarAppearance
}

/**
 * What a spec sees of the menu bar (`E2E_MENU_BAR_GLOBAL`): the recorded icon and the menu bar's state, read as they
 * are when asked. Switching the appearance tells the menu bar, as macOS would.
 */
export function e2eMenuBar(menuBar: MenuBar, tray: RecordingTray, recorded: RecordedAppearance): E2eMenuBar {
  return {
    get shown() {
      return tray.shown
    },
    get title() {
      return tray.title
    },
    get glyph() {
      return tray.glyph
    },
    get open() {
      return menuBar.open
    },
    get appearance() {
      return recorded.appearance
    },
    set appearance(appearance) {
      recorded.appearance = appearance
      menuBar.appearanceChanged()
    },
    click() {
      tray.click()
    },
  }
}
