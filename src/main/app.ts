import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type WebPreferences } from 'electron'
import { registerBridge } from './bridge'
import {
  captureShots,
  prepareCapture,
  readCaptureSpec,
  withTimeout,
  type CaptureSpec,
  type MinimumSize,
} from './capture'
import { openAppDatabase, type AppDatabase } from './db/database'
import { chooseFolder } from './dialogs'
import { checkSecurity, describeViolations } from './security'

/** The `bg` design token, so the window never flashes white before the renderer paints. */
const WINDOW_BACKGROUND = '#0A0B0F'

/** The smallest the window can be made. */
const WINDOW_MIN_SIZE: MinimumSize = { width: 1100, height: 700 }

/** The only webPreferences any window is created with. Checked by `checkSecurity` before a window exists. */
export const WINDOW_WEB_PREFERENCES: WebPreferences = {
  preload: join(__dirname, '../preload/index.js'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}

/** Why the app can't start, for the log and for the dialog the user sees. */
interface StartFailure {
  readonly logSummary: string
  readonly message: string
  readonly detail: string
}

/** Logs why the app can't start and exits. Shows a dialog too, except in a capture, which must never show anything. */
function refuseToStart({ logSummary, message, detail }: StartFailure, capture: CaptureSpec | null): void {
  console.error(`Glade refused to start: ${logSummary}\n${detail}`)
  if (capture === null) dialog.showErrorBox('Glade refused to start', `${message}\n\n${detail}`)
  app.exit(1)
}

type DatabaseOpening =
  { readonly ok: true; readonly database: AppDatabase } | { readonly ok: false; readonly failure: StartFailure }

/** Opens and migrates the database in the app's data folder, or says why it couldn't. */
function openDatabase(): DatabaseOpening {
  try {
    const database = openAppDatabase(app.getPath('userData'))
    const { fromVersion, toVersion } = database.migration
    console.log(`Database opened at ${database.file}; schema version ${String(fromVersion)} -> ${String(toVersion)}`)
    return { ok: true, database }
  } catch (error) {
    const detail = error instanceof Error ? describeError(error) : String(error)
    return {
      ok: false,
      failure: { logSummary: 'could not open the database', message: 'The database could not be opened.', detail },
    }
  }
}

function describeError(error: Error): string {
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}

/** Opens the main window: shown once it's ready, except in a capture, where it's never shown and opens at its route. */
function createWindow(capture: CaptureSpec | null): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    ...(capture === null ? {} : { paintWhenInitiallyHidden: true }),
    titleBarStyle: 'hiddenInset',
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: WINDOW_WEB_PREFERENCES,
  })

  // The renderer only ever shows the app's own page: no popups, no navigating away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  if (capture === null) {
    window.once('ready-to-show', () => {
      window.show()
    })
  }

  // In development electron-vite serves the renderer with hot reload; otherwise load the built file.
  const route = capture?.route ?? ''
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(`${devServerUrl}${route}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route.replace(/^#/, '') })
  }
  return window
}

/** Captures the hidden window's page, then closes the database and exits: 0 when every PNG was written, 1 otherwise. */
async function runCapture(window: BrowserWindow, capture: CaptureSpec, database: AppDatabase): Promise<void> {
  let exitCode = 0
  try {
    const files = await withTimeout(captureShots(window, capture), capture.timeoutMs)
    for (const file of files) console.log(`Captured ${file}`)
  } catch (error) {
    console.error(`Glade capture failed: ${error instanceof Error ? error.message : String(error)}`)
    exitCode = 1
  }
  database.db.close()
  app.exit(exitCode)
}

/** The screenshot run asked for through the environment, set up before the app is ready; `null` in a normal run. */
function startCapture(): CaptureSpec | null {
  const capture = readCaptureSpec(process.env, app.isPackaged, WINDOW_MIN_SIZE)
  if (capture !== null) prepareCapture(app, capture)
  return capture
}

/**
 * Starts the app: once Electron is ready, checks the window security settings, opens and migrates the database (closed
 * again on quit), registers the bridge the renderer talks to main through, then opens the main window.
 *
 * Outside a packaged app, a capture spec in the environment (see `./capture`) starts a screenshot run instead: the
 * same app with a throwaway data folder, in a window that is never shown, which captures its page and exits.
 */
export function startApp(): void {
  let capture: CaptureSpec | null
  try {
    capture = startCapture()
  } catch (error) {
    console.error(`Glade capture failed: ${(error as Error).message}`)
    app.exit(1)
    return
  }

  void app.whenReady().then(() => {
    const security = checkSecurity(WINDOW_WEB_PREFERENCES)
    if (!security.ok) {
      refuseToStart(
        {
          logSummary: 'insecure window settings',
          message: "The window's security settings are not in effect.",
          detail: describeViolations(security.violations),
        },
        capture,
      )
      return
    }

    const opening = openDatabase()
    if (!opening.ok) {
      refuseToStart(opening.failure, capture)
      return
    }
    const { database } = opening

    registerBridge({
      ipc: ipcMain,
      db: database.db,
      targets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
      chooseFolder: () => chooseFolder(dialog, BrowserWindow.getFocusedWindow()),
    })

    if (capture !== null) {
      void runCapture(createWindow(capture), capture, database)
      return
    }

    app.on('will-quit', () => {
      database.db.close()
    })

    createWindow(null)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(null)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
