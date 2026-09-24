/**
 * Isolation for the app's test modes (screenshot capture and e2e tests): a throwaway data folder, so the real database
 * is never touched, and no dock icon, so the app never appears or takes focus.
 */
import { readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, relative } from 'node:path'

/** Whether `path` is an absolute path inside (not at) the system temp folder. */
export function isInTempFolder(path: string): boolean {
  const inside = relative(tmpdir(), path)
  return isAbsolute(path) && inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

/** The parts of Electron's `app` that a test mode sets up before the app is ready. */
export interface IsolatedApp {
  setPath(name: 'userData', path: string): void
  readonly dock?: { hide(): void } | undefined
}

/** How a test mode isolates the app. */
export interface Isolation {
  /** The test mode's name, for errors. */
  readonly mode: string
  /** The temporary folder to keep the app's data in. */
  readonly userData: string
  /** Whether the folder may already hold data, e.g. when a test relaunches the app on the data of an earlier run. */
  readonly reuse: boolean
}

/**
 * Points the app's data folder at a temporary folder and hides the dock icon. Call before the app is ready. Throws
 * unless the folder exists and, when it may not be reused, is empty.
 */
export function isolateApp(app: IsolatedApp, { mode, userData, reuse }: Isolation): void {
  let entries: string[]
  try {
    entries = readdirSync(userData)
  } catch (error) {
    throw new Error(`the ${mode} data folder can't be read: ${(error as Error).message}`)
  }
  if (!reuse && entries.length > 0) throw new Error(`the ${mode} data folder ${userData} is not empty`)
  app.setPath('userData', userData)
  app.dock?.hide()
}
