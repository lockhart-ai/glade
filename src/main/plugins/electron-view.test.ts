import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_MESSAGE_CHANNEL, PLUGIN_POST_CHANNEL } from '../../shared/plugin-api'
import { PluginStatus, type ValidPlugin } from '../../shared/plugins'
import { createMemoryLog } from '../logging/memory-sink'
import { checkSecurity } from '../security'
import { tempPluginsParent, writePlugin } from './test-plugins'

type Handler = (...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  /** A fake Electron session: what the plugin's session is set up with, so a test can call it. */
  class FakeSession {
    readonly protocolHandlers = new Map<string, (request: Request) => Promise<Response>>()
    beforeRequest: Handler | undefined
    headersReceived: Handler | undefined
    permissionRequest: Handler | undefined
    permissionCheck: Handler | undefined
    devicePermission: Handler | undefined
    readonly listeners = new Map<string, Handler>()
    readonly setSpellCheckerEnabled = vi.fn()
    readonly protocol = {
      handle: vi.fn((scheme: string, handler: (request: Request) => Promise<Response>) => {
        this.protocolHandlers.set(scheme, handler)
      }),
    }
    readonly webRequest = {
      onBeforeRequest: vi.fn((handler: Handler) => {
        this.beforeRequest = handler
      }),
      onHeadersReceived: vi.fn((handler: Handler) => {
        this.headersReceived = handler
      }),
    }
    readonly setPermissionRequestHandler = vi.fn((handler: Handler) => {
      this.permissionRequest = handler
    })
    readonly setPermissionCheckHandler = vi.fn((handler: Handler) => {
      this.permissionCheck = handler
    })
    readonly setDevicePermissionHandler = vi.fn((handler: Handler) => {
      this.devicePermission = handler
    })
    readonly on = vi.fn((event: string, handler: Handler) => {
      this.listeners.set(event, handler)
    })
  }

  const sessions = new Map<string, FakeSession>()
  const views: FakeView[] = []
  /** How the next page load ends: it loads, unless a test says otherwise. */
  const load = { next: (): Promise<void> => Promise.resolve() }

  class FakeView {
    readonly options: { webPreferences: Record<string, unknown> }
    readonly setBackgroundColor = vi.fn()
    readonly setBorderRadius = vi.fn()
    readonly setVisible = vi.fn()
    readonly setBounds = vi.fn()
    readonly listeners = new Map<string, Handler>()
    readonly ipcListeners = new Map<string, Handler>()
    windowOpenHandler: Handler | undefined
    destroyed = false
    readonly webContents = {
      setWindowOpenHandler: vi.fn((handler: Handler) => {
        this.windowOpenHandler = handler
      }),
      on: vi.fn((event: string, handler: Handler) => {
        this.listeners.set(event, handler)
      }),
      ipc: {
        on: vi.fn((channel: string, handler: Handler) => {
          this.ipcListeners.set(channel, handler)
        }),
      },
      loadURL: vi.fn(() => load.next()),
      send: vi.fn(),
      isDestroyed: () => this.destroyed,
      close: vi.fn(() => {
        this.destroyed = true
      }),
    }

    constructor(options: { webPreferences: Record<string, unknown> }) {
      this.options = options
      views.push(this)
    }
  }

  return {
    sessions,
    views,
    load,
    FakeView,
    session: {
      fromPartition: vi.fn((partition: string) => {
        const existing = sessions.get(partition)
        if (existing !== undefined) return existing
        const made = new FakeSession()
        sessions.set(partition, made)
        return made
      }),
    },
  }
})

vi.mock('electron', () => ({ session: electron.session, WebContentsView: electron.FakeView }))

const {
  createElectronPluginViews,
  pluginEntryUrl,
  pluginPartition,
  pluginWebPreferences,
  registerPluginScheme,
  PLUGIN_VIEW_RADIUS,
} = await import('./electron-view')
const { PLUGIN_CSP } = await import('./protocol')

/** A fake BrowserWindow: its content view, which the plugin's view goes in, and its page's zoom. */
function fakeWindow(zoom = 1) {
  const listeners = new Map<string, Handler>()
  const window = {
    destroyed: false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    webContents: { getZoomFactor: () => zoom },
    once: vi.fn((event: string, handler: Handler) => listeners.set(event, handler)),
    removeListener: vi.fn((event: string) => listeners.delete(event)),
    isDestroyed: () => window.destroyed,
    listeners,
  }
  return window
}

function nekomata(): ValidPlugin {
  return {
    status: PluginStatus.Valid,
    folder: 'nekomata',
    manifest: { id: 'nekomata', name: 'Nekomata', version: '1.0.0', entry: 'app/index.html', icon: null },
    iconUrl: null,
    enabled: true,
  }
}

let parent: string
let folder: string

beforeEach(() => {
  parent = tempPluginsParent()
  folder = writePlugin(join(parent, 'plugins'), 'nekomata', null, { 'app/index.html': '<!doctype html>' })
  writeFileSync(join(parent, 'glade.db'), 'SECRET')
  electron.sessions.clear()
  electron.views.length = 0
  electron.load.next = () => Promise.resolve()
})

afterEach(() => {
  rmSync(parent, { recursive: true, force: true })
})

/** Makes the plugin's view in `window`, with its messages and its going recorded. */
function make(window = fakeWindow(), devTools = false) {
  const log = createMemoryLog()
  const onMessage = vi.fn()
  const onGone = vi.fn()
  const create = createElectronPluginViews({
    window: () => window as unknown as Electron.BrowserWindow,
    devTools,
    log: log.logger,
  })
  const view = create({ plugin: nekomata(), folder, onMessage, onGone })
  const fake = electron.views.at(-1)
  const ses = electron.sessions.get(pluginPartition('nekomata'))
  if (view === null || fake === undefined || ses === undefined) throw new Error('no view')
  return { view, fake, ses, window, log, onMessage, onGone, create }
}

describe('registerPluginScheme', () => {
  it('registers the scheme as standard and secure, with fetch', () => {
    const protocol = { registerSchemesAsPrivileged: vi.fn() }
    registerPluginScheme(protocol)

    expect(protocol.registerSchemesAsPrivileged).toHaveBeenCalledWith([
      { scheme: 'glade-plugin', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    ])
  })
})

describe('pluginWebPreferences', () => {
  it('passes the security check the window does', () => {
    expect(checkSecurity(pluginWebPreferences('nekomata', false))).toEqual({ ok: true })
  })

  it('sandboxes the page, with only the relaying preload, its own partition, and no webviews or dialogs', () => {
    expect(pluginWebPreferences('nekomata', false)).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      disableDialogs: true,
      partition: 'glade-plugin-nekomata',
      devTools: false,
      preload: expect.stringMatching(/preload\/plugin\.js$/) as unknown,
    })
  })

  it('keeps its storage in memory, apart from every other plugin and Glade', () => {
    expect(pluginPartition('nekomata')).not.toMatch(/^persist:/)
    expect(pluginPartition('nekomata')).not.toBe(pluginPartition('pomodoro'))
  })

  it('opens DevTools only when asked, which a packaged app never does', () => {
    expect(pluginWebPreferences('nekomata', true).devTools).toBe(true)
  })

  it('draws offscreen only for a capture, and is as secure either way', () => {
    expect(pluginWebPreferences('nekomata', false)).not.toHaveProperty('offscreen')
    expect(pluginWebPreferences('nekomata', false, true)).toMatchObject({ offscreen: true, sandbox: true })
    expect(checkSecurity(pluginWebPreferences('nekomata', false, true))).toEqual({ ok: true })
  })
})

describe('pluginEntryUrl', () => {
  it("is the entry under the plugin's scheme, each part encoded", () => {
    expect(pluginEntryUrl('nekomata', 'index.html')).toBe('glade-plugin://nekomata/index.html')
    expect(pluginEntryUrl('nekomata', 'app/my page#1.html')).toBe('glade-plugin://nekomata/app/my%20page%231.html')
  })
})

describe('createElectronPluginViews', () => {
  it('makes a sandboxed view in the window, hidden until placed, and loads the entry', () => {
    const { fake, window } = make()

    expect(checkSecurity(fake.options.webPreferences)).toEqual({ ok: true })
    expect(fake.options.webPreferences).toEqual(pluginWebPreferences('nekomata', false))
    expect(window.contentView.addChildView).toHaveBeenCalledWith(fake)
    expect(fake.setVisible).toHaveBeenLastCalledWith(false)
    expect(fake.setBorderRadius).toHaveBeenCalledWith(PLUGIN_VIEW_RADIUS)
    expect(fake.webContents.loadURL).toHaveBeenCalledWith('glade-plugin://nekomata/app/index.html')
  })

  it('makes an offscreen view when asked, for a capture', () => {
    const window = fakeWindow()
    const create = createElectronPluginViews({
      window: () => window as unknown as Electron.BrowserWindow,
      devTools: false,
      offscreen: true,
    })

    create({ plugin: nekomata(), folder, onMessage: vi.fn(), onGone: vi.fn() })

    expect(electron.views.at(-1)?.options.webPreferences).toMatchObject({ offscreen: true })
  })

  it('makes nothing while there is no window', () => {
    const create = createElectronPluginViews({ window: () => undefined, devTools: false })

    expect(create({ plugin: nekomata(), folder, onMessage: vi.fn(), onGone: vi.fn() })).toBeNull()
    expect(electron.views).toEqual([])
  })

  it('places the view in window points at the page zoom, and shows and hides it', () => {
    const { view, fake } = make(fakeWindow(1.25))

    view.place({ x: 600.4, y: 520, width: 680, height: 255.5 })
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 751, y: 650, width: 850, height: 319 })
    expect(fake.setVisible).toHaveBeenLastCalledWith(true)

    view.hide()
    expect(fake.setVisible).toHaveBeenLastCalledWith(false)
  })

  it("sends Glade's messages to the page on the plugin channel", () => {
    const { view, fake } = make()
    const message = {
      source: 'glade' as const,
      apiVersion: 1 as const,
      seq: 1,
      event: { type: 'hello' as never, app: { name: 'Glade' as const, version: '1' } },
    }

    view.send(message)

    expect(fake.webContents.send).toHaveBeenCalledWith(PLUGIN_MESSAGE_CHANNEL, message)
  })

  it("passes on what the page posts, unchecked, from its own webContents' channel only", () => {
    const { fake, onMessage } = make()

    fake.ipcListeners.get(PLUGIN_POST_CHANNEL)?.({}, { type: 'ready' })

    expect(onMessage).toHaveBeenCalledWith({ type: 'ready' })
    expect([...fake.ipcListeners.keys()]).toEqual([PLUGIN_POST_CHANNEL])
  })

  it('refuses every new window', () => {
    const { fake, log } = make()

    expect(fake.windowOpenHandler?.({ url: 'https://example.com' })).toEqual({ action: 'deny' })
    expect(log.records).toContainEqual(expect.objectContaining({ message: 'plugin window refused' }))
  })

  it.each(['will-navigate', 'will-redirect'])('refuses to %s away', (event) => {
    const { fake } = make()
    const navigation = { url: 'https://example.com', preventDefault: vi.fn() }

    fake.listeners.get(event)?.(navigation)

    expect(navigation.preventDefault).toHaveBeenCalled()
  })

  it('refuses a webview', () => {
    const { fake } = make()
    const attach = { preventDefault: vi.fn() }

    fake.listeners.get('will-attach-webview')?.(attach)

    expect(attach.preventDefault).toHaveBeenCalled()
  })

  it('logs the page failing to load, and its load rejecting', async () => {
    electron.load.next = () => Promise.reject(new Error('ERR_FILE_NOT_FOUND'))
    const { fake, log } = make()

    fake.listeners.get('did-fail-load')?.({}, -6, 'ERR_FILE_NOT_FOUND')

    expect(log.records).toContainEqual(expect.objectContaining({ message: "plugin's page failed to load" }))
    await vi.waitFor(() => {
      expect(log.records).toContainEqual(expect.objectContaining({ message: "plugin's page didn't load" }))
    })
  })

  it('says the page is gone when its process dies', () => {
    const { fake, onGone, log } = make()

    fake.listeners.get('render-process-gone')?.({}, { reason: 'crashed' })

    expect(onGone).toHaveBeenCalledOnce()
    expect(log.records).toContainEqual(expect.objectContaining({ message: "plugin's process is gone" }))
  })

  it('destroys the view once, taking it out of the window and ending its page', () => {
    const { view, fake, window } = make()

    view.destroy()
    view.destroy()
    view.place({ x: 0, y: 0, width: 10, height: 10 })
    view.hide()
    view.send({
      source: 'glade',
      apiVersion: 1,
      seq: 1,
      event: { type: 'hello' as never, app: { name: 'Glade', version: '1' } },
    })

    expect(window.contentView.removeChildView).toHaveBeenCalledOnce()
    expect(fake.webContents.close).toHaveBeenCalledOnce()
    expect(fake.setBounds).not.toHaveBeenCalled()
    expect(fake.webContents.send).not.toHaveBeenCalled()
    expect(window.listeners.has('closed')).toBe(false)
  })

  it('destroys the view with its window, and says so', () => {
    const { fake, window, onGone } = make()
    window.destroyed = true

    window.listeners.get('closed')?.()

    expect(window.contentView.removeChildView).not.toHaveBeenCalled()
    expect(fake.webContents.close).toHaveBeenCalledOnce()
    expect(onGone).toHaveBeenCalledOnce()
  })

  it("doesn't close a page that's already gone", () => {
    const { view, fake } = make()
    fake.destroyed = true

    view.destroy()

    expect(fake.webContents.close).not.toHaveBeenCalled()
  })

  it("sets a plugin's session up once, however often its view is made", () => {
    const { create, ses } = make()
    create({ plugin: nekomata(), folder, onMessage: vi.fn(), onGone: vi.fn() })

    expect(electron.views).toHaveLength(2)
    expect(ses.protocol.handle).toHaveBeenCalledOnce()
  })
})

describe("the plugin's session", () => {
  it("serves the plugin's files, and nothing outside its folder", async () => {
    const { ses } = make()
    const serve = ses.protocolHandlers.get('glade-plugin')

    const page = await serve?.(new Request('glade-plugin://nekomata/app/index.html'))
    expect(page?.status).toBe(200)
    expect(page?.headers.get('Content-Security-Policy')).toBe(PLUGIN_CSP)

    const escape = await serve?.(new Request('glade-plugin://nekomata/%2e%2e/%2e%2e/glade.db'))
    expect(escape?.status).toBe(404)
    expect(await escape?.text()).toBe('')
  })

  it('cancels every request but its own files and localhost, and logs the cancelled ones', () => {
    const { ses, log } = make()
    const decide = (url: string): unknown => {
      const callback = vi.fn()
      ses.beforeRequest?.({ url }, callback)
      return callback.mock.calls[0]?.[0]
    }

    expect(decide('glade-plugin://nekomata/app/index.html')).toEqual({ cancel: false })
    expect(decide('http://localhost:8000/data')).toEqual({ cancel: false })
    expect(decide('https://example.com/')).toEqual({ cancel: true })
    expect(decide('glade-plugin://other/index.html')).toEqual({ cancel: true })
    expect(decide('file:///etc/passwd')).toEqual({ cancel: true })
    expect(log.records.filter(({ message }) => message === 'plugin request blocked')).toHaveLength(3)
  })

  it('puts the CSP on every response, keeping its other headers', () => {
    const { ses } = make()
    const callback = vi.fn()

    ses.headersReceived?.({ responseHeaders: { 'Content-Type': ['text/html'] } }, callback)

    expect(callback).toHaveBeenCalledWith({
      responseHeaders: { 'Content-Type': ['text/html'], 'Content-Security-Policy': [PLUGIN_CSP] },
    })
  })

  it('refuses every permission, device and download, and never fetches spellcheck dictionaries', () => {
    const { ses, log } = make()
    const callback = vi.fn()

    ses.permissionRequest?.({}, 'media', callback)
    ses.permissionRequest?.({}, 'notifications', callback)

    expect(callback.mock.calls).toEqual([[false], [false]])
    expect(ses.permissionCheck?.({}, 'clipboard-read')).toBe(false)
    expect(ses.devicePermission?.({ deviceType: 'usb' })).toBe(false)
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    const download = { preventDefault: vi.fn() }
    ses.listeners.get('will-download')?.(download)
    expect(download.preventDefault).toHaveBeenCalled()
    expect(log.records.filter(({ message }) => message === 'plugin permission refused')).toHaveLength(2)
  })
})

describe('insecure settings', () => {
  it("don't make a view, and are logged", async () => {
    vi.resetModules()
    vi.doMock('../security', () => ({
      checkSecurity: () => ({ ok: false, violations: [{ setting: 'sandbox', required: true, actual: false }] }),
      describeViolations: () => 'sandbox must be true (was false)',
    }))
    const fresh = await import('./electron-view')
    const log = createMemoryLog()
    const window = fakeWindow()
    const create = fresh.createElectronPluginViews({
      window: () => window as unknown as Electron.BrowserWindow,
      devTools: false,
      log: log.logger,
    })

    expect(create({ plugin: nekomata(), folder, onMessage: vi.fn(), onGone: vi.fn() })).toBeNull()
    expect(window.contentView.addChildView).not.toHaveBeenCalled()
    expect(log.records).toContainEqual(expect.objectContaining({ message: 'plugin view refused: insecure settings' }))
    vi.doUnmock('../security')
  })
})
