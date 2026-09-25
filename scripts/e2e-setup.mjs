// Playwright's global setup (playwright.config.ts): builds the app into out/testing when it's missing or stale, before
// any spec launches it. It runs however the specs are started, `npm run test:e2e` or a bare `npx playwright test`, so
// no spec runs against a missing build (Electron would open no window and the test would wait out its timeout) or an
// old one.
import { ensureTestBuild } from './test-build.mjs'

export default function globalSetup() {
  ensureTestBuild()
}
