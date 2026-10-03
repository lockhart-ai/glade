import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests: Playwright drives the built app (out/testing) in e2e mode. Run them with `npm run test:e2e`, or
 * record them with `npm run record`; both go through scripts/e2e.mjs. However they're started, even as a bare
 * `npx playwright test`, the global setup builds the app first when it's missing or stale.
 */
export default defineConfig({
  testDir: 'e2e',
  // The stress specs (e2e/stress/) hunt for a rare failure over hundreds of runs on a loaded machine: they're no part
  // of the suite or of CI, and run only when asked for (each says how, at its top).
  testIgnore: process.env.GLADE_E2E_STRESS === undefined ? ['**/e2e/stress/**'] : [],
  globalSetup: './scripts/e2e-setup.mjs',
  outputDir: 'out/e2e-results',
  // Each test launches its own app, with its own data; one at a time keeps a CI runner calm and recordings smooth.
  workers: 1,
  forbidOnly: process.env.CI !== undefined,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI === undefined ? 'list' : [['list'], ['github']],
})
