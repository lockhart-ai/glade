import { join } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, type WebPreferences } from 'electron'
import type { AgentBackend } from './agent/backend'
import { createSdkBackend } from './agent/sdk-backend'
import { AGENT_SCRIPTS, type AgentScriptName } from './agent/scripts'
import { createTestModeAgentBackend, type TestModeAgentBackend } from './agent/test-mode-backend'
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
import { applySeed, readSeed } from './capture-seed'
import { chooseFolder } from './dialogs'
import { E2E_WINDOW_SIZE, e2eChosenFolder, prepareE2e, readE2eSpec, type E2eSpec } from './e2e'
import { checkSecurity, describeViolations } from './security'
import { seedConversation } from './capture-conversation'

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
function refuseToStart({ logSummary, message, detail }: StartFailure, testMode: TestMode): void {
  console.error(`Glade refused to start: ${logSummary}\n${detail}`)
  if (testMode === null) dialog.showErrorBox('Glade refused to start', `${message}\n\n${detail}`)
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

/**
 * Opens the main window: shown once it's ready, except in a test mode, where it's never shown (but still paints, so it
 * can be captured and recorded) and opens at the spec's route. In e2e mode it's the size of the recordings.
 */
function createWindow(testMode: TestMode): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: WINDOW_MIN_SIZE.width,
    minHeight: WINDOW_MIN_SIZE.height,
    show: false,
    ...(testMode === null ? {} : { paintWhenInitiallyHidden: true }),
    titleBarStyle: 'hiddenInset',
    backgroundColor: WINDOW_BACKGROUND,
    webPreferences: WINDOW_WEB_PREFERENCES,
  })

  // The renderer only ever shows the app's own page: no popups, no navigating away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => {
    event.preventDefault()
  })

  if (testMode === null) {
    window.once('ready-to-show', () => {
      window.show()
    })
  } else if (testMode.kind === TestModeKind.E2e) {
    window.setContentSize(E2E_WINDOW_SIZE.width, E2E_WINDOW_SIZE.height)
  }

  // In development electron-vite serves the renderer with hot reload; otherwise load the built file.
  const route = testMode?.spec.route ?? ''
  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl !== undefined) {
    void window.loadURL(`${devServerUrl}${route}`)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: route.replace(/^#/, '') })
  }
  return window
}

/** What a capture needs from the running app to seed its conversation. */
interface CaptureContext {
  readonly database: AppDatabase
  readonly bridge: RegisteredBridge
  readonly agent: TestModeAgentBackend
}

/** Fills the database from the spec's seed fixture and seeds its conversation, if it has them, then captures the page of a hidden window. Resolves with the files. */
async function capture(spec: CaptureSpec, { database, bridge, agent }: CaptureContext): Promise<string[]> {
  if (spec.seed !== undefined) applySeed(database.db, readSeed(spec.seed))
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
  return captureShots(createWindow({ kind: TestModeKind.Capture, spec }), spec)
}

/**
 * Runs a capture (see `capture`), then closes the database and exits: 0 when every PNG was written, 1 otherwise.
 */
async function runCapture(spec: CaptureSpec, context: CaptureContext): Promise<void> {
  let exitCode = 0
  try {
    const files = await withTimeout(capture(spec, context), spec.timeoutMs)
    for (const file of files) console.log(`Captured ${file}`)
  } catch (error) {
    console.error(`Glade capture failed: ${error instanceof Error ? error.message : String(error)}`)
    exitCode = 1
  }
  context.bridge.runner.close()
  context.database.db.close()
  app.exit(exitCode)
}

/**
 * Fills an e2e run's database from its seed fixture, if it has one, as a capture does. Returns false, having closed
 * the database and exited with an error, when the fixture can't be applied.
 */
function seedE2e(spec: E2eSpec, database: AppDatabase): boolean {
  if (spec.seed === undefined) return true
  try {
    applySeed(database.db, readSeed(spec.seed))
    return true
  } catch (error) {
    console.error(`Glade e2e failed: ${(error as Error).message}`)
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
 * a task's first message.
 */
function createTestModeAgent(testMode: NonNullable<TestMode>): TestModeAgentBackend {
  const name: AgentScriptName | undefined =
    testMode.kind === TestModeKind.Capture ? testMode.spec.conversation?.agentScript : testMode.spec.agentScript
  const byFirstMessage = testMode.kind === TestModeKind.E2e ? testMode.spec.agentScriptsByFirstMessage : undefined
  return createTestModeAgentBackend({
    script: name === undefined ? null : AGENT_SCRIPTS[name],
    byFirstMessage: new Map(
      Object.entries(byFirstMessage ?? {}).map(([message, script]) => [message, AGENT_SCRIPTS[script]]),
    ),
  })
}

/** What the app can be started with. */
export interface AppOptions {
  /**
   * Makes the backend the tasks' agents run on, once the app is ready. The Claude Agent SDK by default; unit tests pass
   * a fake. Never used in a test mode (e2e or capture), which always runs on `createTestModeAgentBackend`, so no
   * automated run can reach the real Claude API.
   */
  readonly createAgentBackend?: () => AgentBackend
}

/**
 * Starts the app: once Electron is ready, checks the window security settings, opens and migrates the database (closed
 * again on quit), registers the bridge the renderer talks to main through (with the agent runner behind it), then opens the main window.
 *
 * Outside a packaged app, a capture spec in the environment (see `./capture`) starts a screenshot run instead: the
 * same app with a throwaway data folder, in a window that is never shown, which captures its page and exits. An e2e
 * spec (see `./e2e`) runs the app as normal for Playwright to drive, with a throwaway data folder and a hidden window.
 */
export function startApp({ createAgentBackend = createSdkBackend }: AppOptions = {}): void {
  let testMode: TestMode
  try {
    testMode = startTestMode()
  } catch (error) {
    console.error(`Glade test mode failed: ${(error as Error).message}`)
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
        testMode,
      )
      return
    }

    const opening = openDatabase()
    if (!opening.ok) {
      refuseToStart(opening.failure, testMode)
      return
    }
    const { database } = opening

    // A test mode never reaches the real Claude API, whatever the app was started with: its agent plays a script.
    const testAgent = testMode === null ? null : createTestModeAgent(testMode)
    const bridge = registerBridge({
      ipc: ipcMain,
      db: database.db,
      targets: () => BrowserWindow.getAllWindows().map((window) => window.webContents),
      agentBackend: testAgent ?? createAgentBackend(),
      // A test can't click a native dialog, so in e2e mode it answers with the folder the test chose.
      chooseFolder:
        testMode?.kind === TestModeKind.E2e
          ? () => Promise.resolve(e2eChosenFolder(process.env))
          : () => chooseFolder(dialog, BrowserWindow.getFocusedWindow()),
    })

    const { runner } = bridge

    if (testMode?.kind === TestModeKind.Capture && testAgent !== null) {
      void runCapture(testMode.spec, { database, bridge, agent: testAgent })
      return
    }
    // Carry on the turns the app last quit or crashed in; the window loads what they save from the database. An e2e
    // seed is the state the window opens on, not a run the app quit in, so it goes in afterwards.
    runner.resumeInterrupted()
    if (testMode?.kind === TestModeKind.E2e && !seedE2e(testMode.spec, database)) {
      runner.close()
      return
    }

    app.on('will-quit', () => {
      runner.close()
      database.db.close()
    })

    createWindow(testMode)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(testMode)
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
