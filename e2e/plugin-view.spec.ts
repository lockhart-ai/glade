import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import { FIXTURE_PLUGIN, inPlugin, installFixture } from './fixture-plugin'
import { expect, pluginsFolder, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { panelToggles, regions, settings } from './selectors'
import { boxOf, resize } from './window-layout'

/** The plugin's card beside the terminal, and its parts. */
function pluginCard(glade: Glade) {
  const card = glade.window.getByRole('region', { name: 'Fixture' })
  return { card, status: card.getByTestId('plugin-status'), slot: card.getByTestId('plugin-view-slot') }
}

/** The plugin's view in the window, as main has it; null when there's none. */
interface ViewState {
  readonly bounds: { x: number; y: number; width: number; height: number }
  readonly visible: boolean
  readonly url: string
  /** Whether its page's process runs in the OS sandbox, as Electron's process metrics have it. */
  readonly sandboxed: boolean | undefined
}

async function pluginView({ app }: Glade): Promise<ViewState | null> {
  return app.evaluate(({ app: electronApp, BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
      (child): child is Electron.WebContentsView => child instanceof WebContentsView,
    )
    if (view === undefined) return null
    const pid = view.webContents.getOSProcessId()
    return {
      bounds: view.getBounds(),
      visible: view.getVisible(),
      url: view.webContents.getURL(),
      sandboxed: electronApp.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed,
    }
  })
}

/** How many plugin pages are running, in any window or none. */
async function pluginPages({ app }: Glade): Promise<number> {
  return app.evaluate(
    ({ webContents }) =>
      webContents.getAllWebContents().filter((page) => page.getURL().startsWith('glade-plugin:')).length,
  )
}

/** The slot's box, rounded to whole points, as main places the view. */
async function slotBounds(glade: Glade): Promise<ViewState['bounds']> {
  const box = await boxOf(pluginCard(glade).slot)
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

/** Waits until the view is over its slot and showing. */
async function expectViewOverSlot(glade: Glade): Promise<void> {
  await expect
    .poll(async () => {
      const view = await pluginView(glade)
      return view === null ? null : { bounds: view.bounds, visible: view.visible }
    })
    .toEqual({ bounds: await slotBounds(glade), visible: true })
}

/** The log's lines saying `msg`. */
function logged({ logFile }: Glade, msg: string): Record<string, unknown>[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === msg)
}

/** Opens Settings › Plugins, and waits until it has read the plugins folder. */
async function openPlugins(glade: Glade): Promise<ReturnType<typeof settings>> {
  const modal = settings(glade.window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('Plugins').click()
  await expect(modal.plugins).toHaveAttribute('aria-busy', 'false')
  return modal
}

/** A local HTTP server that counts its requests, answering each with `ok` to any origin. */
async function countingServer(host: string): Promise<{ server: Server; url: string; hits: () => number }> {
  let hits = 0
  const server = createServer((request, response) => {
    hits += 1
    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
      'Content-Type': 'text/plain',
    })
    response.end(request.method === 'OPTIONS' ? '' : 'ok')
  })
  await new Promise<void>((done) => server.listen(0, host, done))
  const { port } = server.address() as AddressInfo
  const shown = host.includes(':') ? `[${host}]` : host
  return { server, url: `http://${shown}:${String(port)}/`, hits: () => hits }
}

test('an enabled plugin shows beside the terminal in its own sandboxed view, says hello, and goes when turned off', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch()
  const { card, status } = pluginCard(glade)
  const { terminal } = regions(glade.window)

  // Its card: icon, name, the PLUGIN badge, and the status it sets once Glade has said hello.
  await expect(card).toBeVisible()
  await expect(card.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  await expect(card).toContainText('FixturePlugin')
  await expect(status).toHaveText(/^Glade \S+ said hello$/)
  expect(await inPlugin(glade, 'window.received.map(({ seq, event }) => [seq, event.type])')).toEqual([
    [1, 'hello'],
    [2, 'snapshot'],
  ])
  await expect(glade.window.getByTestId('plugin-card')).toHaveCount(1)

  // Its view: over the card's body, loaded from its own scheme, in a sandboxed process of its own.
  await expectViewOverSlot(glade)
  expect(await pluginView(glade)).toMatchObject({ url: 'glade-plugin://fixture-plugin/index.html', sandboxed: true })
  expect(
    await glade.app.evaluate(({ BrowserWindow, webContents }) => {
      const window = BrowserWindow.getAllWindows()[0]?.webContents.getOSProcessId()
      const plugin = webContents.getAllWebContents().find((page) => page.getURL().startsWith('glade-plugin:'))
      return plugin !== undefined && plugin.getOSProcessId() !== window
    }),
  ).toBe(true)
  const terminalBeside = await boxOf(terminal)
  expect(terminalBeside.x + terminalBeside.width).toBeLessThan((await boxOf(card)).x)

  // Ready again starts over with a new hello and snapshot.
  await inPlugin(glade, "window.glade.post({ type: 'ready' })")
  await expect.poll(() => inPlugin(glade, 'window.received.length')).toBe(4)
  expect(await inPlugin(glade, 'window.received.slice(2).map(({ seq, event }) => [seq, event.type])')).toEqual([
    [1, 'hello'],
    [2, 'snapshot'],
  ])

  // Turned off, its card and view go, its page ends, and the terminal takes the whole bar.
  const modal = await openPlugins(glade)
  await modal.toggle('Fixture').click()
  await expect(modal.toggle('Fixture')).not.toBeChecked()
  await modal.close.click()
  await expect(card).toBeHidden()
  await expect.poll(() => pluginView(glade)).toBeNull()
  await expect.poll(() => pluginPages(glade)).toBe(0)
  expect((await boxOf(terminal)).width).toBeGreaterThan(terminalBeside.width + 600)

  // Turned on again, it's made afresh and says hello again.
  const again = await openPlugins(glade)
  await again.toggle('Fixture').click()
  await again.close.click()
  await expect(status).toHaveText(/said hello$/)
  await expectViewOverSlot(glade)
  expect(await pluginPages(glade)).toBe(1)
})

test("the plugin's view follows its slot as the window resizes and the bar collapses and opens", async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch()
  const { collapseBottomBar, showBottomBar } = panelToggles(glade.window)
  await expect(pluginCard(glade).status).toHaveText(/said hello$/)
  await expectViewOverSlot(glade)

  await resize(glade, 1500, 950)
  await expectViewOverSlot(glade)
  await resize(glade, 1100, 700)
  await expectViewOverSlot(glade)

  // Collapsed, the card shows its header only and the view hides, keeping its page; open, it's back over the slot.
  await collapseBottomBar.click()
  await expect(pluginCard(glade).slot).toBeHidden()
  await expect.poll(async () => (await pluginView(glade))?.visible).toBe(false)
  await expect(pluginCard(glade).card).toContainText('Fixture')
  await showBottomBar.click()
  await expectViewOverSlot(glade)
  expect(await inPlugin(glade, 'window.received.length')).toBe(2)
})

test('a hostile plugin page is contained: no network, no Node, no escape from its folder, no navigation', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  // What it must never read: a file beside the plugins folder in Glade's data folder, and another plugin's page.
  writeFileSync(join(userData, 'secret.txt'), 'SECRET')
  cpSync(FIXTURE_PLUGIN, join(pluginsFolder(userData), 'other-plugin'), { recursive: true })
  writeFileSync(
    join(pluginsFolder(userData), 'other-plugin', 'manifest.json'),
    JSON.stringify({ id: 'other-plugin', name: 'Other', version: '1.0.0', entry: 'index.html' }),
  )
  const local = await countingServer('127.0.0.1')
  const loopback6 = await countingServer('::1')
  try {
    const glade = await launch()
    const { status } = pluginCard(glade)
    await expect(status).toHaveText(/said hello$/)

    // No Node, and a bridge with post alone.
    expect(
      await inPlugin(glade, "[typeof require, typeof process, typeof module, Object.keys(window.glade).join(',')]"),
    ).toEqual(['undefined', 'undefined', 'undefined', 'post'])

    // No network but localhost.
    const fetched = (url: string): Promise<string> =>
      inPlugin(glade, `fetch(${JSON.stringify(url)}).then((r) => r.text(), (e) => 'blocked: ' + e.name)`)
    expect(await fetched('https://example.com/')).toMatch(/^blocked/)
    expect(await fetched('http://example.com/')).toMatch(/^blocked/)
    expect(await fetched(loopback6.url)).toMatch(/^blocked/)
    expect(await fetched(local.url)).toBe('ok')
    expect(local.hits()).toBeGreaterThan(0)
    expect(
      await inPlugin(
        glade,
        "new Promise((done) => { const s = new WebSocket('wss://example.com'); s.onerror = () => done('blocked'); s.onopen = () => done('open') })",
      ),
    ).toBe('blocked')

    // Nothing outside its own folder, however the path is spelt, and not another plugin's files.
    for (const path of [
      '/..%2F..%2Fsecret.txt',
      '/%2e%2e/%2e%2e/secret.txt',
      '/..%5C..%5Csecret.txt',
      '/../../secret.txt',
    ]) {
      expect(await fetched(path)).not.toContain('SECRET')
    }
    expect(await inPlugin(glade, "fetch('/..%2F..%2Fsecret.txt').then((r) => r.status)")).toBe(404)
    expect(await fetched('glade-plugin://other-plugin/index.html')).toMatch(/^blocked/)
    expect(await fetched('file:///etc/hosts')).toMatch(/^blocked/)

    // No new windows, no navigating away, no permissions.
    expect(await inPlugin(glade, "window.open('https://example.com') === null")).toBe(true)
    await inPlugin(glade, "location.href = 'https://example.com/'")
    await expect.poll(() => logged(glade, 'plugin navigation refused').length).toBeGreaterThan(0)
    expect(await inPlugin(glade, 'location.href')).toBe('glade-plugin://fixture-plugin/index.html')
    expect(await pluginPages(glade)).toBe(1)
    expect(await inPlugin(glade, 'Notification.requestPermission()')).toBe('denied')
    expect(await inPlugin(glade, "navigator.permissions.query({ name: 'camera' }).then(({ state }) => state)")).toBe(
      'denied',
    )

    // A malformed message, and one too big to send, are dropped; the next good one still lands.
    await inPlugin(
      glade,
      "window.glade.post({ type: 'status', text: 42 }); window.glade.post('status'); window.glade.post({ type: 'task.create' })",
    )
    await inPlugin(glade, "window.glade.post({ type: 'status', text: 'x'.repeat(20000000) })")
    await inPlugin(glade, "window.glade.post({ type: 'status', text: 'still here' })")
    await expect(status).toHaveText('still here')
    await expect.poll(() => logged(glade, 'plugin message dropped').length).toBe(3)

    // A long status is cut to 40 characters.
    await inPlugin(glade, "window.glade.post({ type: 'status', text: 'y'.repeat(100) })")
    await expect(status).toHaveText('y'.repeat(40))

    // A flood of messages is cut off at the rate limit: the page gets a handful of hellos, not a hundred thousand.
    await inPlugin(glade, "for (let i = 0; i < 100000; i += 1) window.glade.post({ type: 'ready' })")
    await expect.poll(() => logged(glade, 'plugin messages dropped: too many').length).toBeGreaterThan(0)
    const hellos = await inPlugin<number>(glade, "window.received.filter(({ event }) => event.type === 'hello').length")
    expect(hellos).toBeLessThan(200)
    // Glade carries on: once the flood stops, the plugin is heard again.
    await expect
      .poll(async () => {
        await inPlugin(glade, "window.glade.post({ type: 'status', text: 'after the flood' })")
        return status.textContent()
      })
      .toBe('after the flood')

    // The session cancels a request the page's CSP never sees: main loading another host in its view.
    await glade.app.evaluate(async ({ webContents }, url) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('glade-plugin:'))
      await page?.loadURL(url).catch(() => undefined)
    }, loopback6.url)
    await expect.poll(() => logged(glade, 'plugin request blocked').some(({ url }) => url === loopback6.url)).toBe(true)
    expect(loopback6.hits()).toBe(0)
  } finally {
    local.server.close()
    loopback6.server.close()
  }
})
