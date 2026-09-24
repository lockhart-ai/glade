import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  const appHandlers = new Map<string, Handler>()
  const windows: FakeWindow[] = []

  class FakeWindow {
    readonly options: unknown
    readonly handlers = new Map<string, Handler>()
    readonly onceHandlers = new Map<string, Handler>()
    readonly show = vi.fn()
    readonly loadURL = vi.fn(() => Promise.resolve())
    readonly loadFile = vi.fn(() => Promise.resolve())
    readonly webContents = {
      windowOpenHandler: undefined as Handler | undefined,
      setWindowOpenHandler: vi.fn((handler: Handler) => {
        this.webContents.windowOpenHandler = handler
      }),
      on: vi.fn((event: string, handler: Handler) => {
        this.handlers.set(event, handler)
      }),
    }
    readonly once = vi.fn((event: string, handler: Handler) => {
      this.onceHandlers.set(event, handler)
    })

    constructor(options: unknown) {
      this.options = options
      windows.push(this)
    }

    static getAllWindows = vi.fn(() => windows)
  }

  return {
    appHandlers,
    windows,
    FakeWindow,
    app: {
      isPackaged: false,
      userData: '',
      getPath: vi.fn((name: string): string => {
        if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
        return electron.app.userData
      }),
      whenReady: vi.fn(() => Promise.resolve()),
      on: vi.fn((event: string, handler: Handler) => {
        appHandlers.set(event, handler)
      }),
      quit: vi.fn(),
      exit: vi.fn(),
    },
    dialog: { showErrorBox: vi.fn() },
  }
})

vi.mock('electron', () => ({ app: electron.app, BrowserWindow: electron.FakeWindow, dialog: electron.dialog }))

const { startApp, WINDOW_WEB_PREFERENCES } = await import('./app')

/** Starts the app and lets the `whenReady` callback run. */
async function startAndWaitUntilReady(): Promise<void> {
  startApp()
  await Promise.resolve()
  await Promise.resolve()
}

function onlyWindow(): InstanceType<typeof electron.FakeWindow> {
  expect(electron.windows).toHaveLength(1)
  const window = electron.windows[0]
  if (window === undefined) throw new Error('no window')
  return window
}

function appHandler(event: string): Handler {
  const handler = electron.appHandlers.get(event)
  if (handler === undefined) throw new Error(`no ${event} handler`)
  return handler
}

const originalPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  electron.appHandlers.clear()
  electron.windows.length = 0
  electron.app.isPackaged = false
  electron.app.userData = mkdtempSync(join(tmpdir(), 'glade-app-'))
  vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  // Close the database the way quitting the app does, so the temp folder can go.
  electron.appHandlers.get('will-quit')?.()
  rmSync(electron.app.userData, { recursive: true, force: true })
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('WINDOW_WEB_PREFERENCES', () => {
  it('states every security setting and points at the built preload script', () => {
    expect(WINDOW_WEB_PREFERENCES).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true })
    expect(WINDOW_WEB_PREFERENCES.preload).toMatch(/[\\/]preload[\\/]index\.js$/)
  })
})

describe('startApp', () => {
  it('opens one hidden, secure window once Electron is ready', async () => {
    await startAndWaitUntilReady()

    expect(onlyWindow().options).toEqual({
      width: 1280,
      height: 800,
      minWidth: 1100,
      minHeight: 700,
      show: false,
      titleBarStyle: 'hiddenInset',
      backgroundColor: '#0A0B0F',
      webPreferences: WINDOW_WEB_PREFERENCES,
    })
  })

  it('shows the window when it is ready to show', async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()

    expect(window.show).not.toHaveBeenCalled()
    window.onceHandlers.get('ready-to-show')?.()
    expect(window.show).toHaveBeenCalledOnce()
  })

  it('denies popups and blocks navigation', async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()

    expect(window.webContents.windowOpenHandler?.()).toEqual({ action: 'deny' })
    const event = { preventDefault: vi.fn() }
    window.handlers.get('will-navigate')?.(event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
  })

  it('loads the dev server URL in development', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    await startAndWaitUntilReady()
    const window = onlyWindow()

    expect(window.loadURL).toHaveBeenCalledWith('http://localhost:5173')
    expect(window.loadFile).not.toHaveBeenCalled()
  })

  it('loads the built renderer when there is no dev server', async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()

    expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]renderer[\\/]index\.html$/))
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('loads the built renderer when packaged, even with a dev server URL', async () => {
    electron.app.isPackaged = true
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')
    await startAndWaitUntilReady()
    const window = onlyWindow()

    expect(window.loadFile).toHaveBeenCalledOnce()
    expect(window.loadURL).not.toHaveBeenCalled()
  })

  it('reopens a window on activate only when none are open', async () => {
    await startAndWaitUntilReady()
    const activate = appHandler('activate')

    activate()
    expect(electron.windows).toHaveLength(1)

    electron.windows.length = 0
    activate()
    expect(electron.windows).toHaveLength(1)
  })

  it('refuses to start, without opening a window, when a security setting is off', async () => {
    WINDOW_WEB_PREFERENCES.sandbox = false
    try {
      await startAndWaitUntilReady()
    } finally {
      WINDOW_WEB_PREFERENCES.sandbox = true
    }

    expect(electron.windows).toHaveLength(0)
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Glade refused to start',
      "The window's security settings are not in effect.\n\nsandbox must be true (was false)",
    )
    expect(console.error).toHaveBeenCalledWith(
      'Glade refused to start: insecure window settings\nsandbox must be true (was false)',
    )
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(electron.appHandlers.has('activate')).toBe(false)
  })

  it('opens and migrates glade.db in the data folder before opening the window', async () => {
    await startAndWaitUntilReady()

    const file = join(electron.app.userData, 'glade.db')
    expect(console.log).toHaveBeenCalledWith(`Database opened at ${file}; schema version 0 -> 1`)
    expect(onlyWindow()).toBeDefined()
    const db = new Database(file, { readonly: true })
    try {
      expect(db.prepare('SELECT MAX(version) FROM schema_version').pluck().get()).toBe(1)
    } finally {
      db.close()
    }
  })

  it('closes the database when the app quits', async () => {
    await startAndWaitUntilReady()
    const close = vi.spyOn(Database.prototype, 'close')

    appHandler('will-quit')()

    expect(close).toHaveBeenCalledOnce()
  })

  it('refuses to start, without opening a window, when the database cannot be opened', async () => {
    const dataDir = electron.app.userData
    electron.app.userData = join(dataDir, 'missing')
    try {
      await startAndWaitUntilReady()
    } finally {
      electron.app.userData = dataDir
    }

    expect(electron.windows).toHaveLength(0)
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Glade refused to start',
      'The database could not be opened.\n\nCannot open database because the directory does not exist',
    )
    expect(console.error).toHaveBeenCalledWith(
      'Glade refused to start: could not open the database\nCannot open database because the directory does not exist',
    )
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(electron.appHandlers.has('will-quit')).toBe(false)
  })

  it('says which migration failed, and why, when migrating fails', async () => {
    // A stray table the first migration is about to create makes it fail.
    const db = new Database(join(electron.app.userData, 'glade.db'))
    db.exec('CREATE TABLE schema_version (version INTEGER)')
    db.close()

    await startAndWaitUntilReady()

    expect(electron.windows).toHaveLength(0)
    expect(electron.dialog.showErrorBox).toHaveBeenCalledWith(
      'Glade refused to start',
      'The database could not be opened.\n\nMigration 1 (Create the schema version table) failed: table schema_version already exists',
    )
  })

  it('quits when every window is closed, except on macOS', () => {
    startApp()
    const windowAllClosed = appHandler('window-all-closed')

    Object.defineProperty(process, 'platform', { value: 'darwin' })
    windowAllClosed()
    expect(electron.app.quit).not.toHaveBeenCalled()

    Object.defineProperty(process, 'platform', { value: 'linux' })
    windowAllClosed()
    expect(electron.app.quit).toHaveBeenCalledOnce()
  })
})
