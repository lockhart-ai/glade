import { defineConfig } from '@playwright/test'
import { INNER_OUTPUT_ENV, INNER_REPORT_ENV } from './inner'

/**
 * The Playwright run `../evidence.spec.ts` starts on `./kept.inner.ts`: tests that fail on purpose, to check what the
 * `launch` fixture keeps of a failed test. It has no global setup: the suite's own has built the app by then.
 */
export default defineConfig({
  testDir: __dirname,
  testMatch: '*.inner.ts',
  outputDir: process.env[INNER_OUTPUT_ENV] ?? 'out/e2e-inner-results',
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: [['json', { outputFile: process.env[INNER_REPORT_ENV] ?? 'out/e2e-inner-results/report.json' }]],
})
