#!/usr/bin/env node
// Renders the design screens in docs/design/html/*.html to docs/design/screens/*.png, in an Electron window that is
// never shown.
//
//   npm run render-design [-- <name> ...]
//
// With no names it renders every screen; with names (e.g. `task-workspace 01-new-task`) just those. Each screen is
// captured at its own size: the width and height of the first sized element in its markup (1920×1200 for most). The
// design tool's runtime (support.js) isn't needed: the markup is plain HTML with inline styles.
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { basename, dirname, extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = join(ROOT, 'docs/design/html')
const SCREENS = join(ROOT, 'docs/design/screens')
const TIMEOUT_MS = 180_000
/** How long a screen settles after its fonts and layout are ready, before it is captured. */
const SETTLE_MS = 1000

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

async function renderInElectron() {
  const { app, BrowserWindow } = await import('electron')
  const screens = JSON.parse(process.env.GLADE_RENDER_DESIGN ?? '[]')
  app.dock?.hide()
  await app.whenReady()
  const server = await serveDesigns()
  const { port } = server.address()
  const window = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    enableLargerThanScreen: true,
    backgroundColor: '#0A0B0F',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  for (const screen of screens) {
    window.setContentSize(screen.width, screen.height)
    await window.loadURL(`http://127.0.0.1:${String(port)}/${screen.page}`)
    // Fonts and images load after the document; wait for them, and for the page to lay out at its size, before capturing.
    await window.webContents.executeJavaScript(
      `Promise.all([
        document.fonts.load('16px Geist'),
        document.fonts.load('16px "Geist Mono"'),
        ...[...document.images].map((image) => image.decode().catch(() => {})),
      ])
        .then(() => document.fonts.ready)
        .then(() => new Promise((resolve) => {
          const check = () => document.fonts.status === 'loaded' && [...document.fonts].every((font) => font.status === 'loaded')
            ? resolve()
            : setTimeout(check, 20)
          check()
        }))
        .then(() => new Promise((resolve) => {
          const check = () => innerWidth === ${String(screen.width)} && innerHeight === ${String(screen.height)}
            ? requestAnimationFrame(() => requestAnimationFrame(resolve))
            : setTimeout(check, 20)
          check()
        }))`,
    )
    // The hidden window can still hand back a frame without its text for a moment after that (it did for about half
    // the screens), so let it settle before capturing.
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
    // A Retina display captures at 2x; scale it down so the PNG is at 1x, like the screens have always been.
    const image = await window.webContents.capturePage()
    const png = image.resize({ width: screen.width, height: screen.height, quality: 'best' }).toPNG()
    writeFileSync(screen.out, png)
    console.log(`Rendered ${screen.out}`)
  }
  window.destroy()
  server.close()
  app.quit()
}

if (process.versions.electron !== undefined) {
  // Not awaited: Electron doesn't get ready while its ESM entry point is still evaluating.
  renderInElectron().catch((error) => {
    console.error(`render-design: ${error.message}`)
    process.exit(1)
  })
} else {
  const screens = screensToRender(process.argv.slice(2))
  const env = { ...process.env, GLADE_RENDER_DESIGN: JSON.stringify(screens) }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = createRequire(import.meta.url)('electron')
  const run = spawnSync(electron, [fileURLToPath(import.meta.url)], {
    cwd: ROOT,
    env,
    stdio: 'inherit',
    timeout: TIMEOUT_MS,
  })
  if (run.error !== undefined) console.error(`render-design: ${run.error.message}`)
  process.exit(run.status ?? 1)
}
