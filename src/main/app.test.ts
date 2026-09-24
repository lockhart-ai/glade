import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_CHANNEL, CommandName, EVENT_CHANNEL, EventType } from '../shared/bridge'
import { UiStateKey } from '../shared/domain'
import { CAPTURE_ENV, type CaptureSpec } from './capture'
import { FakeAgentBackend } from './agent/fake-backend'
import { E2E_CHOSEN_FOLDER_ENV, E2E_ENV, E2E_WINDOW_SIZE, type E2eSpec } from './e2e'
import { MIGRATIONS } from './db/migrations'
import { sampleTask, sampleWorkspace } from './db/repositories/test-database'
import { CHOOSE_FOLDER_OPTIONS } from './dialogs'

type Handler = (...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  const appHandlers = new Map<string, Handler>()
  const windows: FakeWindow[] = []
  // Every window's page captures as the same PNG; a test can make it fail.
  const capturePage = vi.fn(() =>
    Promise.resolve({
      getSize: () => ({ width: 1100, height: 700 }),
      resize: vi.fn(),
      toPNG: () => Buffer.from('png'),
    }),
  )

  class FakeWindow {
    readonly options: unknown
    readonly handlers = new Map<string, Handler>()
    readonly onceHandlers = new Map<string, Handler>()
    readonly show = vi.fn()
    readonly loadURL = vi.fn(() => Promise.resolve())
    readonly loadFile = vi.fn(() => Promise.resolve())
    readonly setContentSize = vi.fn()
    readonly webContents = {
      send: vi.fn(),
      // The page is always ready, at whatever size it was asked for.
      executeJavaScript: vi.fn(() => Promise.resolve(true)),
      capturePage,
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
    static getFocusedWindow = vi.fn((): FakeWindow | null => windows[0] ?? null)
  }

  return {
    appHandlers,
    windows,
    capturePage,
    FakeWindow,
    app: {
      isPackaged: false,
      userData: '',
      setPath: vi.fn((name: string, path: string) => {
        if (name !== 'userData') throw new Error(`unexpected setPath(${name})`)
        electron.app.userData = path
      }),
      dock: { hide: vi.fn() },
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
    dialog: {
      showErrorBox: vi.fn(),
      showOpenDialog: vi.fn(() => Promise.resolve({ canceled: false, filePaths: ['/code/acme-api'] })),
    },
    ipcMain: { handle: vi.fn<(channel: string, listener: Handler) => void>() },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.FakeWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
}))

// The real agent backend, watched: a test mode must never make one.
vi.mock('./agent/sdk-backend', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agent/sdk-backend')>()
  return { ...original, createSdkBackend: vi.fn(original.createSdkBackend) }
})
const { createSdkBackend } = await import('./agent/sdk-backend')

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

    expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/[\\/]renderer[\\/]index\.html$/), { hash: '' })
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
    expect(console.log).toHaveBeenCalledWith(
      `Database opened at ${file}; schema version 0 -> ${String(MIGRATIONS.length)}`,
    )
    expect(onlyWindow()).toBeDefined()
    const db = new Database(file, { readonly: true })
    try {
      expect(db.prepare('SELECT MAX(version) FROM schema_version').pluck().get()).toBe(MIGRATIONS.length)
    } finally {
      db.close()
    }
  })

  it('answers commands and broadcasts their events to every open window', async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()
    expect(electron.ipcMain.handle).toHaveBeenCalledOnce()
    const [channel, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
    expect(channel).toBe(COMMAND_CHANNEL)

    const entry = { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' }
    await expect(handler?.({}, CommandName.UiStateSet, entry)).resolves.toEqual({ ok: true, value: null })

    expect(window.webContents.send).toHaveBeenCalledWith(EVENT_CHANNEL, { type: EventType.UiStateChanged, entry })
  })

  it('runs the agents on the backend it was started with, and closes their sessions when the app quits', async () => {
    const backend = new FakeAgentBackend()
    startApp({ createAgentBackend: () => backend })
    await Promise.resolve()
    await Promise.resolve()
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const task = sampleTask(db, sampleWorkspace(db).id)
    db.close()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await expect(handler?.({}, CommandName.TasksSend, { id: task.id, text: 'Hi' })).resolves.toMatchObject({ ok: true })
    appHandler('will-quit')()

    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Hi'])
    expect(backend.session.closed).toBe(true)
  })

  it('runs the agents on the Claude Agent SDK by default', async () => {
    await startAndWaitUntilReady()

    expect(createSdkBackend).toHaveBeenCalledOnce()
  })

  it('shows the open-folder dialog as a sheet on the focused window', async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await expect(handler?.({}, CommandName.DialogChooseFolder, {})).resolves.toEqual({
      ok: true,
      value: { path: '/code/acme-api' },
    })
    expect(electron.dialog.showOpenDialog).toHaveBeenCalledWith(window, CHOOSE_FOLDER_OPTIONS)
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

describe('startApp in capture mode', () => {
  let outDir: string

  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'glade-app-shots-'))
  })

  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true })
  })

  function askForCapture(overrides: Partial<CaptureSpec> = {}): void {
    const spec: CaptureSpec = {
      outDir,
      userData: electron.app.userData,
      route: '#gallery',
      shots: [{ width: 1100, height: 700, file: 'gallery-1100x700.png' }],
      timeoutMs: 5000,
      ...overrides,
    }
    vi.stubEnv(CAPTURE_ENV, JSON.stringify(spec))
  }

  async function waitForExit(): Promise<void> {
    await vi.waitFor(() => {
      expect(electron.app.exit).toHaveBeenCalled()
    })
  }

  it('captures the page in a window that is never shown, then exits cleanly', async () => {
    askForCapture()
    const userData = electron.app.userData
    const close = vi.spyOn(Database.prototype, 'close')

    await startAndWaitUntilReady()
    await waitForExit()

    expect(electron.app.setPath).toHaveBeenCalledWith('userData', userData)
    expect(electron.app.dock.hide).toHaveBeenCalledOnce()
    const window = onlyWindow()
    expect(window.options).toMatchObject({
      show: false,
      paintWhenInitiallyHidden: true,
      webPreferences: WINDOW_WEB_PREFERENCES,
    })
    expect(window.onceHandlers.has('ready-to-show')).toBe(false)
    expect(window.show).not.toHaveBeenCalled()
    expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/index\.html$/), { hash: 'gallery' })
    expect(readFileSync(join(outDir, 'gallery-1100x700.png'), 'utf8')).toBe('png')
    expect(console.log).toHaveBeenCalledWith(`Captured ${join(outDir, 'gallery-1100x700.png')}`)
    expect(close).toHaveBeenCalledOnce()
    expect(createSdkBackend).not.toHaveBeenCalled()
    expect(electron.app.exit).toHaveBeenCalledWith(0)
    expect(electron.appHandlers.has('activate')).toBe(false)
    expect(electron.appHandlers.has('will-quit')).toBe(false)
  })

  it('opens the route on the dev server when there is one', async () => {
    askForCapture()
    vi.stubEnv('ELECTRON_RENDERER_URL', 'http://localhost:5173')

    await startAndWaitUntilReady()
    await waitForExit()

    expect(onlyWindow().loadURL).toHaveBeenCalledWith('http://localhost:5173#gallery')
  })

  it('exits with an error when capturing fails', async () => {
    askForCapture()
    electron.capturePage.mockRejectedValueOnce(new Error('no page'))

    await startAndWaitUntilReady()
    await waitForExit()

    expect(console.error).toHaveBeenCalledWith('Glade capture failed: no page')
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(existsSync(join(outDir, 'gallery-1100x700.png'))).toBe(false)
  })

  it('fills the database from the seed fixture before opening the window', async () => {
    const seed = join(outDir, 'seed.json')
    writeFileSync(seed, JSON.stringify({ workspace: { name: 'Acme API', rootPath: '/code/api' }, tasks: [] }))
    askForCapture({ seed })

    await startAndWaitUntilReady()
    await waitForExit()

    expect(electron.app.exit).toHaveBeenCalledWith(0)
    const db = new Database(join(electron.app.userData, 'glade.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT name FROM workspaces').all()).toEqual([{ name: 'Acme API' }])
    } finally {
      db.close()
    }
  })

  it('exits with an error, without opening a window, when the seed fixture is bad', async () => {
    askForCapture({ seed: join(outDir, 'missing.json') })
    const close = vi.spyOn(Database.prototype, 'close')

    await startAndWaitUntilReady()

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Glade capture failed: the seed .* can't be read/),
    )
    expect(electron.windows).toHaveLength(0)
    expect(close).toHaveBeenCalledOnce()
    expect(electron.app.exit).toHaveBeenCalledWith(1)
  })

  it('exits with an error, before Electron is ready, when the spec is invalid', () => {
    vi.stubEnv(CAPTURE_ENV, '{')

    startApp()

    expect(console.error).toHaveBeenCalledWith(
      expect.stringMatching(/^Glade test mode failed: GLADE_CAPTURE is not JSON/),
    )
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(electron.app.whenReady).not.toHaveBeenCalled()
    expect(electron.app.setPath).not.toHaveBeenCalled()
  })

  it('refuses to start without a dialog when a security setting is off', async () => {
    askForCapture()
    WINDOW_WEB_PREFERENCES.sandbox = false
    try {
      await startAndWaitUntilReady()
    } finally {
      WINDOW_WEB_PREFERENCES.sandbox = true
    }

    expect(electron.windows).toHaveLength(0)
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(electron.app.exit).toHaveBeenCalledWith(1)
  })

  it('never captures in a packaged app', async () => {
    electron.app.isPackaged = true
    askForCapture()

    await startAndWaitUntilReady()

    expect(electron.app.setPath).not.toHaveBeenCalled()
    expect(electron.app.dock.hide).not.toHaveBeenCalled()
    const window = onlyWindow()
    window.onceHandlers.get('ready-to-show')?.()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.webContents.capturePage).not.toHaveBeenCalled()
  })
})

describe('startApp in e2e mode', () => {
  function askForE2e(overrides: Partial<E2eSpec> = {}): void {
    vi.stubEnv(E2E_ENV, JSON.stringify({ userData: electron.app.userData, route: '', ...overrides }))
  }

  it('runs the app in a window that is never shown, at the recording size, with a throwaway data folder', async () => {
    askForE2e({ route: '#gallery' })
    const userData = electron.app.userData

    await startAndWaitUntilReady()

    expect(electron.app.setPath).toHaveBeenCalledWith('userData', userData)
    expect(electron.app.dock.hide).toHaveBeenCalledOnce()
    const window = onlyWindow()
    expect(window.options).toMatchObject({ show: false, paintWhenInitiallyHidden: true })
    expect(window.onceHandlers.has('ready-to-show')).toBe(false)
    expect(window.setContentSize).toHaveBeenCalledWith(E2E_WINDOW_SIZE.width, E2E_WINDOW_SIZE.height)
    expect(window.loadFile).toHaveBeenCalledWith(expect.stringMatching(/index\.html$/), { hash: 'gallery' })
    expect(existsSync(join(userData, 'glade.db'))).toBe(true)
    // Otherwise it's the normal app, which the test quits.
    expect(electron.app.exit).not.toHaveBeenCalled()
    expect(electron.appHandlers.has('will-quit')).toBe(true)
  })

  it('answers the folder dialog with the folder the test chose, without showing it', async () => {
    askForE2e()
    await startAndWaitUntilReady()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    vi.stubEnv(E2E_CHOSEN_FOLDER_ENV, '/tmp/acme-api')
    await expect(handler?.({}, CommandName.DialogChooseFolder, {})).resolves.toEqual({
      ok: true,
      value: { path: '/tmp/acme-api' },
    })
    vi.stubEnv(E2E_CHOSEN_FOLDER_ENV, undefined)
    await expect(handler?.({}, CommandName.DialogChooseFolder, {})).resolves.toEqual({
      ok: true,
      value: { path: null },
    })
    expect(electron.dialog.showOpenDialog).not.toHaveBeenCalled()
  })

  it('never runs the real agent, even when started with another backend: an agent session fails loudly', async () => {
    askForE2e()
    const backend = new FakeAgentBackend()
    const createAgentBackend = vi.fn(() => backend)
    startApp({ createAgentBackend })
    await Promise.resolve()
    await Promise.resolve()
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const task = sampleTask(db, sampleWorkspace(db).id)
    db.close()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await expect(handler?.({}, CommandName.TasksSend, { id: task.id, text: 'Hi' })).resolves.toMatchObject({
      ok: false,
    })

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Glade test mode: An agent session started/))
    expect(createAgentBackend).not.toHaveBeenCalled()
    expect(createSdkBackend).not.toHaveBeenCalled()
    expect(backend.sessions).toHaveLength(0)
  })

  it('never makes the real agent backend by default either', async () => {
    askForE2e()

    await startAndWaitUntilReady()

    expect(electron.ipcMain.handle).toHaveBeenCalledOnce()
    expect(createSdkBackend).not.toHaveBeenCalled()
  })

  it('reopens a hidden window on activate', async () => {
    askForE2e()
    await startAndWaitUntilReady()
    electron.windows.length = 0

    appHandler('activate')()

    expect(onlyWindow().options).toMatchObject({ show: false, paintWhenInitiallyHidden: true })
  })

  it('refuses to start without a dialog when the database cannot be opened', async () => {
    askForE2e()
    const db = new Database(join(electron.app.userData, 'glade.db'))
    db.exec('CREATE TABLE schema_version (version INTEGER)')
    db.close()

    await startAndWaitUntilReady()

    expect(electron.windows).toHaveLength(0)
    expect(electron.dialog.showErrorBox).not.toHaveBeenCalled()
    expect(electron.app.exit).toHaveBeenCalledWith(1)
  })

  it('exits with an error, before Electron is ready, when the spec is invalid', () => {
    askForE2e({ userData: '/Users/someone/Library/Application Support/glade' })

    startApp()

    expect(console.error).toHaveBeenCalledWith(expect.stringMatching(/^Glade test mode failed: GLADE_E2E is invalid/))
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(electron.app.whenReady).not.toHaveBeenCalled()
  })

  it('never runs in a packaged app', async () => {
    electron.app.isPackaged = true
    askForE2e()

    await startAndWaitUntilReady()

    expect(electron.app.setPath).not.toHaveBeenCalled()
    const window = onlyWindow()
    window.onceHandlers.get('ready-to-show')?.()
    expect(window.show).toHaveBeenCalledOnce()
  })
})
