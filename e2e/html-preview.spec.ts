// The Files viewer's HTML preview (#614), end to end: a static report renders as it would in a browser, and a
// hostile page is contained the same way a plugin's view is (`./html-preview.ts`, modelled on `./plugin-view.spec.ts`).
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { desktop, expect, test, type Glade } from './fixtures'
import { expectPreviewOverSlot, htmlPreviewPages, htmlPreviewView, inHtmlPreview } from './html-preview'
import { PNG } from '../src/shared/test-images'
import { filesTab, firstRun, taskList } from './selectors'

/** Makes a workspace folder holding `files` (path → content, text or bytes), in a throwaway folder. */
function workspace(tempFolder: () => string, files: Readonly<Record<string, string | Buffer>>): string {
  const root = join(tempFolder(), 'acme-api')
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), content)
  }
  return root
}

/** A local HTTP server that counts its requests, answering each with `ok`. */
async function countingServer(): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0
  const server = createServer((_request, response) => {
    hits += 1
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('ok')
  })
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  const { port } = server.address() as AddressInfo
  return { server, url: `http://127.0.0.1:${String(port)}/`, hits: () => hits }
}

const REPORT = `<!doctype html>
<html>
<head>
<style>
  body { font-family: sans-serif; background: #f6f3ff; color: #241f3d; margin: 0; padding: 24px; }
  h1 { color: #5b3df0; }
  table { border-collapse: collapse; width: 260px; }
  th, td { border: 1px solid #c9bdf7; padding: 8px 12px; text-align: left; }
  th { background: #e6ddff; }
</style>
</head>
<body>
  <h1>Acme API — Weekly Usage</h1>
  <table>
    <tr><th>Endpoint</th><th>Calls</th></tr>
    <tr><td>/search</td><td id="calls">…</td></tr>
  </table>
  <img src="chart.png" alt="Usage chart" width="80" height="80">
  <script>document.getElementById('calls').textContent = (60 * 24 * 7).toLocaleString()</script>
</body>
</html>
`

const HOSTILE = `<!doctype html>
<html><body>
<h1>Hostile</h1>
<a id="link" href="https://example.com/">External</a>
</body></html>
`

/** Opens the workspace and a new task, with nothing sent to the agent: these specs never need one. */
async function openTask(window: Glade['window']): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
}

test('html preview: a static report renders as it would in a browser, opening on the preview and following the file', async ({
  launch,
  tempFolder,
}) => {
  const root = workspace(tempFolder, {
    'reports/report.html': REPORT,
    'reports/chart.png': Buffer.from(PNG.data, 'base64'),
  })
  const glade = await launch({ chosenFolder: root })
  const { window } = glade
  await openTask(window)
  await window.keyboard.press('Meta+Alt+Digit2')
  const files = filesTab(window)
  await files.treeRow('reports').click()
  await files.treeRow('report.html').click()
  await window.keyboard.press('Enter')
  await expect(files.tab('report.html')).toHaveAttribute('aria-pressed', 'true')

  // A file with a preview opens on it (#657); the preview draws the native view over the slot.
  await expect(files.mode('Preview')).toHaveAttribute('aria-checked', 'true')
  await expectPreviewOverSlot(glade)
  expect(await htmlPreviewView(glade)).toMatchObject({
    url: 'glade-html-preview://preview/report.html',
    sandboxed: true,
  })
  expect(await inHtmlPreview(glade, 'document.querySelector("h1").textContent')).toBe('Acme API — Weekly Usage')
  expect(await inHtmlPreview(glade, 'document.getElementById("calls").textContent')).toBe('10,080')
  expect(await inHtmlPreview(glade, 'document.querySelector("img").naturalWidth > 0')).toBe(true)
  expect(await inHtmlPreview(glade, 'getComputedStyle(document.querySelector("h1")).color')).toBe('rgb(91, 61, 240)')

  // Switch to Source for the file's text, and back.
  await files.mode('Source').click()
  await expect(files.editorLine(1)).toContainText('<!doctype html>')
  await files.mode('Preview').click()
  await expectPreviewOverSlot(glade)

  // Switching to Browse (no file showing) goes: the slot leaves the page, and main hides the view, keeping its
  // page (as a plugin's does, turned off): no stale rectangle is left showing.
  await files.browse.click()
  await expect(files.htmlPreviewSlot).toHaveCount(0)
  await expect.poll(async () => (await htmlPreviewView(glade))?.visible).toBe(false)

  // Back on the file, a fresh mount opens on Preview again, as Markdown's does too.
  await files.tab('report.html').click()
  await expect(files.mode('Preview')).toHaveAttribute('aria-checked', 'true')
  await expectPreviewOverSlot(glade)
})

test('html preview: a hostile page is contained like a plugin’s view: no bridge, no network, no escape, no navigation', async ({
  launch,
  tempFolder,
}) => {
  const root = workspace(tempFolder, {
    'reports/hostile.html': HOSTILE,
    'secret.txt': 'SECRET',
  })
  const counting = await countingServer()
  try {
    const glade = await launch({ chosenFolder: root })
    const { window } = glade
    await openTask(window)
    await window.keyboard.press('Meta+Alt+Digit2')
    const files = filesTab(window)
    await files.treeRow('reports').click()
    await files.treeRow('hostile.html').click()
    await window.keyboard.press('Enter')
    await expectPreviewOverSlot(glade)

    // No preload, no bridge.
    expect(await inHtmlPreview(glade, 'typeof window.glade')).toBe('undefined')
    expect(await inHtmlPreview(glade, 'typeof require')).toBe('undefined')

    // A fetch never arrives: the CSP (`connect-src 'none'`) refuses it before it's even dispatched.
    expect(
      await inHtmlPreview(
        glade,
        `fetch(${JSON.stringify(counting.url)}).then(() => 'ok', (e) => 'blocked: ' + e.name)`,
      ),
    ).toMatch(/^blocked/)
    expect(counting.hits()).toBe(0)

    // Nor does an image to it: `img-src 'self'` refuses any host but the preview's own.
    const imageTo = (src: string): Promise<string> =>
      inHtmlPreview(
        glade,
        `new Promise((done) => { const i = new Image(); i.onload = () => done('loaded'); i.onerror = () => done('blocked'); i.src = ${JSON.stringify(src)} })`,
      )
    expect(await imageTo(counting.url)).toBe('blocked')
    expect(counting.hits()).toBe(0)
    await expect.poll(() => htmlPreviewView(glade)).not.toBeNull()

    // `../` out of the file's own folder (same origin, so the CSP lets the browser try it) is refused by the scheme.
    expect(await imageTo('../secret.txt')).toBe('blocked')
    expect(await imageTo('../../secret.txt')).toBe('blocked')

    // window.open is refused outright.
    expect(await inHtmlPreview(glade, "window.open('https://example.com') === null")).toBe(true)
    expect(await htmlPreviewPages(glade)).toBe(1)

    // A script navigation doesn't replace the preview; it's handed to the browser instead.
    const before = await htmlPreviewView(glade)
    await inHtmlPreview(glade, "location.href = 'https://example.com/path'")
    await expect.poll(async () => (await desktop(glade)).opened).toContain('https://example.com/path')
    expect(await htmlPreviewView(glade)).toMatchObject({ url: before?.url })
    expect(await htmlPreviewPages(glade)).toBe(1)

    // Clicking a link does the same: the browser gets it, stubbed in e2e mode, and nothing else.
    await inHtmlPreview(glade, "document.getElementById('link').click()")
    await expect.poll(async () => (await desktop(glade)).opened).toContain('https://example.com/')
    expect(await htmlPreviewView(glade)).toMatchObject({ url: before?.url })
    expect(await htmlPreviewPages(glade)).toBe(1)

    // The preview's own quiet notice says something was blocked.
    await expect(files.previewBlocked).toBeVisible()
  } finally {
    counting.server.close()
  }
})
