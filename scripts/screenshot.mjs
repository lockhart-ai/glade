#!/usr/bin/env node
// Captures PNGs of the app from inside Electron, in a window that is never shown, with a throwaway data folder.
//
//   npm run screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <file base name>]
//                         [--seed <fixture.json>]
//
// Builds the app into out/testing (see scripts/test-build.mjs, which keeps dev-only pages such as the gallery), then
// launches Electron on it with the capture spec in GLADE_CAPTURE (see src/main/capture.ts), and a fresh temp folder
// for the app's data, removed afterwards. Writes one PNG per size, named <name>-<width>x<height>.png. With --seed, the
// app fills that data folder's database from a JSON fixture of sample data first (see src/main/capture-seed.ts and
// scripts/fixtures/), so the capture shows a populated app rather than the first-run screen.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { buildForTests, ROOT, TEST_MAIN } from './test-build.mjs'

const DEFAULT_SIZE = '1920x1200'
const TIMEOUT_MS = 60_000

function fail(message) {
  console.error(`screenshot: ${message}`)
  console.error(
    'usage: npm run screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <name>] [--seed <fixture>]',
  )
  process.exit(2)
}

function parseSize(size) {
  const match = /^(\d+)x(\d+)$/.exec(size)
  if (match === null) fail(`--size must look like 1920x1200 (got ${size})`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

let values
try {
  ;({ values } = parseArgs({
    options: {
      out: { type: 'string' },
      size: { type: 'string', multiple: true },
      route: { type: 'string', default: '' },
      name: { type: 'string' },
      seed: { type: 'string' },
    },
  }))
} catch (error) {
  fail(error.message)
}
if (values.out === undefined) fail('--out is required')

const route = values.route === '' || values.route.startsWith('#') ? values.route : `#${values.route}`
const name = values.name ?? (route === '' ? 'glade' : route.slice(1).replaceAll('/', '-'))
const spec = {
  outDir: resolve(values.out),
  route,
  shots: (values.size ?? [DEFAULT_SIZE]).map((size) => {
    const { width, height } = parseSize(size)
    return { width, height, file: `${name}-${String(width)}x${String(height)}.png` }
  }),
  timeoutMs: TIMEOUT_MS,
  ...(values.seed === undefined ? {} : { seed: resolve(values.seed) }),
}

if (!buildForTests()) {
  console.error('screenshot: the build failed')
  process.exit(1)
}

// Launch Electron straight on the built main script. No dev server, and never as plain Node.
const userData = mkdtempSync(join(tmpdir(), 'glade-capture-'))
const env = { ...process.env, GLADE_CAPTURE: JSON.stringify({ ...spec, userData }) }
delete env.ELECTRON_RENDERER_URL
delete env.ELECTRON_RUN_AS_NODE
const electron = createRequire(import.meta.url)('electron')
const run = spawnSync(electron, [TEST_MAIN], {
  cwd: ROOT,
  env,
  stdio: 'inherit',
  // The app gives up by itself after TIMEOUT_MS; this is the backstop if it hangs anyway.
  timeout: TIMEOUT_MS + 15_000,
})
rmSync(userData, { recursive: true, force: true })
if (run.error !== undefined) console.error(`screenshot: ${run.error.message}`)
process.exit(run.status ?? 1)
