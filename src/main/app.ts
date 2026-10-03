import { join } from 'node:path'
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  Notification,
  protocol,
  screen,
  shell,
  Tray,
  WebContentsView,
  type Point,
  type WebPreferences,
} from 'electron'
import { CloseKind, EventType, type GladeEvent } from '../shared/bridge'
import { UiStateKey } from '../shared/domain'
import { PLUGINS_FOLDER_NAME } from '../shared/plugins'
import type { AgentBackend } from './agent/backend'
import { claudeCodeBinary, createSdkBackend, type SdkBackendOptions } from './agent/sdk-backend'
import { claudeLogin, type RunLogin, type SpawnLogin } from './account/login'
import { createE2eLogin, WAITING_LOGIN } from './account/test-login'
import { AGENT_SCRIPTS, type AgentScriptName } from './agent/scripts'
import { createTestModeAgentBackend, type TestModeAgentBackend } from './agent/test-mode-backend'
import { recordSdkModels } from './models/models'
import { registerBridge, type RegisteredBridge } from './bridge'
import {
  captureShots,
  prepareCapture,
  readCaptureSpec,
  withTimeout,
  type CaptureSpec,
  type MinimumSize,
} from './capture'
import { openAppDatabase, type AppDatabase } from './db/database'
import { firstUserMessageOfSession } from './db/repositories/messages'
import { getUiState } from './db/repositories/ui-state'
import { applySeed, readSeed } from './capture-seed'
import { chooseFolder } from './dialogs'
import {
  createE2eAgentEnvs,
  createE2eDesktop,
  createE2eAgent,
  createE2eEditor,
  createE2eNetwork,
  E2E_MENU_BAR_GLOBAL,
  E2E_NOTIFIER_GLOBAL,
  E2E_WINDOW_SIZE,
  e2eChosenFolder,
  prepareE2e,
  readE2eSpec,
  type E2eSpec,
} from './e2e'
import type { OpenPath, RevealPath, WriteClipboard } from './files/files'
import type { OpenExternal } from './links/links'
import { createThumbnails, THUMBNAILS_FOLDER_NAME } from './artifacts/thumbnails'
import { definedEnv, LoginEnvSource, resolveLoginEnv, type Environment, type LoginEnv } from './login-env'
import { logCrashes } from './logging/crashes'
import { createFileLogSink, type FileLogSinkOptions } from './logging/file-sink'
import { redactEnv } from './logging/format'
import { CONSOLE_LOGGER, createLogger, LogScope, type Logger, type LogSink } from './logging/logger'
import { installAppMenu } from './menu/app-menu'
import { createElectronPopover, createElectronTray, GLYPH_FOLDER, loadGlyphImage } from './menu-bar/electron'
import { createMenuBar, type CreateTray, type MenuBar } from './menu-bar/menu-bar'
import { createRecordingTray, e2eMenuBar } from './menu-bar/recording'
import { createElectronNotifier } from './notifications/electron-notifier'
import { createReplyNotifications } from './notifications/notifications'
import type { Notifier } from './notifications/notifier'
import { createRecordingNotifier } from './notifications/recording-notifier'
import { openTaskWithoutWindow } from './tasks/attention'
import { markQuit, markRunning, noteRelaunch } from './relaunch'
import { CloseGuard } from './close-guard'
import { testModeLogsFolder } from './isolation'
import { checkSecurity, describeViolations } from './security'
import { createElectronPluginViews, PLUGIN_VIEW_RADIUS, registerPluginScheme } from './plugins/electron-view'
import { createFakeMachineSamplers } from './plugins/machine-fake'
import { createMachineSamplers } from './plugins/machine-samplers'
import { captureViewOf, type CaptureView } from './capture-views'
import { seedConversation } from './capture-conversation'
import type { TerminalOptions } from './bridge'
import { spawnNodePty } from './terminal/node-pty'
import type { SpawnPty } from './terminal/pty'
import { loginShell, testShell } from './terminal/shell'
import { backfillWorkspaceSelections } from './workspaces/workspaces'

/** The `bg` design token, so the window never flashes white before the renderer paints. */
const WINDOW_BACKGROUND = '#0A0B0F'

/** The app's name, as its menu bar says it (About, Hide and Quit). `app.name` is the package's, `glade`, outside a build. */
const APP_NAME = 'Glade'

/**
 * Where the macOS window controls (the traffic lights) sit: in the strip at the top of the card in the window's top-left
 * corner (`--title-bar-height`, 28px, in src/renderer/tokens.css), centred in it. The card starts at the window's 8px
 * outer inset and has a 1px border, so the strip runs from 9px to 37px down. AppKit puts the close button's frame
 * exactly here, and on current macOS its circle fills the frame, 14px square: so 16px in and down centres the lights
 * in the strip (16–30px, around its middle at 23px), 7px inside the card's top and left edges alike.
 */
export const TRAFFIC_LIGHT_POSITION: Point = { x: 16, y: 16 }

/**
 * Where the lights sit instead while the sidebar is collapsed: in the task header's first row, left of the Show task
 * list toggle, rather than a strip (#357). The header card starts at the window's 8px outer inset, like the right
 * panel; its own border (1px) and padding (8px) put its content at 17px, and the nested header card inside adds
 * another border (1px) and padding (16px left, 8px top), putting its first row at 34px across and 26px down. The row
 * is 30px tall, as tall as its icon buttons, so 8px (half of 30, less half of the lights' 14px) centres a light on it:
 * 34px down again. AppKit puts the close button's frame exactly here, and its circle fills the frame on current
 * macOS, so `{ x: 34, y: 34 }` centres the lights on the row, level with the toggle beside them.
 */
export const TRAFFIC_LIGHT_POSITION_COLLAPSED: Point = { x: 34, y: 34 }

/** Where the traffic lights sit for the sidebar's state (`TRAFFIC_LIGHT_POSITION` or `TRAFFIC_LIGHT_POSITION_COLLAPSED`). */
export function trafficLightPositionFor(sidebarCollapsed: boolean): Point {
  return sidebarCollapsed ? TRAFFIC_LIGHT_POSITION_COLLAPSED : TRAFFIC_LIGHT_POSITION
}

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

enum TestModeKind {
  Capture = 'capture',
  E2e = 'e2e',
}

/**
 * How the app runs outside a normal run, set up from the environment before the app is ready: a screenshot capture
 * (see `./capture`) or an e2e test run (see `./e2e`). Neither ever runs in a packaged app, nor shows anything.
 */
type TestMode =
  | { readonly kind: TestModeKind.Capture; readonly spec: CaptureSpec }
  | { readonly kind: TestModeKind.E2e; readonly spec: E2eSpec }
  | null

/** Logs why the app can't start and exits. Shows a dialog too, except in a test mode, which must never show anything. */
function refuseToStart({ logSummary, message, detail }: StartFailure, testMode: TestMode, log: Logger): void {
  log.error('refused to start', { reason: logSummary, detail })
  if (testMode === null) dialog.showErrorBox('Glade refused to start', `${message}\n\n${detail}`)
  app.exit(1)
}

type DatabaseOpening =
  { readonly ok: true; readonly database: AppDatabase } | { readonly ok: false; readonly failure: StartFailure }

/** Opens and migrates the database in the app's data folder, or says why it couldn't. */
function openDatabase(log: Logger): DatabaseOpening {
  try {
    const database = openAppDatabase(app.getPath('userData'))
    const { fromVersion, toVersion } = database.migration
    log.info('database opened', { file: database.file, fromVersion, toVersion, migrated: fromVersion !== toVersion })
    return { ok: true, database }
  } catch (error) {
    log.error("database couldn't be opened", { error })
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

/** The menu bar popover's page: Glade's own, at its own route (`src/renderer/menu-bar`). */
export const MENU_BAR_ROUTE = '#menu-bar'

/** The menu bar popover's windows (`./menu-bar/electron`), which aren't Glade's main windows. */
const popoverWindows = new Set<BrowserWindow>()

/** Glade's main windows, open now: every window but the menu bar popover. */
function mainWindows(): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter((window) => !popoverWindows.has(window))
}

/**
 * Loads Glade's page in a window at `route` (e.g. `#menu-bar`; `''` for the app): from electron-vite's dev server, with
 * hot reload, in development, and the built file otherwise.
 */
function loadPage(window: BrowserWindow, route: string): void {
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(`${devServerUrl}${route}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route.replace(/^#/, '') })
  }
}

/**
 * Opens the main window: shown once it's ready, except in a test mode, where it's never shown (but still paints, so it
 * can be captured and recorded) and opens at the spec's route. In e2e mode it's the size of the recordings.
 *
 * Its traffic lights start where the sidebar was last left (`db`'s UI state), so a relaunch with it collapsed doesn't
 * flash the lights in the open position first (#357); the window keeps them in step from there on
 * (`window.setTrafficLights`, wired to `setTrafficLightsCollapsed` below).
 */
function createWindow(testMode: TestMode, db: AppDatabase['db'], log: Logger): BrowserWindow {
  log.info('window opening')
  const sidebarCollapsed = getUiState(db, UiStateKey.SidebarCollapsed) === 'true'
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    ...(testMode === null ? {} : { paintWhenInitiallyHidden: true }),
    titleBarStyle: 'hidden',
    trafficLightPosition: trafficLightPositionFor(sidebarCollapsed),
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: WINDOW_WEB_PREFERENCES,
  })

  // The renderer only ever shows the app's own page: no popups, no navigating away. A link opens in the browser, from
  // main (`links.open`), and never here.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })
  // The window's own failures: its page not loading, or its process dying.
  window.webContents.on('did-fail-load', (_event, code, description) => {
    log.error("window's page failed to load", { code, description })
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    log.error("window's process is gone", { ...details })
  })

  if (testMode === null) {
    window.once('ready-to-show', () => {
      window.show()
    })
  } else if (testMode.kind === TestModeKind.E2e) {
    window.setContentSize(E2E_WINDOW_SIZE.width, E2E_WINDOW_SIZE.height)
  }

  loadPage(window, testMode?.spec.route ?? '')
  return window
}

/** What a capture needs from the running app to seed its conversation. */
interface CaptureContext {
  readonly database: AppDatabase
  readonly bridge: RegisteredBridge
  readonly agent: TestModeAgentBackend
  readonly log: Logger
}

/** Fills the database from the spec's seed fixture and seeds its conversation, if it has them, then captures the page of a hidden window. Resolves with the files. */
async function capture(spec: CaptureSpec, { database, bridge, agent, log }: CaptureContext): Promise<string[]> {
  if (spec.seed !== undefined) applySeed(database.db, readSeed(spec.seed))
  // Settings › Control shows the endpoint as the seed's settings have it.
  await bridge.endpoint.sync()
  if (spec.conversation !== undefined) {
    const context = {
      db: database.db,
      emit: bridge.emit,
      runner: bridge.runner,
      whenIdle: () => agent.whenIdle(),
      folder: spec.userData,
    }
    await seedConversation(context, spec.conversation)
  }
  const window = createWindow({ kind: TestModeKind.Capture, spec }, database.db, log)
  // A plugin's view is drawn over the page, so the capture of the page leaves it out: it's pasted in.
  const nativeViews = (): CaptureView[] =>
    window.contentView.children
      .filter((child) => child instanceof WebContentsView)
      .map((view) => captureViewOf(view, PLUGIN_VIEW_RADIUS))
  return captureShots(
    {
      setContentSize: (width, height) => {
        window.setContentSize(width, height)
      },
      webContents: window.webContents,
      nativeViews,
    },
    spec,
    ({ data, width, height }) => nativeImage.createFromBitmap(data, { width, height }),
  )
}

/**
 * Runs a capture (see `capture`), then closes the database and exits: 0 when every PNG was written, 1 otherwise.
 */
async function runCapture(spec: CaptureSpec, context: CaptureContext): Promise<void> {
  let exitCode = 0
  try {
    const files = await withTimeout(capture(spec, context), spec.timeoutMs)
    for (const file of files) context.log.scoped(LogScope.TestMode).info('captured', { file })
  } catch (error) {
    context.log.scoped(LogScope.TestMode).error('capture failed', { error })
    exitCode = 1
  }
  context.bridge.runner.close()
  context.bridge.account.close()
  context.bridge.login.close()
  context.bridge.artifactWatch.close()
  context.bridge.machine?.close()
  context.bridge.folderWatch.close()
  await context.bridge.endpoint.close()
  context.bridge.terminals.shutdown()
  context.database.db.close()
  app.exit(exitCode)
}

/**
 * Fills an e2e run's database from its seed fixture, if it has one, as a capture does. Returns false, having closed
 * the database and exited with an error, when the fixture can't be applied.
 */
function seedE2e(spec: E2eSpec, database: AppDatabase, log: Logger): boolean {
  if (spec.seed === undefined) return true
  try {
    applySeed(database.db, readSeed(spec.seed))
    return true
  } catch (error) {
    log.scoped(LogScope.TestMode).error("the e2e seed couldn't be applied", { seed: spec.seed, error })
    database.db.close()
    app.exit(1)
    return false
  }
}

/** The test mode asked for through the environment, set up before the app is ready; `null` in a normal run. */
function startTestMode(): TestMode {
  const capture = readCaptureSpec(process.env, app.isPackaged, WINDOW_MIN_SIZE)
  if (capture !== null) {
    prepareCapture(app, capture)
    return { kind: TestModeKind.Capture, spec: capture }
  }
  const e2e = readE2eSpec(process.env, app.isPackaged)
  if (e2e !== null) {
    prepareE2e(app, e2e)
    return { kind: TestModeKind.E2e, spec: e2e }
  }
  return null
}

/**
 * The agent a test mode's tasks run on: the script its spec names, or none, and for an e2e spec the scripts it picks by
 * a task's first message, read from the database for a session resumed on launch. Each session reports the test mode's
 * models to `onModels`, as a real one reports the SDK's.
 */
function createTestModeAgent(
  testMode: NonNullable<TestMode>,
  db: AppDatabase['db'],
  env: Promise<Environment>,
  log: Logger,
  onModels: (models: unknown) => void,
): TestModeAgentBackend {
  const name: AgentScriptName | undefined =
    testMode.kind === TestModeKind.Capture ? testMode.spec.conversation?.agentScript : testMode.spec.agentScript
  const byFirstMessage = testMode.kind === TestModeKind.E2e ? testMode.spec.agentScriptsByFirstMessage : undefined
  return createTestModeAgentBackend(
    {
      script: name === undefined ? null : AGENT_SCRIPTS[name],
      byFirstMessage: new Map(
        Object.entries(byFirstMessage ?? {}).map(([message, script]) => [message, AGENT_SCRIPTS[script]]),
      ),
      firstMessageOf: (sessionId) => firstUserMessageOfSession(db, sessionId),
      onModels,
      ...(testMode.kind === TestModeKind.E2e ? createE2eAgent() : {}),
    },
    // An e2e spec reads the environment each session would have run in.
    testMode.kind === TestModeKind.E2e ? { env, onSessionEnv: createE2eAgentEnvs() } : undefined,
    log.scoped(LogScope.Agent),
  )
}

/**
 * The environment the agents run in: your login shell's, read once at startup (see `./login-env`). A test mode never
 * reads yours, so what it does doesn't depend on the machine it runs on: it keeps the app's own, unless an e2e spec
 * names a login shell to read.
 */
function agentEnv(testMode: TestMode, log: Logger): Promise<Environment> {
  const base = process.env
  const read = (shell: string | undefined): Promise<Environment> =>
    resolveLoginEnv({ shell, base, cwd: app.getPath('home'), log }).then((result) => {
      logAgentEnv(log, shell, result)
      return result.env
    })
  if (testMode === null) return read(base.SHELL)
  if (testMode.kind === TestModeKind.E2e && testMode.spec.loginShell !== undefined) {
    return read(testMode.spec.loginShell)
  }
  const own = definedEnv(base)
  logAgentEnv(log, undefined, { source: LoginEnvSource.Fallback, env: own, reason: 'a test mode keeps its own' })
  return Promise.resolve(own)
}

/** Logs the environment the agents run in: where it came from and its PATH, and at debug the whole of it, redacted. */
function logAgentEnv(log: Logger, shell: string | undefined, result: LoginEnv): void {
  const reason = result.source === LoginEnvSource.Fallback ? { reason: result.reason } : {}
  log.info('agent environment', {
    source: result.source,
    shell: shell ?? null,
    ...reason,
    PATH: result.env.PATH ?? null,
  })
  log.debug('agent environment variables', { env: redactEnv(result.env) })
}

/**
 * What shows the app's notifications. A test mode never shows one: it records them instead, and in e2e mode puts the
 * recording on the global object (`E2E_NOTIFIER_GLOBAL`) for the spec to read and click.
 */
function createNotifier(testMode: TestMode): Notifier {
  if (testMode === null) return createElectronNotifier(Notification)
  const recording = createRecordingNotifier()
  if (testMode.kind === TestModeKind.E2e) Reflect.set(globalThis, E2E_NOTIFIER_GLOBAL, recording)
  return recording
}

/**
 * What Open in editor opens a file with: the app macOS opens its kind of file with. A test mode never opens one: e2e
 * mode records the paths instead, for the spec to read (`E2E_EDITOR_GLOBAL`), and a capture ignores them.
 */
function createOpenPath(testMode: TestMode): OpenPath {
  if (testMode === null) return (path) => shell.openPath(path)
  if (testMode.kind === TestModeKind.E2e) return createE2eEditor()
  return () => Promise.resolve('')
}

/**
 * Showing a file in Finder, the clipboard and the browser: the desktop an artifact's Reveal in folder, the menus' Copy
 * items and a clicked link use.
 */
interface Desktop {
  readonly revealPath: RevealPath
  readonly writeClipboard: WriteClipboard
  readonly openExternal: OpenExternal
}

/**
 * The real Finder, clipboard and browser. A test mode never touches them: e2e mode records what they'd have done
 * instead, for the spec to read (`E2E_DESKTOP_GLOBAL`), and a capture ignores it.
 */
function createDesktop(testMode: TestMode): Desktop {
  if (testMode === null) {
    return {
      revealPath: (path) => {
        shell.showItemInFolder(path)
      },
      writeClipboard: (text) => {
        return clipboard.writeText(text)
      },
      // Only ever a link main has checked is a web or mail link (`./links/links`).
      openExternal: (url) => shell.openExternal(url),
    }
  }
  if (testMode.kind === TestModeKind.E2e) return createE2eDesktop()
  return { revealPath: () => undefined, writeClipboard: () => Promise.resolve(), openExternal: () => Promise.resolve() }
}

/** Whether an IPC event came from one of Glade's windows' own pages, and not a plugin's (or anything else). */
function isFromWindow(event: unknown): boolean {
  const sender: unknown = typeof event === 'object' && event !== null ? Reflect.get(event, 'sender') : undefined
  return BrowserWindow.getAllWindows().some((window) => window.webContents === sender)
}

/** What opening a task from outside its window needs from the running app. */
interface OpenTaskContext {
  readonly testMode: TestMode
  readonly database: AppDatabase
  readonly bridge: RegisteredBridge
  readonly log: Logger
}

/**
 * Brings a window up: restores it if it's minimised, shows it and focuses it, bringing Glade to the front (from the
 * menu bar popover, it may not be). A test mode's window stays hidden.
 */
function bringUp(window: BrowserWindow, testMode: TestMode): void {
  if (testMode !== null) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
  app.focus({ steal: true })
}

/**
 * Opens a task, when its notification or its row in the menu bar popover is clicked: brings the window up and asks it
 * to open the task, as clicking its row does (switching workspace if it has to). With every window closed, it selects
 * the task itself and opens a window on it. A test mode's window stays hidden.
 */
function openTaskInWindow(taskId: string, { testMode, database, bridge, log }: OpenTaskContext): void {
  const [window] = mainWindows()
  if (window === undefined) {
    openTaskWithoutWindow({ db: database.db, emit: bridge.emit }, taskId)
    createWindow(testMode, database.db, log)
    return
  }
  bringUp(window, testMode)
  bridge.emit({ type: EventType.TaskOpenRequested, taskId, subagentId: null })
}

/** Brings Glade's window up (the menu bar popover's Open Glade), opening one when every window is closed. */
function openGlade(testMode: TestMode, db: AppDatabase['db'], log: Logger): void {
  const [window] = mainWindows()
  if (window === undefined) {
    createWindow(testMode, db, log)
    return
  }
  bringUp(window, testMode)
}

/** What the menu bar icon is drawn with. */
interface MenuBarDrawing {
  readonly createTray: CreateTray
  /** Hands the running menu bar over, e.g. for e2e mode to put it on the global object. */
  readonly started: (menuBar: MenuBar) => void
}

/**
 * The real menu bar icon: Electron's `Tray`, drawing the glyph's image packaged with the app. E2e mode never puts a
 * real icon in the menu bar: it records it instead, and puts it on the global object (`E2E_MENU_BAR_GLOBAL`) for the
 * spec.
 */
function menuBarDrawing(testMode: TestMode, log: Logger): MenuBarDrawing {
  if (testMode === null) {
    const image = loadGlyphImage(nativeImage, join(app.getAppPath(), GLYPH_FOLDER))
    if (image.isEmpty()) log.warn("the menu bar glyph's images are missing")
    return {
      createTray: createElectronTray(Tray, image),
      // Nothing to hand over: the real icon needs nothing more once it's running.
      started: () => undefined,
    }
  }
  const tray = createRecordingTray()
  return {
    createTray: tray.createTray,
    started: (menuBar) => {
      Reflect.set(globalThis, E2E_MENU_BAR_GLOBAL, e2eMenuBar(menuBar, tray))
    },
  }
}

/** What the app can be started with. */
export interface AppOptions {
  /**
   * Makes the backend the tasks' agents run on, once the app is ready, given the environment they run in. The Claude
   * Agent SDK by default; unit tests pass a fake. Never used in a test mode (e2e or capture), which always runs on
   * `createTestModeAgentBackend`, so no automated run can reach the real Claude API.
   */
  readonly createAgentBackend?: (options: SdkBackendOptions) => AgentBackend
  /** Starts the terminal tabs' shells in pseudo-terminals: node-pty by default; unit tests pass a fake. */
  readonly spawnPty?: SpawnPty
  /**
   * Starts Claude Code's own login (`claude auth login`) for Log in: Node's `spawn` by default; unit tests pass a fake.
   * Never used in a test mode, whose login is a stand-in (`./account/test-login`).
   */
  readonly spawnLogin?: SpawnLogin
  /** Makes where the log goes (`docs/logs.md`): the log file by default. */
  readonly createLogSink?: (options: FileLogSinkOptions) => LogSink
}

/**
 * Where the log goes: `~/Library/Logs/Glade/` (Electron's logs folder), or a test mode's throwaway data folder, so a
 * test never writes to yours.
 */
function logsFolder(testMode: TestMode): string {
  return testMode === null ? app.getPath('logs') : testModeLogsFolder(testMode.spec.userData)
}

/**
 * How the terminal tabs run their shells: your login shell, starting in your home folder when there's no workspace. A
 * test mode runs a plain shell (`testShell`) instead, falling back to its throwaway data folder, so what it shows
 * doesn't depend on (or show) the machine it runs on.
 */
function terminalOptions(testMode: TestMode, spawn: SpawnPty): TerminalOptions {
  if (testMode === null) return { spawn, shell: loginShell(process.env), fallbackCwd: app.getPath('home') }
  return { spawn, shell: testShell(process.env), fallbackCwd: testMode.spec.userData }
}

/**
 * How Log in runs Claude Code's own login: the bundled binary's `claude auth login`, from your home folder, in the
 * agents' environment, so it signs in where they look. A test mode never runs it: e2e mode's waits for the spec to end
 * it (`E2E_LOGIN_GLOBAL`), and a capture's waits for good.
 */
function loginRunner(
  testMode: TestMode,
  env: Promise<Environment>,
  spawn: SpawnLogin | undefined,
  log: Logger,
): RunLogin {
  if (testMode === null) {
    const executable = claudeCodeBinary()
    return claudeLogin({ executable, env, cwd: app.getPath('home'), ...(spawn === undefined ? {} : { spawn }), log })
  }
  return testMode.kind === TestModeKind.E2e ? createE2eLogin() : WAITING_LOGIN
}

/**
 * Starts the app: once Electron is ready, checks the window security settings, opens and migrates the database (closed
 * again on quit), registers the bridge the renderer talks to main through (with the agent runner behind it), then opens the main window.
 *
 * Outside a packaged app, a capture spec in the environment (see `./capture`) starts a screenshot run instead: the
 * same app with a throwaway data folder, in a window that is never shown, which captures its page and exits. An e2e
 * spec (see `./e2e`) runs the app as normal for Playwright to drive, with a throwaway data folder and a hidden window.
 */
export function startApp({
  createAgentBackend = createSdkBackend,
  spawnPty = spawnNodePty,
  spawnLogin,
  createLogSink = createFileLogSink,
}: AppOptions = {}): void {
  let testMode: TestMode
  try {
    testMode = startTestMode()
  } catch (error) {
    // Before the test mode is set up there's no folder of its own to log to, and a test never logs to yours.
    CONSOLE_LOGGER.scoped(LogScope.TestMode).error('test mode failed', { error })
    app.exit(1)
    return
  }
  const log = createLogger({
    // In development (and the test modes, which never run packaged) the log shows on the terminal too.
    sink: createLogSink({ dir: logsFolder(testMode), toConsole: !app.isPackaged }),
  })
  // A test mode never shows Electron's error dialog for an uncaught exception, which would block it: it exits (#439).
  const fatal = (): void => {
    app.exit(1)
  }
  const stopLoggingCrashes = logCrashes(process, log, testMode === null ? undefined : fatal)
  // Before the app is ready, as Electron requires: a plugin's page is served under its own scheme.
  registerPluginScheme(protocol)
  log.info('app starting', {
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    packaged: app.isPackaged,
    testMode: testMode?.kind ?? null,
    agentBackend: testMode === null ? 'sdk' : 'scripted',
    logs: logsFolder(testMode),
  })
  // Read alongside Electron starting up, and without holding the window up: an agent session waits for it instead.
  const env = agentEnv(testMode, log.scoped(LogScope.Env))
  const refuse = (failure: StartFailure): void => {
    stopLoggingCrashes()
    refuseToStart(failure, testMode, log)
  }

  void app.whenReady().then(() => {
    const security = checkSecurity(WINDOW_WEB_PREFERENCES)
    if (!security.ok) {
      refuse({
        logSummary: 'insecure window settings',
        message: "The window's security settings are not in effect.",
        detail: describeViolations(security.violations),
      })
      return
    }

    const opening = openDatabase(log.scoped(LogScope.Db))
    if (!opening.ok) {
      refuse(opening.failure)
      return
    }
    const { database } = opening

    // The models each session's SDK reports are kept, for the pickers, once the bridge is registered.
    const onModels = (models: unknown): void => {
      recordSdkModels({ db: database.db, emit: bridge.emit, log: log.scoped(LogScope.Agent) }, models)
    }
    // A test mode never reaches the real Claude API, whatever the app was started with: its agent plays a script.
    const testAgent = testMode === null ? null : createTestModeAgent(testMode, database.db, env, log, onModels)
    const notifyReply = createReplyNotifications({
      db: database.db,
      notifier: createNotifier(testMode),
      openTask: (taskId) => {
        openTaskInWindow(taskId, { testMode, database, bridge, log })
      },
      // The menu bar popover's Recent section lists it.
      onSent: () => {
        menuBar?.changed()
      },
      log: log.scoped(LogScope.Notifications),
      // The bridge's runner, once it's registered: a notification is only shown after that.
      runner: {
        send: (taskId, text) => bridge.runner.send(taskId, text),
        queue: (taskId, text) => bridge.runner.queue(taskId, text),
      },
    })
    // The menu bar's items run in the window: each sends its command there, once the bridge is registered.
    const appMenu = installAppMenu({
      menu: Menu,
      appName: APP_NAME,
      developer: !app.isPackaged,
      send: (command) => {
        bridge.emit({ type: EventType.MenuCommand, command })
      },
    })
    // Glade in the macOS menu bar: its icon, and the popover it opens. Never in a capture, which only captures a page.
    const drawing =
      testMode?.kind === TestModeKind.Capture ? null : menuBarDrawing(testMode, log.scoped(LogScope.MenuBar))
    const menuBar: MenuBar | null =
      drawing === null
        ? null
        : createMenuBar({
            db: database.db,
            createTray: drawing.createTray,
            createPopover: createElectronPopover({
              BrowserWindow,
              webPreferences: WINDOW_WEB_PREFERENCES,
              load: (window) => {
                loadPage(window, MENU_BAR_ROUTE)
              },
              workArea: (anchor) => screen.getDisplayMatching(anchor).workArea,
              hidden: testMode !== null,
              track: (window, alive) => {
                if (alive) popoverWindows.add(window)
                else popoverWindows.delete(window)
              },
            }),
            openTask: (taskId) => {
              openTaskInWindow(taskId, { testMode, database, bridge, log })
            },
            openGlade: () => {
              openGlade(testMode, database.db, log)
            },
            quit: () => {
              app.quit()
            },
            log: log.scoped(LogScope.MenuBar),
          })
    // What the window says about its unsaved edits, which closing it or quitting asks about first (see below).
    const closeGuard = new CloseGuard((event) => {
      bridge.emit(event)
    })
    const bridge: RegisteredBridge = registerBridge({
      ipc: ipcMain,
      db: database.db,
      // The main windows: the menu bar popover is sent only what's in flight, by the menu bar itself.
      targets: () => mainWindows().map((window) => window.webContents),
      agentBackend:
        testAgent ?? createAgentBackend({ env, log: log.scoped(LogScope.Agent), version: app.getVersion(), onModels }),
      // A test can't click a native dialog, so in e2e mode it answers with the folder the test chose.
      chooseFolder:
        testMode?.kind === TestModeKind.E2e
          ? () => Promise.resolve(e2eChosenFolder(process.env))
          : () => chooseFolder(dialog, BrowserWindow.getFocusedWindow()),
      openPath: createOpenPath(testMode),
      ...createDesktop(testMode),
      // Kept in the data folder, so a test mode's are in its throwaway one.
      thumbnails: createThumbnails({
        folder: join(app.getPath('userData'), THUMBNAILS_FOLDER_NAME),
        native: nativeImage,
      }),
      notifyReply,
      // Whether the network is up, for resuming a task paused offline. In e2e mode, the spec decides.
      isOnline: testMode?.kind === TestModeKind.E2e ? createE2eNetwork() : net.isOnline.bind(net),
      terminal: terminalOptions(testMode, spawnPty),
      runLogin: loginRunner(testMode, env, spawnLogin, log.scoped(LogScope.Agent)),
      // In the data folder, so a test mode's is in its throwaway one.
      pluginsFolder: join(app.getPath('userData'), PLUGINS_FOLDER_NAME),
      // The shown plugin goes in Glade's window, over the plugin card; its DevTools never open in a packaged app.
      createPluginView: createElectronPluginViews({
        window: () => mainWindows()[0],
        devTools: !app.isPackaged,
        offscreen: testMode?.kind === TestModeKind.Capture,
        log: log.scoped(LogScope.Plugins),
      }),
      appVersion: app.getVersion(),
      // The Mac's load, for plugins with the `machine` capability on; a test mode's machine is always busy the same way.
      machineSamplers: testMode === null ? createMachineSamplers({ env: () => env }) : createFakeMachineSamplers(),
      isTrustedSender: isFromWindow,
      updateMenu: (state) => {
        appMenu.update(state)
      },
      // The focused window; else Glade's (a hidden test mode window never has the focus).
      closeWindow: () => {
        ;(BrowserWindow.getFocusedWindow() ?? mainWindows()[0])?.close()
      },
      quit: () => {
        app.quit()
      },
      setUnsavedEdits: (unsaved) => {
        closeGuard.setUnsaved(unsaved)
      },
      // The window that sent the command is always one of Glade's own (whichever it is, they share one traffic light
      // position): the plugin views' window, `mainWindows()[0]`, same as theirs.
      setTrafficLightsCollapsed: (collapsed) => {
        mainWindows()[0]?.setWindowButtonPosition(trafficLightPositionFor(collapsed))
      },
      ...(menuBar === null
        ? {}
        : {
            menuBar,
            observe: (event: GladeEvent) => {
              menuBar.observe(event)
            },
          }),
      log,
    })

    const { runner } = bridge

    // Closing the window, or quitting, with unsaved edits in the Files tab is called off, and the window asks what to do
    // with them first; then it closes or quits again.
    app.on('before-quit', (event) => {
      if (closeGuard.callsOff(CloseKind.Quit)) event.preventDefault()
    })
    app.on('browser-window-created', (_event, window) => {
      window.on('close', (event) => {
        if (mainWindows().includes(window) && closeGuard.callsOff(CloseKind.Window)) event.preventDefault()
      })
    })

    if (testMode?.kind === TestModeKind.Capture && testAgent !== null) {
      void runCapture(testMode.spec, { database, bridge, agent: testAgent, log })
      return
    }
    // Carry on the turns the app last quit or crashed in; the window loads what they save from the database, and the
    // relaunch notice when it crashed. An e2e seed is the state the window opens on, not a run the app quit in, so it
    // goes in afterwards.
    const crashed = markRunning(database.db)
    if (crashed) log.warn('the app crashed or was killed last time')
    noteRelaunch(database.db, crashed, runner.resumeInterrupted())
    if (testMode?.kind === TestModeKind.E2e && !seedE2e(testMode.spec, database, log)) {
      runner.close()
      return
    }
    // The control API's HTTP endpoint listens from launch while Settings › Control has it on (after an e2e seed, which
    // may turn it on).
    void bridge.endpoint.sync()
    // A database from before each workspace kept its own selection still has only the window's; carry it over.
    backfillWorkspaceSelections(database.db)
    // The plugins are read when Glade starts, noting the new ones, and again each time Settings › Plugins opens.
    void bridge.plugins.list()
    // The menu bar icon shows from launch while Settings › General has it on (after an e2e seed, which may turn it off).
    if (menuBar !== null && drawing !== null) {
      menuBar.sync()
      drawing.started(menuBar)
    }

    app.on('will-quit', () => {
      log.info('app quitting')
      stopLoggingCrashes()
      runner.close()
      bridge.account.close()
      bridge.login.close()
      void bridge.endpoint.close()
      bridge.pluginViews.close()
      bridge.machine?.close()
      bridge.artifactWatch.close()
      bridge.folderWatch.close()
      menuBar?.close()
      // The shells end with the app; their tabs and recent output stay, for the next launch to show.
      if (database.db.open) bridge.terminals.shutdown()
      // Quitting can get here again once the database is closed; the mark went with the first time.
      if (database.db.open) markQuit(database.db)
      database.db.close()
    })

    createWindow(testMode, database.db, log)

    app.on('activate', () => {
      if (mainWindows().length === 0) createWindow(testMode, database.db, log)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
