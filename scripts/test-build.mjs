// The build the test tools run against (`npm run screenshot`, `npm run test:e2e`, `npm run record`): the app built
// into out/testing in the `testing` mode, which keeps dev-only pages such as the component gallery.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TEST_BUILD_DIR = join(ROOT, 'out', 'testing')
/** The built main script to launch Electron on. */
export const TEST_MAIN = join(TEST_BUILD_DIR, 'main', 'index.js')

/** What the build is made from: when none of it is newer than the built main script, the build is up to date. */
const INPUTS = ['src', 'electron.vite.config.ts', 'package.json', 'package-lock.json']

function newestChange(path) {
  const stats = statSync(path)
  if (!stats.isDirectory()) return stats.mtimeMs
  return Math.max(stats.mtimeMs, ...readdirSync(path).map((entry) => newestChange(join(path, entry))))
}

/** Whether the test build is missing or older than anything it's made from. */
export function testBuildIsStale() {
  if (!existsSync(TEST_MAIN)) return true
  const built = statSync(TEST_MAIN).mtimeMs
  return INPUTS.some((input) => newestChange(join(ROOT, input)) > built)
}

/** Builds the app into out/testing. Returns whether it succeeded; the build's errors go to stderr. */
export function buildForTests() {
  const build = spawnSync('npx', ['electron-vite', 'build', '--mode', 'testing', '--outDir', TEST_BUILD_DIR], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  return build.status === 0
}
