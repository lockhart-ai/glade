import { join } from 'node:path'
import { app, BrowserWindow, dialog, type WebContents } from 'electron'
import { checkSecurity, describeViolations, parseSecurityPreferences } from './security'

/** The `bg` design token, so the window never flashes white before the renderer paints. */
const WINDOW_BACKGROUND = '#0A0B0F'

/**
 * The webPreferences Electron actually resolved for a window, not the options we passed in. Electron still provides
 * `webContents.getLastWebPreferences()` but no longer declares it in its type definitions, so it's read as unknown. If
 * a future Electron drops it, this returns null and the security check fails closed.
 */
function resolvedWebPreferences(contents: WebContents): unknown {
  const getLastWebPreferences: unknown = Reflect.get(contents, 'getLastWebPreferences')
  return typeof getLastWebPreferences === 'function' ? Reflect.apply(getLastWebPreferences, contents, []) : null
}

function refuseToStart(reason: string): void {
  console.error(`Glade refused to start: insecure window settings\n${reason}`)
  dialog.showErrorBox('Glade refused to start', `The window's security settings are not in effect.\n\n${reason}`)
  app.exit(1)
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    titleBarStyle: 'hiddenInset',
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const security = checkSecurity(parseSecurityPreferences(resolvedWebPreferences(window.webContents)))
  if (!security.ok) {
    window.destroy()
    refuseToStart(describeViolations(security.violations))
    return
  }

  // The renderer only ever shows the app's own page: no popups, no navigating away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())

  window.once('ready-to-show', () => window.show())

  // In development electron-vite serves the renderer with hot reload; otherwise load the built file.
  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(devServerUrl)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

void app.whenReady().then(() => {
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
