#!/usr/bin/env node
// Captures PNGs of the app from inside Electron, in a window that is never shown, with a throwaway data folder.
//
//   npm run screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <file base name>]
//                         [--seed <fixture.json>] [--agent-script <name> [--message <first message>]]
//                         [--press <key> ...] [--click <selector> ...] [--plugins <folder> ...]
//
// With --press (e.g. `--press Meta+,` for the Settings modal), the app presses each key in the page, in order, once it's
// ready and before capturing: a key name as KeyboardEvent.key has it, after any of Meta+, Shift+, Alt+ and Control+.
// With --click, it then clicks each element, by CSS selector, in order, once it shows up, waiting each time until
// nothing is busy. Settings › Plugins, with one workspace: `--click 'button[aria-label="Switch workspace"]'
// --click '[role="menu"] button:nth-of-type(4)' --click 'nav[aria-label="Settings sections"] button:nth-of-type(6)'`.
//
// With --plugins, the app starts with each folder's sample plugins (scripts/fixtures/plugins/valid and invalid)
// copied into its plugins folder. The first enabled one shows beside the terminal, its view pasted into the capture:
// e2e/plugins has the fixture plugin, which lists Glade's messages.
//
// With --agent-script, the capture shows a live task: the app makes a workspace and a task, sends it the first
// message, and lets the named agent script (src/main/agent/scripts.ts: simple-reply, multi-tool-turn, long-running,
// failing-turn, flaky-api) play its reply through the real agent runner, before capturing. No real agent ever runs.
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
const DEFAULT_MESSAGE = 'The date formatting test fails in some timezones. Can you fix it?'

function fail(message) {
  console.error(`screenshot: ${message}`)
  console.error(
    'usage: npm run screenshot -- --out <dir> [--size 1920x1200 ...] [--route #gallery] [--name <name>] ' +
      '[--seed <fixture>] [--agent-script <name> [--message <text>]] [--press <key> ...] [--click <selector> ...] ' +
      '[--plugins <folder> ...]',
  )
  process.exit(2)
}

/** `Meta+Shift+K` as the key press the app dispatches: the key, and which modifiers are held. */
function parsePress(press) {
  const parts = press.split('+')
  const key = parts.pop()
  const modifiers = new Set(parts)
  const known = new Set(['Meta', 'Shift', 'Alt', 'Control'])
  if (key === undefined || key === '' || [...modifiers].some((modifier) => !known.has(modifier))) {
    fail(`--press must look like Meta+, or Escape (got ${press})`)
  }
  return {
    key,
    metaKey: modifiers.has('Meta'),
    shiftKey: modifiers.has('Shift'),
    altKey: modifiers.has('Alt'),
    ctrlKey: modifiers.has('Control'),
  }
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
      'agent-script': { type: 'string' },
      message: { type: 'string', default: DEFAULT_MESSAGE },
      seed: { type: 'string' },
      press: { type: 'string', multiple: true },
      click: { type: 'string', multiple: true },
      plugins: { type: 'string', multiple: true },
    },
  }))
} catch (error) {
  fail(error.message)
}
if (values.out === undefined) fail('--out is required')

const route = values.route === '' || values.route.startsWith('#') ? values.route : `#${values.route}`
const agentScript = values['agent-script']
const defaultName = route === '' ? (agentScript ?? 'glade') : route.slice(1).replaceAll('/', '-')
const name = values.name ?? defaultName
const spec = {
  outDir: resolve(values.out),
  route,
  shots: (values.size ?? [DEFAULT_SIZE]).map((size) => {
    const { width, height } = parseSize(size)
    return { width, height, file: `${name}-${String(width)}x${String(height)}.png` }
  }),
  timeoutMs: TIMEOUT_MS,
  ...(agentScript === undefined ? {} : { conversation: { agentScript, message: values.message } }),
  ...(values.seed === undefined ? {} : { seed: resolve(values.seed) }),
  ...(values.press === undefined ? {} : { presses: values.press.map(parsePress) }),
  ...(values.click === undefined ? {} : { clicks: values.click }),
  ...(values.plugins === undefined ? {} : { plugins: values.plugins.map((folder) => resolve(folder)) }),
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
