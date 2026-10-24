// The Files viewer's live preview (#764), end to end: a tiny local dev server shows live, locked to loopback, with a
// quiet notice for anything it reaches outside that, and a reload that picks up a changed response.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { desktop, expect, test, type Glade } from './fixtures'
import { expectLivePreviewOverSlot, inLivePreview, livePreviewPages, livePreviewView } from './live-preview'
import { filesTab, firstRun, taskList } from './selectors'

/** A tiny local dev server: serves `label` as its page's heading, mutable so a reload can pick up a change. */
function devServer(initialLabel: string): Promise<{ server: Server; url: string; setLabel: (label: string) => void }> {
  let label = initialLabel
  const server = createServer((request, response) => {
    if (request.url === '/reach-out.html') {
      response.writeHead(200, { 'Content-Type': 'text/html' })
      response.end('<!doctype html><html><body><h1 id="label">reach-out</h1></body></html>')
      return
    }
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end(`<!doctype html><html><body><h1 id="label">${label}</h1></body></html>`)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      resolve({ server, url: `http://127.0.0.1:${String(port)}/`, setLabel: (next) => (label = next) })
    })
  })
}

/** Opens the workspace and a new task, with nothing sent to the agent: this spec never needs one. */
async function openTask(window: Glade['window']): Promise<void> {
  await firstRun(window).openFolder.click()
  await taskList(window).newTask.click()
}

test('live preview: a local dev server shows live, locked to loopback, with its tab badged Live', async ({
  launch,
  tempFolder,
}) => {
  const dev = await devServer('hello from the dev server')
  try {
    const glade = await launch({ chosenFolder: tempFolder() })
    const { window } = glade
    await openTask(window)
    await window.keyboard.press('Meta+Alt+Digit3')
    const files = filesTab(window)

    await files.openUrl.click()
    await files.urlField.fill(dev.url)
    await files.urlSubmit.click()

    const host = new URL(dev.url).host
    await expect(files.liveTab(host)).toHaveAttribute('aria-pressed', 'true')
    await expectLivePreviewOverSlot(glade, dev.url)
    expect(await livePreviewView(glade, dev.url)).toMatchObject({ url: dev.url, sandboxed: true })
    expect(await inLivePreview(glade, dev.url, 'document.getElementById("label").textContent')).toBe(
      'hello from the dev server',
    )
    await expect(files.connected).toBeVisible()

    // A non-loopback request from the page is cancelled before it ever leaves, and the quiet notice names the host.
    expect(
      await inLivePreview(
        glade,
        dev.url,
        `fetch('https://example.com/').then(() => 'ok', (e) => 'blocked: ' + e.name)`,
      ),
    ).toMatch(/^blocked/)
    await expect(files.liveBlocked).toHaveText('Some content was blocked: example.com isn’t localhost.')

    // Reload picks up a changed response: the server's served fresh, not from a cache of the first load.
    dev.setLabel('hello again, after a change')
    await files.reload.click()
    await expect
      .poll(() => inLivePreview(glade, dev.url, 'document.getElementById("label").textContent'))
      .toBe('hello again, after a change')
    // The reload cleared the earlier block until it recurs.
    await expect(files.liveBlocked).toBeHidden()

    // Opening it in the browser hands the exact URL to the OS, stubbed in e2e mode.
    await files.openInBrowser.click()
    await expect.poll(async () => (await desktop(glade)).opened).toContain(dev.url)

    expect(await livePreviewPages(glade, dev.url)).toBe(1)
  } finally {
    dev.server.close()
  }
})

test('live preview: a non-loopback URL can’t be opened, and the Files header can collapse to fill the tab', async ({
  launch,
  tempFolder,
}) => {
  const dev = await devServer('a game, hot-reloading')
  try {
    const glade = await launch({ chosenFolder: tempFolder() })
    const { window } = glade
    await openTask(window)
    await window.keyboard.press('Meta+Alt+Digit3')
    const files = filesTab(window)

    // A non-loopback URL refuses to open at all: no tab, nothing shown.
    await files.openUrl.click()
    await files.urlField.fill('https://example.com/')
    await files.urlSubmit.click()
    await expect(files.openFiles.getByRole('button')).toHaveCount(0)
    await expect(files.urlField).toBeVisible()
    await files.urlField.fill('')

    // The real dev server opens fine.
    await files.urlField.fill(dev.url)
    await files.urlSubmit.click()
    const host = new URL(dev.url).host
    await expectLivePreviewOverSlot(glade, dev.url)

    // Collapsing the header hides the open-files row and the path row; the viewer fills the tab under the panel's
    // own top bar, and the view keeps its state (still over its slot, which has grown to fill the space).
    await files.collapseHeader.click()
    await expect(files.openFiles).toBeHidden()
    await expect(files.connected).toBeHidden()
    await expectLivePreviewOverSlot(glade, dev.url)

    // The panel's top bar brings it back; it works the same for any file, not only a live one.
    await files.showHeader.click()
    await expect(files.openFiles).toBeVisible()
    await expect(files.liveTab(host)).toBeVisible()
  } finally {
    dev.server.close()
  }
})
