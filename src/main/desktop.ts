/**
 * What the context menus ask of the Mac beyond the app's window: putting text on the clipboard, and showing a file in
 * Finder. The app does both through Electron; a test mode never does either (see `createDesktop` in `./app`).
 */
export interface Desktop {
  /** Puts text on the clipboard: Electron's `clipboard.writeText`. */
  readonly writeClipboard: (text: string) => Promise<void>
  /** Shows a file in Finder, selected in its folder: Electron's `shell.showItemInFolder`. */
  readonly showItemInFolder: (path: string) => void
}

/** A desktop that does nothing: what a capture run and the unit tests get. */
export const NO_DESKTOP: Desktop = {
  writeClipboard: () => Promise.resolve(),
  showItemInFolder: () => undefined,
}
