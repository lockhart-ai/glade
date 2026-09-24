/**
 * E2E mode, behind `npm run test:e2e` and `npm run record`: Playwright launches the built app with an e2e spec in the
 * environment, and the app runs as normal, except that its data folder is a throwaway temp folder, its window is never
 * shown (Playwright drives and records it over the DevTools protocol), and native dialogs, which a test can't click,
 * answer with what the test asked for. It never runs in a packaged app.
 */
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { AGENT_SCRIPT_NAMES, type AgentScriptName } from './agent/scripts'
import type { Desktop } from './desktop'
import { isInTempFolder, isolateApp, type IsolatedApp } from './isolation'

/** The environment variable that carries the e2e spec, as JSON. */
export const E2E_ENV = 'GLADE_E2E'

/**
 * The environment variable the folder dialog answers with in e2e mode: the chosen folder's path, or unset for
 * "cancelled". Main reads it each time the dialog opens, so a test can change it while the app runs.
 */
export const E2E_CHOSEN_FOLDER_ENV = 'GLADE_E2E_CHOSEN_FOLDER'

/**
 * Where e2e mode puts its notifier on the main process's global object: a `RecordingNotifier`
 * (`./notifications/recording-notifier`), which records the notifications the app would show, and clicks them, since
 * an e2e run never shows a real one. A spec reads and clicks it through Playwright's `app.evaluate`.
 */
export const E2E_NOTIFIER_GLOBAL = '__gladeE2eNotifier'

/**
 * Where e2e mode puts the network's state on the main process's global object: an `E2eNetwork`, online until a spec
 * says otherwise. A spec sets it through Playwright's `app.evaluate`, to take the app offline and back, since an e2e
 * run can't unplug the machine. The app reads it in place of Electron's `net.isOnline()`.
 */
export const E2E_NETWORK_GLOBAL = '__gladeE2eNetwork'

/**
 * Where e2e mode puts the files Open in editor opened on the main process's global object: an `E2eEditor`, since an e2e
 * run never opens a real editor. A spec reads it through Playwright's `app.evaluate`.
 */
export const E2E_EDITOR_GLOBAL = '__gladeE2eEditor'

/** The files Open in editor opened in e2e mode (`E2E_EDITOR_GLOBAL`), oldest first, by their real paths. */
export interface E2eEditor {
  readonly opened: string[]
}

/**
 * Puts an empty `E2eEditor` on the global object for a spec to read (`E2E_EDITOR_GLOBAL`), and answers with what opens
 * a file in e2e mode in place of Electron's `shell.openPath`: it records the path, and succeeds.
 */
export function createE2eEditor(): (path: string) => Promise<string> {
  const editor: E2eEditor = { opened: [] }
  Reflect.set(globalThis, E2E_EDITOR_GLOBAL, editor)
  return (path) => {
    editor.opened.push(path)
    return Promise.resolve('')
  }
}

/**
 * Where e2e mode puts what the context menus copied and revealed on the main process's global object: an `E2eDesktop`,
 * since an e2e run never touches the real clipboard or Finder. A spec reads it through Playwright's `app.evaluate`.
 */
export const E2E_DESKTOP_GLOBAL = '__gladeE2eDesktop'

/** What the context menus copied and revealed in e2e mode (`E2E_DESKTOP_GLOBAL`), oldest first. */
export interface E2eDesktop {
  /** The text each Copy put on the clipboard. */
  readonly copied: string[]
  /** The real path of each file Reveal in Finder showed. */
  readonly revealed: string[]
}

/**
 * Puts an empty `E2eDesktop` on the global object for a spec to read (`E2E_DESKTOP_GLOBAL`), and answers with the
 * `Desktop` that records into it in place of Electron's clipboard and Finder.
 */
export function createE2eDesktop(): Desktop {
  const desktop: E2eDesktop = { copied: [], revealed: [] }
  Reflect.set(globalThis, E2E_DESKTOP_GLOBAL, desktop)
  return {
    writeClipboard: (text) => {
      desktop.copied.push(text)
      return Promise.resolve()
    },
    showItemInFolder: (path) => {
      desktop.revealed.push(path)
    },
  }
}

/** The network's state in e2e mode (`E2E_NETWORK_GLOBAL`). */
export interface E2eNetwork {
  online: boolean
}

/**
 * Puts the network's state, online, on the global object for a spec to change (`E2E_NETWORK_GLOBAL`), and answers
 * with what tells the app whether it's online.
 */
export function createE2eNetwork(): () => boolean {
  const network: E2eNetwork = { online: true }
  Reflect.set(globalThis, E2E_NETWORK_GLOBAL, network)
  return () => network.online
}

/** The window's content size in e2e mode, which is also the size of the recordings. */
export const E2E_WINDOW_SIZE = { width: 1920, height: 1200 } as const

/** How the app runs under test, handed to it by the e2e fixtures (`e2e/fixtures.ts`). */
export interface E2eSpec {
  /**
   * The app's data folder for the run: a folder in the system temp folder, made (and removed afterwards) by the test.
   * It's empty on the first launch; a test that relaunches the app passes it again.
   */
  readonly userData: string
  /** The page's location hash, e.g. `#gallery`, or `''` for the app itself. */
  readonly route: string
  /** The agent script every task's agent plays (see `src/main/agent/scripts.ts`). None by default: no agent runs. */
  readonly agentScript?: AgentScriptName
  /**
   * The agent scripts to play in place of `agentScript` for the tasks whose first message is exactly the key, so a spec
   * can run different scripts in different tasks at once. A task's agent picks its script on its first message.
   */
  readonly agentScriptsByFirstMessage?: Readonly<Record<string, AgentScriptName>>
  /**
   * A JSON fixture of sample data (see `./capture-seed`) to fill the database with before the window opens, on top of
   * whatever the data folder already holds. A test passes it on its first launch only.
   */
  readonly seed?: string
}

const e2eSpecSchema: z.ZodType<E2eSpec> = z.strictObject({
  userData: z.string().refine(isInTempFolder, 'must be a folder in the system temp folder'),
  route: z.string().regex(/^(#[\w\-/]*)?$/, 'must be empty or a hash like #gallery'),
  agentScript: z.enum(AGENT_SCRIPT_NAMES).optional(),
  agentScriptsByFirstMessage: z.record(z.string(), z.enum(AGENT_SCRIPT_NAMES)).optional(),
  seed: z.string().refine(isAbsolute, 'must be an absolute path').optional(),
})

/** The e2e spec was set but isn't valid, or its data folder can't be used. */
export class E2eSpecError extends Error {}

/**
 * The e2e spec in `env`, or `null` when the app should run normally: when the variable isn't set, or when the app is
 * packaged, where e2e mode can never run. Throws an `E2eSpecError` when the spec is set but invalid.
 */
export function readE2eSpec(env: NodeJS.ProcessEnv, isPackaged: boolean): E2eSpec | null {
  const raw = env[E2E_ENV]
  if (isPackaged || raw === undefined) return null

  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (error) {
    throw new E2eSpecError(`${E2E_ENV} is not JSON: ${(error as Error).message}`)
  }
  const parsed = e2eSpecSchema.safeParse(json)
  if (!parsed.success) throw new E2eSpecError(`${E2E_ENV} is invalid: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

/**
 * Sets the app up for an e2e run. Call before the app is ready. Points the data folder at the spec's temporary folder
 * and hides the dock icon. The folder may hold an earlier run's data, so a test can relaunch the app on it. Throws an
 * `E2eSpecError` unless that folder exists.
 */
export function prepareE2e(app: IsolatedApp, spec: E2eSpec): void {
  try {
    isolateApp(app, { mode: 'e2e', userData: spec.userData, reuse: true })
  } catch (error) {
    throw new E2eSpecError((error as Error).message)
  }
}

/** What the folder dialog answers with in e2e mode: the folder the test chose, or `null` (cancelled) when none. */
export function e2eChosenFolder(env: NodeJS.ProcessEnv): string | null {
  const path = env[E2E_CHOSEN_FOLDER_ENV]
  return path === undefined || path === '' ? null : path
}
