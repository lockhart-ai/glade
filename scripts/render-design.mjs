#!/usr/bin/env node
// Renders the design screens in docs/design/html/*.html to docs/design/screens/*.png, in an Electron window that is
// never shown.
//
//   npm run render-design [-- <name> ...]
//   npm run check-design [-- <name> ...]
//
// With no names it renders every screen; with names (e.g. `task-workspace 01-new-task`) just those. Each screen is
// captured at its own size: the width and height of the first sized element in its markup (1920×1200 for most). The
// design tool's runtime (support.js) isn't needed: the markup is plain HTML with inline styles.
//
// A hidden window can hand back a frame from before its text painted, even once its fonts have loaded, so no capture
// is trusted: the page reports where its text is laid out, and the capture must show ink in those boxes (see
// scripts/lib/design-capture.mts). A capture that doesn't is retried, and the script fails if none passes.
//
// `--check` (check-design, run in CI) writes nothing: it renders every screen the same way, and also fails if a
// committed PNG in docs/design/screens is missing, the wrong size, or has no text where its HTML lays text out.
//
// Electron runs as a child (see scripts/lib/electron-run.mts) with its own throwaway data folder. It's SIGKILLed if no
// screen finishes for STALL_MS (or the whole run passes TIMEOUT_MS), and the script fails with the step it was stuck
// on: a hidden window that never paints (in a command sandbox, or while the Mac sleeps) otherwise hangs it for good.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { backoffMs, captureProblems, captureWithRetries, pageProblems } from './lib/design-capture.mts'
import {
  exitOnErrors,
  exitWhenOrphaned,
  runElectron,
  runExitCode,
  runFailureMessage,
  stepLine,
} from './lib/electron-run.mts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = join(ROOT, 'docs/design/html')
const SCREENS = join(ROOT, 'docs/design/screens')
const TIMEOUT_MS = 300_000
/** How long Electron may go without a screen finishing (rendered, checked or failed) before it's stopped. */
const STALL_MS = 60_000
/** A line that says a screen finished: `Rendered …`, `Checked …`, or one of the script's own warnings or errors. */
const PROGRESS = /^(Rendered |Checked |render-design: )/
/** How long a screen's page may take to lay out at the screen's size before the screen fails. */
const SIZE_WAIT_MS = 10_000
/** How many times a screen is captured before the script gives up on it. */
const ATTEMPTS = 6

/** The screen's size: the first `width: Npx; height: Npx` in its markup. */
function sizeOf(file) {
  const match = /width: (\d+)px; height: (\d+)px/.exec(readFileSync(file, 'utf8'))
  if (match === null) throw new Error(`${basename(file)} has no sized root element`)
  return { width: Number(match[1]), height: Number(match[2]) }
}

function screensToRender(names) {
  const all = readdirSync(HTML)
    .filter((file) => file.endsWith('.html'))
    .map((file) => file.slice(0, -'.html'.length))
  for (const name of names) {
    if (!all.includes(name)) {
      console.error(`render-design: no docs/design/html/${name}.html`)
      process.exit(2)
    }
  }
  return (names.length === 0 ? all : names).map((name) => {
    const file = join(HTML, `${name}.html`)
    return { name, page: `${name}.html`, out: join(SCREENS, `${name}.png`), ...sizeOf(file) }
  })
}

const TYPES = { '.html': 'text/html', '.woff2': 'font/woff2', '.png': 'image/png', '.js': 'text/javascript' }

/**
 * Serves docs/design/html on a local port. The pages can't be opened as files: Chromium won't load their fonts from a
 * file:// page, so the text would never paint.
 */
async function serveDesigns() {
  const server = createServer((request, response) => {
    const path = normalize(join(HTML, decodeURIComponent(new URL(request.url ?? '/', 'http://x').pathname)))
    if (!path.startsWith(HTML) || !existsSync(path)) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'Content-Type': TYPES[extname(path)] ?? 'application/octet-stream' })
    response.end(readFileSync(path))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return server
}

// The waits and measureText run in the page (passed as source to executeJavaScript), so they use its globals.
/* global document, innerWidth, innerHeight, devicePixelRatio, requestAnimationFrame, NodeFilter, getComputedStyle */

/** Runs in the page. Asks for every declared font face and image, and waits for them and `document.fonts.ready`. */
async function waitForFonts() {
  await Promise.all([
    ...[...document.fonts].map((font) => font.load().catch(() => undefined)),
    ...[...document.images].map((image) => image.decode().catch(() => undefined)),
  ])
  await document.fonts.ready
}

/**
 * Runs in the page. Waits for the window to lay out at the screen's size, and fails after `giveUpMs` with the size it
 * has instead. A page zoomed to 2x, say, lays out at half the window's size and never gets there.
 */
async function waitForSize(width, height, giveUpMs) {
  const giveUp = Date.now() + giveUpMs
  while (innerWidth !== width || innerHeight !== height) {
    if (Date.now() > giveUp) {
      throw new Error(
        `the page laid out at ${String(innerWidth)}×${String(innerHeight)} (devicePixelRatio ${String(devicePixelRatio)}), ` +
          `not ${String(width)}×${String(height)}, after ${String(giveUpMs / 1000)} s`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

/** Runs in the page. Waits for a frame to paint. */
function waitForFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
}

/** Says which step the render is on (see STEP_PREFIX in scripts/lib/electron-run.mts). */
function step(text) {
  console.log(stepLine(text))
}

/** Waits for what's been printed to reach the script: its output is a pipe, which Node writes to asynchronously. */
function flushOutput() {
  return Promise.all(
    [process.stdout, process.stderr].map((stream) => new Promise((resolve) => stream.write('', resolve))),
  )
}

/**
 * Runs in the page. Reports its fonts, and the boxes of its visible text runs (a `PageReport`): every non-blank text
 * node outside <style>/<script>/<title> whose element is visible, in a colour that isn't transparent.
 */
function measureText() {
  const boxes = []
  let unlaidText = 0
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const element = node.parentElement
    if (element === null || node.textContent.trim() === '') continue
    if (element.closest('style, script, title, template') !== null) continue
    if (!element.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
    const color = getComputedStyle(element).color
    if (color === 'transparent' || /, 0\)$/.test(color)) continue
    const range = document.createRange()
    range.selectNodeContents(node)
    const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0)
    if (rects.length === 0) {
      unlaidText++
      continue
    }
    for (const rect of rects) {
      const left = Math.max(0, rect.left)
      const top = Math.max(0, rect.top)
      const right = Math.min(innerWidth, rect.right)
      const bottom = Math.min(innerHeight, rect.bottom)
      // Too small to judge: a sliver clipped at the edge.
      if (right - left >= 4 && bottom - top >= 6)
        boxes.push({ x: left, y: top, width: right - left, height: bottom - top })
    }
  }
  return {
    fontsStatus: document.fonts.status,
    failedFonts: [...document.fonts]
      .filter((font) => font.status !== 'loaded')
      .map((font) => ({ family: font.family, status: font.status })),
    textBoxes: boxes,
    unlaidText,
  }
}

/** The capture at 1x, and its pixels: a Retina display captures at 2x, and the screens have always been 1x. */
function scaled(image, width, height) {
  const oneX = image.getSize().width === width ? image : image.resize({ width, height, quality: 'best' })
  return { image: oneX, bitmap: { ...oneX.getSize(), data: oneX.toBitmap() } }
}

async function renderInElectron() {
  const { app, BrowserWindow, nativeImage } = await import('electron')
  const { screens, check, userData } = JSON.parse(process.env.GLADE_RENDER_DESIGN ?? '{}')
  // Its own data folder, which the script removes afterwards, so no other Electron's locks or caches are in the way.
  app.setPath('userData', userData)
  app.dock?.hide()
  // If the script is killed outright, it can't stop this Electron or remove its data folder, so Electron does both:
  // on its next line of output, which fails once nothing reads it, or when it notices it's orphaned. It kills itself
  // rather than quitting, which waits on a GPU process that may be wedged, and never waits in Electron's error dialog.
  // (Its helpers exit with it; one may write a cache index back into the folder as they go, which the OS clears.)
  const abandon = () => {
    rmSync(userData, { recursive: true, force: true })
    process.kill(process.pid, 'SIGKILL')
  }
  exitOnErrors({
    streams: [process.stdout, process.stderr],
    errors: process,
    report: (error) => console.error(`render-design: ${error.stack ?? error.message}`),
    exit: () => app.exit(1),
    abandon,
  })
  exitWhenOrphaned({ parent: process.ppid, currentParent: () => process.ppid, exit: abandon, intervalMs: 1000 })
  step('waiting for Electron to get ready')
  await app.whenReady()
  step('serving the designs and opening a hidden window')
  const server = await serveDesigns()
  const { port } = server.address()
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    enableLargerThanScreen: true,
    backgroundColor: '#0A0B0F',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  const failures = []
  for (const screen of screens) {
    try {
      const size = `${String(screen.width)}×${String(screen.height)}`
      window.setContentSize(screen.width, screen.height)
      step(`${screen.name}: loading ${screen.page}`)
      await window.loadURL(`http://127.0.0.1:${String(port)}/${screen.page}`)
      // Chromium keeps a zoom level per host, and every screen is served from 127.0.0.1: one zoom level saved in a
      // shared data folder once laid every later render out at half size, so its wait for the size never ended.
      window.webContents.setZoomFactor(1)
      step(`${screen.name}: waiting for its fonts and images`)
      await window.webContents.executeJavaScript(`(${waitForFonts.toString()})()`)
      step(`${screen.name}: waiting for the window to be ${size}`)
      await window.webContents.executeJavaScript(
        `(${waitForSize.toString()})(${String(screen.width)}, ${String(screen.height)}, ${String(SIZE_WAIT_MS)})`,
      )
      step(`${screen.name}: waiting for a frame to paint`)
      await window.webContents.executeJavaScript(`(${waitForFrame.toString()})()`)
      const { image, report } = await captureWithRetries({
        label: screen.page,
        attempts: ATTEMPTS,
        delayMs: backoffMs,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        onRetry: (attempt, problems) =>
          console.warn(`render-design: ${screen.page} attempt ${String(attempt)}: ${problems.join('; ')}; retrying`),
        run: async (attempt) => {
          // After a failed attempt, ask for a fresh frame rather than the one that just came back without text.
          if (attempt > 1) {
            step(`${screen.name}: attempt ${String(attempt)}: waiting for a fresh frame to paint`)
            window.webContents.invalidate()
            await window.webContents.executeJavaScript(`(${waitForFrame.toString()})()`)
          }
          step(`${screen.name}: attempt ${String(attempt)}: measuring its text boxes`)
          const report = await window.webContents.executeJavaScript(`(${measureText.toString()})()`)
          const notReady = pageProblems(report)
          if (notReady.length > 0) return { ok: false, problems: notReady }
          step(`${screen.name}: attempt ${String(attempt)}: capturing the window`)
          const { image, bitmap } = scaled(await window.webContents.capturePage(), screen.width, screen.height)
          const problems = captureProblems(bitmap, report.textBoxes, screen.width, screen.height)
          return problems.length > 0 ? { ok: false, problems } : { ok: true, value: { image, report } }
        },
      })
      if (!check) {
        writeFileSync(screen.out, image.toPNG())
        console.log(`Rendered ${screen.out}`)
        continue
      }
      const png = `docs/design/screens/${screen.name}.png`
      const committed = nativeImage.createFromPath(screen.out)
      const problems = committed.isEmpty()
        ? [`${png} is missing or unreadable`]
        : captureProblems(
            { ...committed.getSize(), data: committed.toBitmap() },
            report.textBoxes,
            screen.width,
            screen.height,
          ).map((problem) => `${png}: ${problem}`)
      if (problems.length > 0) throw new Error(problems.join('; '))
      console.log(`Checked ${screen.name}: it renders with its text, and so does its PNG`)
    } catch (error) {
      failures.push(`${screen.name}: ${error.message}`)
      console.error(`render-design: ${screen.name}: ${error.message}`)
    }
  }
  window.destroy()
  server.close()
  if (failures.length > 0) {
    console.error(`render-design: ${String(failures.length)} of ${String(screens.length)} screens failed:`)
    for (const failure of failures) console.error(`  ${failure.split('\n')[0]}`)
    if (check) console.error('Re-render them with `npm run render-design -- <name> ...` and commit the PNGs.')
    await flushOutput()
    app.exit(1)
    return
  }
  app.quit()
}

if (process.versions.electron !== undefined) {
  // Not awaited: Electron doesn't get ready while its ESM entry point is still evaluating.
  renderInElectron().catch(async (error) => {
    console.error(`render-design: ${error.message}`)
    await flushOutput()
    process.exit(1)
  })
} else {
  const args = process.argv.slice(2)
  const check = args.includes('--check')
  const screens = screensToRender(args.filter((arg) => arg !== '--check'))
  const options = {
    tool: 'render-design',
    command: createRequire(import.meta.url)('electron'),
    args: [fileURLToPath(import.meta.url)],
    cwd: ROOT,
    env: (userData) => {
      const env = { ...process.env, GLADE_RENDER_DESIGN: JSON.stringify({ screens, check, userData }) }
      delete env.ELECTRON_RUN_AS_NODE
      return env
    },
    timeoutMs: TIMEOUT_MS,
    stall: { ms: STALL_MS, progress: PROGRESS },
  }
  const result = await runElectron(options)
  const message = runFailureMessage(options, result)
  if (message !== undefined) console.error(message)
  process.exit(runExitCode(result))
}
