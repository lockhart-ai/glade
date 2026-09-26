/**
 * What draws Glade in the menu bar in the app (`./menu-bar` decides what it shows): Electron's `Tray` for the icon, and
 * a small `BrowserWindow` of Glade's own page for the popover. The popover keeps every window's security settings (the
 * app's `WINDOW_WEB_PREFERENCES`: context isolation, no Node, sandboxed, the typed preload bridge) and, like the main
 * window, only ever shows Glade's own page.
 */
import { join } from 'node:path'
import type { BrowserWindow, BrowserWindowConstructorOptions, NativeImage, Tray } from 'electron'
import { EVENT_CHANNEL } from '../../shared/bridge'
import { MENU_BAR_POPOVER_WIDTH } from '../../shared/menuBar'
import type { CreatePopover, CreateTray } from './menu-bar'
import { MIN_POPOVER_HEIGHT, popoverBounds, type Bounds } from './position'
import { GLYPH_STRENGTHS, RESTING_FRAME } from './pulse'

/** The `menu` design token: the popover's window is painted it before its page draws. */
const POPOVER_BACKGROUND = '#262935'

/**
 * The longest the popover waits, the first time it shows, for its page to say how tall it is (`fit`), so it doesn't
 * show at its least height first. Past it, it shows anyway.
 */
export const FIRST_FIT_TIMEOUT_MS = 500

/** What the icon says under the pointer. */
export const TRAY_TOOLTIP = 'Glade'

/** Where the glyph's images are, from the app's folder (`app.getAppPath()`), which packages them. */
export const GLYPH_FOLDER = join('assets', 'icon', 'menu-bar')

/**
 * The file of the glyph at a strength (`GLYPH_STRENGTHS`), its @1x image: macOS picks the `@2x` beside it on a Retina
 * display, and draws it as a template (in the menu bar's own colour, light or dark) for the `Template` in its name.
 */
export function glyphFile(frame: number): string {
  return `glyph-${String(frame)}Template.png`
}

/** The part of Electron's `nativeImage` the tray uses. */
export interface NativeImages {
  createFromPath(path: string): NativeImage
}

/** The glyph's images, one per strength, from `folder`, each marked a template image. */
export function loadGlyphImages(nativeImage: NativeImages, folder: string): NativeImage[] {
  return GLYPH_STRENGTHS.map((_, frame) => {
    const image = nativeImage.createFromPath(join(folder, glyphFile(frame)))
    image.setTemplateImage(true)
    return image
  })
}

/** Electron's `Tray` class, as the tray uses it. */
export type TrayClass = new (image: NativeImage) => Tray

/** Puts the icon in the menu bar with Electron's `Tray`, drawing the glyph from `images` (`loadGlyphImages`). */
export function createElectronTray(TrayClass: TrayClass, images: readonly NativeImage[]): CreateTray {
  const image = (frame: number): NativeImage => {
    const found = images[frame] ?? images[RESTING_FRAME]
    if (found === undefined) throw new Error('No menu bar glyph images')
    return found
  }
  return ({ onClick }) => {
    const tray = new TrayClass(image(RESTING_FRAME))
    tray.setToolTip(TRAY_TOOLTIP)
    tray.on('click', onClick)
    return {
      setFrame: (frame) => {
        tray.setImage(image(frame))
      },
      setTitle: (title) => {
        // Digits of one width, so the count doesn't shift the glyph as it changes.
        tray.setTitle(title, { fontType: 'monospacedDigit' })
      },
      bounds: () => tray.getBounds(),
      destroy: () => {
        tray.destroy()
      },
    }
  }
}

/** Electron's `BrowserWindow` class, as the popover uses it. */
export type WindowClass = new (options: BrowserWindowConstructorOptions) => BrowserWindow

/** What the popover's window is made with. */
export interface ElectronPopoverOptions {
  readonly BrowserWindow: WindowClass
  /** The security settings every window has (the app's `WINDOW_WEB_PREFERENCES`). */
  readonly webPreferences: BrowserWindowConstructorOptions['webPreferences']
  /** Loads Glade's page in the window at a route (`#menu-bar`), as the main window loads its own. */
  readonly load: (window: BrowserWindow) => void
  /** The work area of the screen `anchor` is on (`screen.getDisplayMatching(anchor).workArea`). */
  readonly workArea: (anchor: Bounds) => Bounds
  /** Never shows the window, in a test mode, which must never show anything: its page still paints, for a test to drive. */
  readonly hidden: boolean
  /** Called with each window made, and again when it's destroyed, so the app can tell it from its main windows. */
  readonly track: (window: BrowserWindow, alive: boolean) => void
}

/**
 * Makes the popover's window: a frameless, fixed-size panel, off the Dock and Mission Control, above other windows
 * (full-screen ones too) and on every Space, hidden until the icon is clicked. As a panel it takes the focus without
 * bringing Glade's other windows forward. It hides when it loses the focus. The first time it shows, it waits for its
 * page to say how tall it is (up to `FIRST_FIT_TIMEOUT_MS`).
 */
export function createElectronPopover({
  BrowserWindow: WindowClass,
  webPreferences,
  load,
  workArea,
  hidden,
  track,
}: ElectronPopoverOptions): CreatePopover {
  return ({ onHidden }) => {
    const window = new WindowClass({
      width: MENU_BAR_POPOVER_WIDTH,
      height: MIN_POPOVER_HEIGHT,
      show: false,
      ...(hidden ? { paintWhenInitiallyHidden: true } : {}),
      type: 'panel',
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      backgroundColor: POPOVER_BACKGROUND,
      webPreferences,
    })
    track(window, true)
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Glade's own page only: no popups, no navigating away.
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', (event) => {
      event.preventDefault()
    })
    window.on('blur', () => {
      window.hide()
      onHidden()
    })
    load(window)
    let anchor: Bounds | null = null
    let height = MIN_POPOVER_HEIGHT
    // Whether its page has said how tall it is, and, until it has, whether it's waiting to show.
    let fitted = false
    let waiting: ReturnType<typeof setTimeout> | null = null
    const place = (): void => {
      if (anchor === null) return
      window.setBounds(popoverBounds({ anchor, width: MENU_BAR_POPOVER_WIDTH, height, workArea: workArea(anchor) }))
    }
    const stopWaiting = (): void => {
      if (waiting === null) return
      clearTimeout(waiting)
      waiting = null
    }
    const reveal = (): void => {
      stopWaiting()
      if (hidden) return
      window.show()
      window.focus()
    }
    return {
      show: (bounds) => {
        anchor = bounds
        place()
        if (fitted) reveal()
        else waiting ??= setTimeout(reveal, FIRST_FIT_TIMEOUT_MS)
      },
      hide: () => {
        stopWaiting()
        window.hide()
      },
      send: (event) => {
        window.webContents.send(EVENT_CHANNEL, event)
      },
      fit: (to) => {
        height = to
        fitted = true
        place()
        if (waiting !== null) reveal()
      },
      destroy: () => {
        stopWaiting()
        track(window, false)
        window.destroy()
      },
    }
  }
}
