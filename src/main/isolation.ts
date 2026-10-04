/**
 * Isolation for the app's test modes (screenshot capture and e2e tests): a throwaway data folder, so the real database
 * is never touched, and no dock icon, so the app never appears or takes focus.
 */
import { readdirSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'

/** Whether `path` is an absolute path inside (not at) `folder`. */
function isInside(folder: string, path: string): boolean {
  const inside = relative(folder, path)
  return isAbsolute(path) && inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
}

/** Whether `path` is an absolute path inside (not at) the system temp folder. */
export function isInTempFolder(path: string): boolean {
  return isInside(tmpdir(), path)
}

/**
 * Whether `path` is inside the system temp folder by either of its names: the one the environment gives
 * (`/var/folders/…/T` on macOS), or where that really is (`/private/var/folders/…/T`), which is the name a folder
 * there has once its links are followed.
 */
export function isInTempFolderForReal(path: string): boolean {
  return isInTempFolder(path) || isInside(realpathSync(tmpdir()), path)
}

/** Where a test mode writes its log: in its throwaway data folder, so a test never writes to your logs folder. */
export function testModeLogsFolder(userData: string): string {
  return join(userData, 'logs')
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
