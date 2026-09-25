// Whether the build the test tools run against (out/testing, see scripts/test-build.mjs) is up to date, and bringing
// it up to date. Every way into the e2e specs goes through `ensureTestBuild`: `npm run test:e2e` and a bare
// `npx playwright test` alike (Playwright's global setup, scripts/e2e-setup.mjs). Before it, a bare run launched
// Electron on a missing build and waited out the test's timeout, or on a stale one tested old code. Plain functions
// over the file system, so they can be unit tested without building anything.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** What the test build is made from, relative to the repo root. */
export const TEST_BUILD_INPUTS: readonly string[] = [
  'src',
  'electron.vite.config.ts',
  'package.json',
  'package-lock.json',
]

/** Where a test build is, and how to make it. */
export interface TestBuild {
  /** The repo root, which `inputs` are relative to. */
  readonly root: string
  /** What the build is made from, relative to `root`. */
  readonly inputs: readonly string[]
  /** The built main script: when none of the inputs is newer than it, the build is up to date. */
  readonly main: string
  /** Builds the app. Returns whether it succeeded. */
  readonly build: () => boolean
}

/** The newest modification time under a path: a file's own, or the newest of a folder and everything in it. */
function newestChange(path: string): number {
  const stats = statSync(path)
  if (!stats.isDirectory()) return stats.mtimeMs
  return Math.max(stats.mtimeMs, ...readdirSync(path).map((entry) => newestChange(join(path, entry))))
}

/** Whether the build is missing or older than anything it's made from. */
export function testBuildIsStale({ root, inputs, main }: Omit<TestBuild, 'build'>): boolean {
  if (!existsSync(main)) return true
  const built = statSync(main).mtimeMs
  return inputs.some((input) => newestChange(join(root, input)) > built)
}

/** Raised when the test build can't be brought up to date, so no spec runs against a missing or stale app. */
export class TestBuildError extends Error {
  override readonly name = 'TestBuildError'
}

/**
 * Builds the app when its test build is missing or stale, and returns whether it did. Throws a `TestBuildError` when
 * that build fails. (A boolean, not an enum: Node runs this file by stripping its types, which can't do enums.)
 */
export function ensureTestBuild(testBuild: TestBuild): boolean {
  if (!testBuildIsStale(testBuild)) return false
  if (!testBuild.build()) throw new TestBuildError('the test build failed')
  if (!existsSync(testBuild.main)) throw new TestBuildError(`the test build made no ${testBuild.main}`)
  return true
}
