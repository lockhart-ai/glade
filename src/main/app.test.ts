import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_CHANNEL, CommandName, EVENT_CHANNEL, EventType, RendererErrorKind } from '../shared/bridge'
import { appCommand, AppCommandId, EMPTY_MENU_STATE } from '../shared/commands'
import { MessageRole, TaskActivity, UiStateKey } from '../shared/domain'
import { CAPTURE_ENV, type CaptureSpec } from './capture'
import { FakeAgentBackend, settle } from './agent/fake-backend'
import * as sdk from './agent/test-sdk-messages'
import { RESUME_PROMPT } from './agent/runner'
import {
  E2E_AGENT_ENVS_GLOBAL,
  E2E_CHOSEN_FOLDER_ENV,
  E2E_ENV,
  E2E_NOTIFIER_GLOBAL,
  E2E_WINDOW_SIZE,
  type E2eAgentEnvs,
  type E2eSpec,
} from './e2e'
import { openAppDatabase } from './db/database'
import { MIGRATIONS } from './db/migrations'
import { appendMessage } from './db/repositories/messages'
import { updateTask } from './db/repositories/tasks'
import { getUiState, setUiState } from './db/repositories/ui-state'
import { sampleTask, sampleWorkspace } from './db/repositories/test-database'
import { CHOOSE_FOLDER_OPTIONS } from './dialogs'
import type { RecordingNotifier } from './notifications/recording-notifier'
import type { SdkBackendOptions } from './agent/sdk-backend'
import type { LoginEnvOptions } from './login-env'
import { markRunning } from './relaunch'
import type { FileLogSinkOptions } from './logging/file-sink'
import { createFakeSpawner } from './terminal/fake-pty'
import { serializeRelaunchNotice } from '../shared/relaunchNotice'

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
    readonly isMinimized = vi.fn(() => false)
    readonly restore = vi.fn()
    readonly focus = vi.fn()
    readonly close = vi.fn()
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

  // Every native notification made, with its listeners, so a test can click one.
  const notifications: FakeNotification[] = []
  class FakeNotification {
    readonly listeners = new Map<string, Handler>()
    readonly show = vi.fn()
    constructor(readonly options: unknown) {
      notifications.push(this)
    }
    on(event: string, listener: Handler): this {
      this.listeners.set(event, listener)
      return this
    }
    static isSupported = (): boolean => true
  }

  return {
    appHandlers,
    windows,
    capturePage,
    FakeWindow,
    notifications,
    FakeNotification,
    app: {
      name: 'Glade',
      isPackaged: false,
      userData: '',
      /** Electron's logs folder: a throwaway one, so a unit test never writes to yours. */
      logs: '',
      setPath: vi.fn((name: string, path: string) => {
        if (name !== 'userData') throw new Error(`unexpected setPath(${name})`)
        electron.app.userData = path
      }),
      dock: { hide: vi.fn() },
      getPath: vi.fn((name: string): string => {
        if (name === 'home') return '/Users/sample'
        if (name === 'logs') return electron.app.logs
        if (name !== 'userData') throw new Error(`unexpected getPath(${name})`)
        return electron.app.userData
      }),
      getVersion: () => '0.0.0-sample',
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
    shell: { openPath: vi.fn(() => Promise.resolve('')), showItemInFolder: vi.fn() },
    clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    // The menu bar: each built menu is its template, and the one set last is the menu bar.
    Menu: {
      buildFromTemplate: vi.fn((template: unknown[]) => ({ template })),
      setApplicationMenu: vi.fn<(menu: { template: unknown[] }) => void>(),
    },
  }
})

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.FakeWindow,
  dialog: electron.dialog,
  ipcMain: electron.ipcMain,
  Notification: electron.FakeNotification,
  net: { isOnline: () => true },
  shell: electron.shell,
  clipboard: electron.clipboard,
  Menu: electron.Menu,
}))

// The real agent backend, watched: a test mode must never make one.
vi.mock('./agent/sdk-backend', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agent/sdk-backend')>()
  return { ...original, createSdkBackend: vi.fn(original.createSdkBackend) }
})
const { createSdkBackend } = await import('./agent/sdk-backend')

// Reading the login shell's environment, watched, and kept off the machine's own shell and profile: it falls back to
// the app's own environment unless a test runs the real resolver on a fake shell (`useRealLoginEnv`).
vi.mock('./login-env', async (importOriginal) => {
  const original = await importOriginal<typeof import('./login-env')>()
  return {
    ...original,
    resolveLoginEnv: vi.fn((options: LoginEnvOptions) =>
      Promise.resolve({ source: original.LoginEnvSource.Fallback, env: original.definedEnv(options.base), reason: '' }),
    ),
  }
})
const { resolveLoginEnv } = await import('./login-env')
const realLoginEnv = await vi.importActual<typeof import('./login-env')>('./login-env')

/**
 * Has the app read the login shell's environment for real, once, from a fake login shell: a `/bin/sh` script that adds
 * `/opt/sample/bin` to PATH, as a profile would. It runs in the temp folder, since the fake home doesn't exist.
 */
function useRealLoginEnv(): void {
  const shell = join(electron.app.userData, 'login-shell')
  writeFileSync(shell, '#!/bin/sh\nexport PATH="/opt/sample/bin:$PATH"\nexec /bin/sh -c "$2"\n', { mode: 0o755 })
  vi.stubEnv('SHELL', shell)
  vi.mocked(resolveLoginEnv).mockImplementationOnce((options) =>
    realLoginEnv.resolveLoginEnv({ ...options, cwd: electron.app.userData, log: { info: vi.fn(), warn: vi.fn() } }),
  )
}

/** launchd's PATH: what an app opened from Finder or the Dock starts with. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

// The log file, watched, and kept off the terminal: a test reads the file instead.
vi.mock('./logging/file-sink', async (importOriginal) => {
  const original = await importOriginal<typeof import('./logging/file-sink')>()
  return {
    ...original,
    createFileLogSink: vi.fn((options: FileLogSinkOptions) =>
      original.createFileLogSink({ ...options, toConsole: false }),
    ),
  }
})
const { createFileLogSink } = await import('./logging/file-sink')

const { startApp, WINDOW_WEB_PREFERENCES } = await import('./app')

/** A line of the log file, as JSON. */
interface LogLine {
  readonly time: string
  readonly level: string
  readonly scope: string
  readonly taskId?: string
  readonly msg: string
  readonly [field: string]: unknown
}

/** The log file's lines: in Electron's logs folder, or in a test mode's data folder. */
function logLines(dir: string = electron.app.logs): LogLine[] {
  const file = join(dir, 'main.log')
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as LogLine)
}

/** The log file's lines saying `msg`. */
function logged(msg: string, dir?: string): LogLine[] {
  return logLines(dir).filter((line) => line.msg === msg)
}

/** A test mode's log folder, in its throwaway data folder. */
function testModeLogs(): string {
  return join(electron.app.userData, 'logs')
}

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

/**
 * Starts the app on a fake agent with two tasks, the second one selected, and has the first one's agent reply. Resolves
 * with the tasks' ids.
 */
async function replyInUnviewedTask(): Promise<{ replied: string; viewed: string; backend: FakeAgentBackend }> {
  const backend = new FakeAgentBackend()
  startApp({ createAgentBackend: () => backend })
  await Promise.resolve()
  await Promise.resolve()
  const db = new Database(join(electron.app.userData, 'glade.db'))
  const workspace = sampleWorkspace(db)
  const replied = sampleTask(db, workspace.id)
  updateTask(db, replied.id, { title: 'Fix the login redirect' })
  const viewed = sampleTask(db, workspace.id)
  db.close()
  const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
  await handler?.({}, CommandName.UiStateSet, { key: UiStateKey.SelectedTaskId, value: viewed.id })
  await handler?.({}, CommandName.TasksSend, { id: replied.id, text: 'Why does it redirect twice?' })
  backend.session.emit(sdk.init(), sdk.text('It was a **race**.'), sdk.result('It was a **race**.'))
  await settle()
  return { replied: replied.id, viewed: viewed.id, backend }
}

/** The one native notification made. */
function onlyNotification(): InstanceType<typeof electron.FakeNotification> {
  expect(electron.notifications).toHaveLength(1)
  const notification = electron.notifications[0]
  if (notification === undefined) throw new Error('no notification')
  return notification
}

const originalPlatform = process.platform

/** The crash listeners on `process` before each test, so the ones a test's app adds can go afterwards. */
let exceptionListeners: NodeJS.UncaughtExceptionListener[]
let rejectionListeners: NodeJS.UnhandledRejectionListener[]

beforeEach(() => {
  exceptionListeners = process.listeners('uncaughtExceptionMonitor')
  rejectionListeners = process.listeners('unhandledRejection')
  vi.clearAllMocks()
  electron.appHandlers.clear()
  electron.windows.length = 0
  electron.notifications.length = 0
  Reflect.deleteProperty(globalThis, E2E_NOTIFIER_GLOBAL)
  electron.app.isPackaged = false
  electron.app.userData = mkdtempSync(join(tmpdir(), 'glade-app-'))
  electron.app.logs = mkdtempSync(join(tmpdir(), 'glade-app-logs-'))
  vi.stubEnv('ELECTRON_RENDERER_URL', undefined)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

afterEach(() => {
  // Close the database the way quitting the app does, so the temp folder can go.
  electron.appHandlers.get('will-quit')?.()
  rmSync(electron.app.userData, { recursive: true, force: true })
  rmSync(electron.app.logs, { recursive: true, force: true })
  // The app watches for crashes until it quits; one that never got that far leaves its listeners behind.
  for (const listener of process.listeners('uncaughtExceptionMonitor')) {
    if (!exceptionListeners.includes(listener)) process.off('uncaughtExceptionMonitor', listener)
  }
  for (const listener of process.listeners('unhandledRejection')) {
    if (!rejectionListeners.includes(listener)) process.off('unhandledRejection', listener)
  }
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
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 8 },
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
    expect(logged('refused to start')).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'app',
        reason: 'insecure window settings',
        detail: 'sandbox must be true (was false)',
      }),
    ])
    expect(electron.app.exit).toHaveBeenCalledWith(1)
    expect(electron.appHandlers.has('activate')).toBe(false)
  })

  it('opens and migrates glade.db in the data folder before opening the window', async () => {
    await startAndWaitUntilReady()

    const file = join(electron.app.userData, 'glade.db')
    expect(logged('database opened')).toEqual([
      expect.objectContaining({
        level: 'info',
        scope: 'db',
        file,
        fromVersion: 0,
        toVersion: MIGRATIONS.length,
        migrated: true,
      }),
    ])
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

  it('sets the menu bar, rebuilds it from what the window shows, and sends its commands to the window', async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
    const menus = electron.Menu.setApplicationMenu.mock.calls
    const fileMenu = (): { label: string; click: () => void; enabled: boolean }[] => {
      const [menu] = menus[menus.length - 1] ?? []
      const { template } = menu as { template: { label: string; submenu: unknown }[] }
      return template.find(({ label }) => label === 'File')?.submenu as {
        label: string
        click: () => void
        enabled: boolean
      }[]
    }
    expect(menus).toHaveLength(1)
    expect(fileMenu()[0]?.enabled).toBe(false)

    const state = { ...EMPTY_MENU_STATE, workspaces: [{ id: 'w1', name: 'Acme API' }], shownWorkspaceId: 'w1' }
    await expect(handler?.({}, CommandName.MenuUpdate, state)).resolves.toEqual({ ok: true, value: null })
    expect(fileMenu()[0]?.enabled).toBe(true)
    fileMenu()[0]?.click()

    expect(window.webContents.send).toHaveBeenCalledWith(EVENT_CHANNEL, {
      type: EventType.MenuCommand,
      command: appCommand(AppCommandId.NewTask),
    })
  })

  it('closes the focused window when the window asks', async () => {
    await startAndWaitUntilReady()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await expect(handler?.({}, CommandName.WindowClose, {})).resolves.toEqual({ ok: true, value: null })

    expect(onlyWindow().close).toHaveBeenCalledOnce()
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

  it('runs the terminal tabs’ shells as your login shell, from your home folder, and ends them when the app quits', async () => {
    vi.stubEnv('SHELL', '/bin/zsh')
    const spawner = createFakeSpawner()
    startApp({ spawnPty: spawner.spawn })
    await Promise.resolve()
    await Promise.resolve()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    const created = (await handler?.({}, CommandName.TerminalCreate, { workspaceId: null })) as {
      value: { tab: { id: string; cwd: string } }
    }
    expect(created.value.tab.cwd).toBe('/Users/sample')
    await handler?.({}, CommandName.TerminalAttach, { id: created.value.tab.id, cols: 80, rows: 24 })
    expect(spawner.spawned[0]?.options).toMatchObject({ file: '/bin/zsh', args: ['-l'] })
    appHandler('will-quit')()

    expect(spawner.spawned[0]?.killed).toBe(true)
  })

  it('resumes the turns it last quit in before opening the window', async () => {
    const { db } = openAppDatabase(electron.app.userData)
    const task = sampleTask(db, sampleWorkspace(db).id)
    appendMessage(db, { taskId: task.id, role: MessageRole.User, body: 'Run the suite.', turn: 1 })
    updateTask(db, task.id, { activity: TaskActivity.Working, sessionId: 'session-1' })
    db.close()
    const backend = new FakeAgentBackend()
    startApp({ createAgentBackend: () => backend })
    await Promise.resolve()
    await Promise.resolve()

    expect(backend.session.options.resumeSessionId).toBe('session-1')
    expect(backend.session.sent.map(({ text }) => text)).toEqual([RESUME_PROMPT])
    expect(onlyWindow()).toBeDefined()
  })

  it("carries the window's selected task over as its workspace's selection, on a database from before workspaces kept one", async () => {
    const { db } = openAppDatabase(electron.app.userData, MIGRATIONS.slice(0, 16))
    const acme = sampleWorkspace(db)
    const task = sampleTask(db, acme.id)
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: acme.id })
    setUiState(db, { key: UiStateKey.SelectedTaskId, value: task.id })
    db.close()

    await startAndWaitUntilReady()

    // Adding a second workspace and switching back before selecting anything shows the task again.
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
    const other = mkdtempSync(join(tmpdir(), 'glade-web-'))
    try {
      const added = (await handler?.({}, CommandName.WorkspacesCreate, { rootPath: other })) as {
        ok: true
        value: { workspace: { id: string } }
      }
      await handler?.({}, CommandName.WorkspacesOpen, { id: added.value.workspace.id })
      expect(await handler?.({}, CommandName.WorkspacesOpen, { id: acme.id })).toMatchObject({
        ok: true,
        value: { selectedTaskId: task.id },
      })
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })

  /** Starts the app on a database whose last run left a task mid-turn, and answers with the task's id. */
  async function startAfterRun({ crashed }: { crashed: boolean }): Promise<string> {
    const { db } = openAppDatabase(electron.app.userData)
    const task = sampleTask(db, sampleWorkspace(db).id)
    appendMessage(db, { taskId: task.id, role: MessageRole.User, body: 'Run the suite.', turn: 1 })
    updateTask(db, task.id, { activity: TaskActivity.Working, sessionId: 'session-1' })
    if (crashed) markRunning(db)
    db.close()
    startApp({ createAgentBackend: () => new FakeAgentBackend() })
    await Promise.resolve()
    await Promise.resolve()
    return task.id
  }

  function relaunchNotice(): string | undefined {
    const db = new Database(join(electron.app.userData, 'glade.db'))
    try {
      return getUiState(db, UiStateKey.RelaunchNotice)
    } finally {
      db.close()
    }
  }

  it('saves the relaunch notice when the last run crashed with tasks mid-turn', async () => {
    const taskId = await startAfterRun({ crashed: true })

    expect(relaunchNotice()).toBe(serializeRelaunchNotice({ taskIds: [taskId] }))
  })

  it('resumes without a notice after a clean quit, and clears the running mark when it quits', async () => {
    await startAfterRun({ crashed: false })

    expect(relaunchNotice()).toBeUndefined()
    appHandler('will-quit')()
    const { db } = openAppDatabase(electron.app.userData)
    expect(markRunning(db)).toBe(false)
    db.close()
  })

  it("notifies a reply in a task you aren't viewing with a silent native notification", async () => {
    await replyInUnviewedTask()

    const notification = onlyNotification()
    expect(notification.options).toEqual({
      title: 'Fix the login redirect',
      body: 'It was a race.',
      silent: true,
      actions: [{ type: 'button', text: 'Open task' }],
      hasReply: true,
      replyPlaceholder: 'Reply…',
    })
    expect(notification.show).toHaveBeenCalledOnce()
  })

  it("sends a notification's inline reply to its task's agent, leaving the window alone", async () => {
    const { replied, backend } = await replyInUnviewedTask()
    const window = onlyWindow()
    window.webContents.send.mockClear()

    const reply = onlyNotification().listeners.get('reply')
    reply?.({ reply: 'Add a test for it.' })
    // The agent is working on that now, so a second reply waits in the queue.
    reply?.({ reply: 'And a changelog entry.' })

    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Why does it redirect twice?', 'Add a test for it.'])
    const db = new Database(join(electron.app.userData, 'glade.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT body FROM queued_messages WHERE task_id = ?').all(replied)).toEqual([
        { body: 'And a changelog entry.' },
      ])
    } finally {
      db.close()
    }
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.webContents.send).not.toHaveBeenCalledWith(EVENT_CHANNEL, {
      type: EventType.TaskOpenRequested,
      taskId: replied,
    })
  })

  it("opens the task when its notification's Open task action is chosen", async () => {
    const { replied } = await replyInUnviewedTask()

    onlyNotification().listeners.get('action')?.({ actionIndex: 0 })

    expect(onlyWindow().webContents.send).toHaveBeenLastCalledWith(EVENT_CHANNEL, {
      type: EventType.TaskOpenRequested,
      taskId: replied,
    })
  })

  it("brings the window up and asks it to open the task when the task's notification is clicked", async () => {
    const { replied } = await replyInUnviewedTask()
    const window = onlyWindow()
    window.isMinimized.mockReturnValue(true)

    onlyNotification().listeners.get('click')?.()

    expect(window.restore).toHaveBeenCalledOnce()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
    expect(window.webContents.send).toHaveBeenLastCalledWith(EVENT_CHANNEL, {
      type: EventType.TaskOpenRequested,
      taskId: replied,
    })
  })

  it('leaves a window that is not minimised as it is, other than showing and focusing it', async () => {
    await replyInUnviewedTask()
    const window = onlyWindow()

    onlyNotification().listeners.get('click')?.()

    expect(window.restore).not.toHaveBeenCalled()
    expect(window.show).toHaveBeenCalledOnce()
    expect(window.focus).toHaveBeenCalledOnce()
  })

  it('opens a window on the task, reading it, when its notification is clicked with every window closed', async () => {
    const { replied } = await replyInUnviewedTask()
    electron.windows.length = 0

    onlyNotification().listeners.get('click')?.()

    const window = onlyWindow()
    expect(window.options).toMatchObject({ show: false })
    window.onceHandlers.get('ready-to-show')?.()
    expect(window.show).toHaveBeenCalledOnce()
    const db = new Database(join(electron.app.userData, 'glade.db'), { readonly: true })
    try {
      const selected = db.prepare('SELECT value FROM ui_state WHERE key = ?').get(UiStateKey.SelectedTaskId)
      expect(selected).toEqual({ value: replied })
      expect(db.prepare('SELECT unread FROM tasks WHERE id = ?').get(replied)).toEqual({ unread: 0 })
    } finally {
      db.close()
    }
  })

  it('runs the agents on the Claude Agent SDK by default, in the login shell’s environment', async () => {
    await startAndWaitUntilReady()

    expect(createSdkBackend).toHaveBeenCalledExactlyOnceWith({
      env: expect.any(Promise) as unknown,
      log: expect.objectContaining({ info: expect.any(Function) as unknown }) as unknown,
    })
    expect(resolveLoginEnv).toHaveBeenCalledExactlyOnceWith({
      shell: process.env.SHELL,
      base: process.env,
      cwd: '/Users/sample',
      log: expect.objectContaining({ info: expect.any(Function) as unknown }) as unknown,
    })
  })

  it("logs the agents' environment, its PATH, and every variable but its secrets", async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-sample-secret')
    vi.stubEnv('GH_TOKEN', 'ghp_sample_secret')
    vi.stubEnv('DB_PASSWORD', 'hunter2-sample')
    vi.stubEnv('EDITOR', 'vim')

    await startAndWaitUntilReady()
    await vi.waitFor(() => {
      expect(logged('agent environment variables')).toHaveLength(1)
    })

    expect(logged('agent environment')).toEqual([
      expect.objectContaining({
        level: 'info',
        scope: 'env',
        source: 'fallback',
        shell: process.env.SHELL,
        PATH: process.env.PATH,
      }),
    ])
    expect(logged('agent environment variables')[0]?.env).toMatchObject({
      ANTHROPIC_API_KEY: '[redacted]',
      GH_TOKEN: '[redacted]',
      DB_PASSWORD: '[redacted]',
      EDITOR: 'vim',
    })
    const log = readFileSync(join(electron.app.logs, 'main.log'), 'utf8')
    expect(log).not.toContain('sk-ant-sample-secret')
    expect(log).not.toContain('ghp_sample_secret')
    expect(log).not.toContain('hunter2-sample')
  })

  it("gives the agents the login shell's PATH, read at startup from $SHELL, when opened with launchd's bare one", async () => {
    vi.stubEnv('PATH', LAUNCHD_PATH)
    useRealLoginEnv()
    const createAgentBackend = vi.fn<(options: SdkBackendOptions) => FakeAgentBackend>(() => new FakeAgentBackend())

    startApp({ createAgentBackend })
    await vi.waitFor(() => {
      expect(createAgentBackend).toHaveBeenCalledOnce()
    })

    const env = await createAgentBackend.mock.calls[0]?.[0].env
    expect(env?.PATH).toBe(`/opt/sample/bin:${LAUNCHD_PATH}`)
  })

  it("opens the window, and takes messages, while the login shell's environment is still being read", async () => {
    vi.mocked(resolveLoginEnv).mockReturnValueOnce(new Promise(() => undefined))

    await startAndWaitUntilReady()

    onlyWindow().onceHandlers.get('ready-to-show')?.()
    expect(onlyWindow().show).toHaveBeenCalledOnce()
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const task = sampleTask(db, sampleWorkspace(db).id)
    db.close()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
    // The SDK's session waits for the environment, so the test's guard on the real SDK is never reached.
    await expect(handler?.({}, CommandName.TasksSend, { id: task.id, text: 'Hi' })).resolves.toMatchObject({ ok: true })
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

  it('reveals an artifact in Finder and copies it to the clipboard', async () => {
    await startAndWaitUntilReady()
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'glade-app-files-')))
    try {
      writeFileSync(join(root, 'notes.md'), '# Notes\n')
      const db = new Database(join(electron.app.userData, 'glade.db'))
      const taskId = sampleTask(db, sampleWorkspace(db, root).id).id
      db.close()
      const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

      await handler?.({}, CommandName.FilesReveal, { taskId, path: 'notes.md' })
      await handler?.({}, CommandName.FilesCopy, { taskId, path: 'notes.md' })

      expect(electron.shell.showItemInFolder).toHaveBeenCalledExactlyOnceWith(join(root, 'notes.md'))
      expect(electron.clipboard.writeText).toHaveBeenCalledExactlyOnceWith('# Notes\n')
    } finally {
      rmSync(root, { recursive: true, force: true })
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
    expect(logged('refused to start')).toEqual([
      expect.objectContaining({
        reason: 'could not open the database',
        detail: 'Cannot open database because the directory does not exist',
      }),
    ])
    expect(logged("database couldn't be opened")).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'db',
        error: expect.objectContaining({ name: 'TypeError' }) as unknown,
      }),
    ])
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

describe('startApp logging', () => {
  it("logs to main.log in Electron's logs folder, and to the terminal outside a packaged app", async () => {
    await startAndWaitUntilReady()

    expect(createFileLogSink).toHaveBeenCalledExactlyOnceWith({ dir: electron.app.logs, toConsole: true })
    expect(logged('app starting')).toEqual([
      expect.objectContaining({
        level: 'info',
        scope: 'app',
        version: '0.0.0-sample',
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        packaged: false,
        testMode: null,
        agentBackend: 'sdk',
        logs: electron.app.logs,
      }),
    ])
  })

  it("keeps the packaged app's log off the terminal", async () => {
    electron.app.isPackaged = true

    await startAndWaitUntilReady()

    expect(createFileLogSink).toHaveBeenCalledExactlyOnceWith({ dir: electron.app.logs, toConsole: false })
  })

  it('logs the app quitting, and stops watching for crashes', async () => {
    await startAndWaitUntilReady()
    const listening = process.listenerCount('unhandledRejection')

    appHandler('will-quit')()

    expect(logged('app quitting')).toHaveLength(1)
    expect(process.listenerCount('unhandledRejection')).toBe(listening - 1)
  })

  it('logs uncaught exceptions and unhandled rejections in main', async () => {
    await startAndWaitUntilReady()

    // The app's own listeners, called as Node would: emitting the events would reach Vitest's too.
    process.listeners('uncaughtExceptionMonitor').at(-1)?.(new Error('main blew up'), 'uncaughtException')
    process.listeners('unhandledRejection').at(-1)?.(new Error('nobody caught this'), Promise.resolve())

    expect(logged('uncaught exception')).toEqual([
      expect.objectContaining({
        level: 'error',
        origin: 'uncaughtException',
        error: expect.objectContaining({ message: 'main blew up' }) as unknown,
      }),
    ])
    expect(logged('unhandled rejection')).toEqual([
      expect.objectContaining({
        level: 'error',
        reason: expect.objectContaining({ message: 'nobody caught this' }) as unknown,
      }),
    ])
  })

  it("logs the window's page failing to load, and its process dying", async () => {
    await startAndWaitUntilReady()
    const window = onlyWindow()

    window.handlers.get('did-fail-load')?.({}, -6, 'ERR_FILE_NOT_FOUND')
    window.handlers.get('render-process-gone')?.({}, { reason: 'crashed', exitCode: 11 })

    expect(logged("window's page failed to load")).toEqual([
      expect.objectContaining({ level: 'error', code: -6, description: 'ERR_FILE_NOT_FOUND' }),
    ])
    expect(logged("window's process is gone")).toEqual([
      expect.objectContaining({ level: 'error', reason: 'crashed', exitCode: 11 }),
    ])
  })

  it('logs errors the window sends, in the renderer scope', async () => {
    await startAndWaitUntilReady()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await handler?.({}, CommandName.LogRendererError, {
      kind: RendererErrorKind.ReactCaught,
      message: 'TypeError: task is undefined',
      stack: 'TypeError: task is undefined\n    at TaskHeader',
      componentStack: '\n    at TaskHeader\n    at App',
      source: null,
    })

    expect(logged('renderer error')).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'renderer',
        kind: 'react_caught',
        message: 'TypeError: task is undefined',
        componentStack: '\n    at TaskHeader\n    at App',
      }),
    ])
  })

  it('follows a task from its message to the reply, each line with its id', async () => {
    const { replied } = await replyInUnviewedTask()

    const lines = logLines().filter((line) => line.taskId === replied)
    const trail = lines.map(({ scope, msg }) => `${scope} ${msg}`)
    expect(trail).toEqual(
      expect.arrayContaining([
        'chat message appended',
        'runner turn started',
        'agent session starting',
        'agent sdk message',
        'agent session id saved',
        'runner turn result',
        'runner turn ended',
        'task task activity changed',
        'notifications notification sent',
        'ipc command',
      ]),
    )
    const order = (entry: string): number => trail.indexOf(entry)
    expect(order('agent session starting')).toBeLessThan(order('runner turn started'))
    expect(order('runner turn started')).toBeLessThan(order('agent sdk message'))
    expect(order('agent sdk message')).toBeLessThan(order('runner turn result'))
    expect(order('runner turn result')).toBeLessThan(order('runner turn ended'))
    expect(lines.find((line) => line.msg === 'message text' && line.role === 'agent')).toMatchObject({
      level: 'debug',
      text: 'It was a **race**.',
    })
  })

  it("logs a test mode to its own throwaway folder, never Electron's", async () => {
    vi.stubEnv(E2E_ENV, JSON.stringify({ userData: electron.app.userData, route: '' }))

    await startAndWaitUntilReady()

    expect(createFileLogSink).toHaveBeenCalledExactlyOnceWith({ dir: testModeLogs(), toConsole: true })
    expect(logged('app starting', testModeLogs())).toEqual([
      expect.objectContaining({ testMode: 'e2e', agentBackend: 'scripted' }),
    ])
    expect(logLines()).toEqual([])
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

  it("never reads the machine's login shell", async () => {
    askForCapture()

    await startAndWaitUntilReady()
    await waitForExit()

    expect(resolveLoginEnv).not.toHaveBeenCalled()
  })

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
    expect(logged('captured', testModeLogs())).toEqual([
      expect.objectContaining({ scope: 'test-mode', file: join(outDir, 'gallery-1100x700.png') }),
    ])
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

    expect(logged('capture failed', testModeLogs())).toEqual([
      expect.objectContaining({ level: 'error', error: expect.objectContaining({ message: 'no page' }) as unknown }),
    ])
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
    await waitForExit()

    expect(logged('capture failed', testModeLogs())).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringMatching(/^the seed .* can't be read/) as unknown,
        }) as unknown,
      }),
    ])
    expect(electron.windows).toHaveLength(0)
    expect(close).toHaveBeenCalledOnce()
    expect(electron.app.exit).toHaveBeenCalledWith(1)
  })

  it('exits with an error, before Electron is ready, when the spec is invalid', () => {
    vi.stubEnv(CAPTURE_ENV, '{')

    startApp()

    expect(console.error).toHaveBeenCalledWith('[test-mode] test mode failed', {
      error: expect.objectContaining({
        message: expect.stringMatching(/^GLADE_CAPTURE is not JSON/) as unknown,
      }) as unknown,
    })
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

  it('seeds a conversation played by the agent script, then captures the task', async () => {
    askForCapture({ route: '', conversation: { agentScript: 'simple-reply', message: 'How does it retry?' } })
    const userData = electron.app.userData

    await startAndWaitUntilReady()
    await waitForExit()

    expect(electron.app.exit).toHaveBeenCalledWith(0)
    expect(createSdkBackend).not.toHaveBeenCalled()
    const db = new Database(join(userData, 'glade.db'), { readonly: true })
    try {
      const messages = db.prepare('SELECT role, body FROM messages ORDER BY turn, role DESC').all()
      expect(messages).toEqual([
        { role: 'user', body: 'How does it retry?' },
        { role: 'agent', body: expect.stringMatching(/^The client retries/) as unknown },
      ])
      const selected = db.prepare('SELECT value FROM ui_state WHERE key = ?').get(UiStateKey.SelectedTaskId)
      const task = db.prepare('SELECT id FROM tasks').get()
      expect(selected).toEqual({ value: (task as { id: string }).id })
    } finally {
      db.close()
    }
    expect(readFileSync(join(outDir, 'gallery-1100x700.png'), 'utf8')).toBe('png')
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

  it('runs the terminal tabs’ shells as a plain bash, from its throwaway data folder', async () => {
    askForE2e()
    const spawner = createFakeSpawner()
    startApp({ spawnPty: spawner.spawn })
    await Promise.resolve()
    await Promise.resolve()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    const created = (await handler?.({}, CommandName.TerminalCreate, { workspaceId: null })) as {
      value: { tab: { cwd: string } }
    }

    expect(created.value.tab.cwd).toBe(electron.app.userData)
    const tab = (await handler?.({}, CommandName.TerminalList, {})) as { value: { tabs: { id: string }[] } }
    await handler?.({}, CommandName.TerminalAttach, { id: tab.value.tabs[0]?.id, cols: 80, rows: 24 })
    expect(spawner.spawned[0]?.options).toMatchObject({ file: '/bin/bash', args: ['--noprofile', '--norc'] })
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

    expect(logged('no agent script for a session', testModeLogs())).toEqual([
      expect.objectContaining({
        level: 'error',
        scope: 'agent',
        error: expect.objectContaining({
          message: expect.stringMatching(/^An agent session started/) as unknown,
        }) as unknown,
      }),
    ])
    expect(createAgentBackend).not.toHaveBeenCalled()
    expect(createSdkBackend).not.toHaveBeenCalled()
    expect(backend.sessions).toHaveLength(0)
  })

  it('runs the agent script the spec names', async () => {
    askForE2e({ agentScript: 'simple-reply' })
    await startAndWaitUntilReady()
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const task = sampleTask(db, sampleWorkspace(db, electron.app.userData).id)
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await expect(handler?.({}, CommandName.TasksSend, { id: task.id, text: 'Hi' })).resolves.toMatchObject({ ok: true })

    await vi.waitFor(() => {
      expect(db.prepare("SELECT body FROM messages WHERE role = 'agent'").all()).toEqual([
        { body: expect.stringMatching(/^The client retries/) as unknown },
      ])
    })
    db.close()
    expect(createSdkBackend).not.toHaveBeenCalled()
  })

  it('runs the agent script the spec picks for a task by its first message', async () => {
    askForE2e({ agentScriptsByFirstMessage: { 'How does it retry?': 'simple-reply' } })
    await startAndWaitUntilReady()
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const task = sampleTask(db, sampleWorkspace(db, electron.app.userData).id)
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []

    await handler?.({}, CommandName.TasksSend, { id: task.id, text: 'How does it retry?' })

    await vi.waitFor(() => {
      expect(db.prepare("SELECT body FROM messages WHERE role = 'agent'").all()).toEqual([
        { body: expect.stringMatching(/^The client retries/) as unknown },
      ])
    })
    db.close()
  })

  it('resumes a task on the agent script its first message picked', async () => {
    const { db } = openAppDatabase(electron.app.userData)
    const task = sampleTask(db, sampleWorkspace(db, electron.app.userData).id)
    appendMessage(db, { taskId: task.id, role: MessageRole.User, body: 'How does it retry?', turn: 1 })
    updateTask(db, task.id, { activity: TaskActivity.Working, sessionId: 'session-1' })
    db.close()
    askForE2e({ agentScriptsByFirstMessage: { 'How does it retry?': 'simple-reply' } })

    await startAndWaitUntilReady()

    const check = new Database(join(electron.app.userData, 'glade.db'))
    await vi.waitFor(() => {
      expect(check.prepare("SELECT body FROM messages WHERE role = 'agent'").all()).toEqual([
        { body: expect.stringMatching(/^The client retries/) as unknown },
      ])
    })
    check.close()
  })

  /** Sends a task a message on the `simple-reply` script, and resolves with the environments its session recorded. */
  async function sessionEnvs(): Promise<E2eAgentEnvs> {
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const task = sampleTask(db, sampleWorkspace(db, electron.app.userData).id)
    db.close()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
    await handler?.({}, CommandName.TasksSend, { id: task.id, text: 'Hi' })
    const envs = Reflect.get(globalThis, E2E_AGENT_ENVS_GLOBAL) as E2eAgentEnvs
    await vi.waitFor(() => {
      expect(envs.sessions).toHaveLength(1)
    })
    return envs
  }

  it("runs the agents in the app's own environment, never reading the machine's login shell", async () => {
    askForE2e({ agentScript: 'simple-reply' })
    vi.stubEnv('PATH', LAUNCHD_PATH)
    await startAndWaitUntilReady()

    const { sessions } = await sessionEnvs()

    expect(resolveLoginEnv).not.toHaveBeenCalled()
    expect(sessions[0]?.PATH).toBe(LAUNCHD_PATH)
  })

  it('runs the agents in the environment of the login shell the spec names', async () => {
    vi.stubEnv('PATH', LAUNCHD_PATH)
    useRealLoginEnv()
    askForE2e({ agentScript: 'simple-reply', loginShell: String(process.env.SHELL) })
    vi.stubEnv('SHELL', '/bin/not-this-one')
    await startAndWaitUntilReady()

    const { sessions } = await sessionEnvs()

    expect(resolveLoginEnv).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ shell: join(electron.app.userData, 'login-shell') }),
    )
    expect(sessions[0]?.PATH).toBe(`/opt/sample/bin:${LAUNCHD_PATH}`)
  })

  it('never makes the real agent backend by default either', async () => {
    askForE2e()

    await startAndWaitUntilReady()

    expect(electron.ipcMain.handle).toHaveBeenCalledOnce()
    expect(createSdkBackend).not.toHaveBeenCalled()
  })

  it('fills the database from the seed fixture before opening the window, without resuming what it seeds', async () => {
    const seed = join(electron.app.userData, 'seed.json')
    const working = { title: 'Working', activity: 'working', minutesAgo: 0 }
    writeFileSync(seed, JSON.stringify({ workspace: { name: 'Acme API', rootPath: '/code/api' }, tasks: [working] }))
    askForE2e({ seed })

    await startAndWaitUntilReady()

    expect(electron.windows).toHaveLength(1)
    expect(electron.app.exit).not.toHaveBeenCalled()
    const db = new Database(join(electron.app.userData, 'glade.db'), { readonly: true })
    try {
      expect(db.prepare('SELECT name FROM workspaces').all()).toEqual([{ name: 'Acme API' }])
      expect(db.prepare('SELECT activity FROM tasks').all()).toEqual([{ activity: 'working' }])
    } finally {
      db.close()
    }
  })

  it('exits with an error, without opening a window, when the seed fixture is bad', async () => {
    askForE2e({ seed: join(electron.app.userData, 'missing.json') })

    await startAndWaitUntilReady()

    expect(logged("the e2e seed couldn't be applied", testModeLogs())).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          message: expect.stringMatching(/^the seed .* can't be read/) as unknown,
        }) as unknown,
      }),
    ])
    expect(electron.windows).toHaveLength(0)
    expect(electron.app.exit).toHaveBeenCalledWith(1)
  })

  it('records notifications for the test to read and click, never showing one, and keeps the window hidden', async () => {
    askForE2e({ agentScript: 'simple-reply' })
    await startAndWaitUntilReady()
    const notifier = Reflect.get(globalThis, E2E_NOTIFIER_GLOBAL) as RecordingNotifier
    const db = new Database(join(electron.app.userData, 'glade.db'))
    const replied = sampleTask(db, sampleWorkspace(db, electron.app.userData).id).id
    db.close()
    const [, handler] = electron.ipcMain.handle.mock.calls[0] ?? []
    await handler?.({}, CommandName.TasksSend, { id: replied, text: 'How does it retry?' })

    await vi.waitFor(() => {
      expect(notifier.shown).toEqual([
        {
          taskId: replied,
          title: 'Explain the retry policy',
          body: expect.stringMatching(/^The client retries idempotent requests .*…$/) as unknown,
          silent: true,
        },
      ])
    })
    expect(electron.notifications).toEqual([])
    const window = onlyWindow()
    notifier.click(0)

    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    expect(window.webContents.send).toHaveBeenLastCalledWith(EVENT_CHANNEL, {
      type: EventType.TaskOpenRequested,
      taskId: replied,
    })
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

    expect(console.error).toHaveBeenCalledWith('[test-mode] test mode failed', {
      error: expect.objectContaining({ message: expect.stringMatching(/^GLADE_E2E is invalid/) as unknown }) as unknown,
    })
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
