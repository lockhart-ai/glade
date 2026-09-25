// The build the test tools run against (`npm run screenshot`, `npm run test:e2e`, `npm run record`): the app built
// into out/testing in the `testing` mode, which keeps dev-only pages such as the component gallery. Whether it's up to
// date is decided in scripts/lib/test-build.mts.
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ensureTestBuild as ensure, TEST_BUILD_INPUTS } from './lib/test-build.mts'

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TEST_BUILD_DIR = join(ROOT, 'out', 'testing')
/** The built main script to launch Electron on. */
export const TEST_MAIN = join(TEST_BUILD_DIR, 'main', 'index.js')

/** Builds the app into out/testing. Returns whether it succeeded; the build's errors go to stderr. */
export function buildForTests() {
  const build = spawnSync('npx', ['electron-vite', 'build', '--mode', 'testing', '--outDir', TEST_BUILD_DIR], {
    cwd: ROOT,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  return build.status === 0
}

/** Builds the app into out/testing when it's missing or stale, and returns whether it did. Throws when that fails. */
export function ensureTestBuild() {
  return ensure({
    root: ROOT,
    inputs: TEST_BUILD_INPUTS,
    main: TEST_MAIN,
    build: () => {
      console.log('e2e: building the app into out/testing')
      return buildForTests()
    },
  })
}
