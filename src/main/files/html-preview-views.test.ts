import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLog } from '../logging/memory-sink'
import { checkSecurity } from '../security'
import { viewRadius } from '../native-view-radius'

type Handler = (...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  /** A fake Electron session: what the preview's session is set up with, so a test can call it. */
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

  const sessions: FakeSession[] = []
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
    windowOpenHandler: ((details: { url: string }) => { action: string }) | undefined
    destroyed = false
    readonly webContents = {
      setWindowOpenHandler: vi.fn((handler: (details: { url: string }) => { action: string }) => {
        this.windowOpenHandler = handler
      }),
      on: vi.fn((event: string, handler: Handler) => {
        this.listeners.set(event, handler)
      }),
      loadURL: vi.fn(() => load.next()),
      reload: vi.fn(),
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
      fromPartition: vi.fn(() => {
        const made = new FakeSession()
        sessions.push(made)
        return made
      }),
    },
  }
})

vi.mock('electron', () => ({ session: electron.session, WebContentsView: electron.FakeView }))

const { createElectronHtmlPreviewView, htmlPreviewWebPreferences, HTML_PREVIEW_RADIUS } =
  await import('./html-preview-views')
const { HTML_PREVIEW_CSP } = await import('./html-preview-protocol')

/** A fake BrowserWindow: its content view, which the preview's view goes in, and its page's zoom. */
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

beforeEach(() => {
  electron.sessions.length = 0
  electron.views.length = 0
  electron.load.next = () => Promise.resolve()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Makes the preview's view in `window`, its blocks and its going recorded. */
function make(window = fakeWindow(), devTools = false) {
  const log = createMemoryLog()
  const onBlocked = vi.fn()
  const onGone = vi.fn()
  const openExternal = vi.fn(() => Promise.resolve())
  const create = createElectronHtmlPreviewView({
    window: () => window as unknown as Electron.BrowserWindow,
    openExternal,
    devTools,
    log: log.logger,
  })
  const view = create({ folder: '/workspace/reports', fileName: 'index.html', onBlocked, onGone })
  const fake = electron.views.at(-1)
  const ses = electron.sessions.at(-1)
  if (view === null || fake === undefined || ses === undefined) throw new Error('no view')
  return { view, fake, ses, window, log, onBlocked, onGone, openExternal, create }
}

describe('htmlPreviewWebPreferences', () => {
  it('passes the security check the window does', () => {
    expect(checkSecurity(htmlPreviewWebPreferences('glade-html-preview-1', false))).toEqual({ ok: true })
  })

  it('sandboxes the page with no preload at all, its own partition, and no webviews or dialogs', () => {
    expect(htmlPreviewWebPreferences('glade-html-preview-1', false)).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      disableDialogs: true,
      partition: 'glade-html-preview-1',
      devTools: false,
    })
    expect(htmlPreviewWebPreferences('glade-html-preview-1', false)).not.toHaveProperty('preload')
  })

  it('opens DevTools only when asked, which a packaged app never does', () => {
    expect(htmlPreviewWebPreferences('glade-html-preview-1', true).devTools).toBe(true)
  })

  it('draws offscreen only for a capture, and is as secure either way', () => {
    expect(htmlPreviewWebPreferences('glade-html-preview-1', false)).not.toHaveProperty('offscreen')
    expect(htmlPreviewWebPreferences('glade-html-preview-1', false, true)).toMatchObject({
      offscreen: true,
      sandbox: true,
    })
    expect(checkSecurity(htmlPreviewWebPreferences('glade-html-preview-1', false, true))).toEqual({ ok: true })
  })
})

describe('createElectronHtmlPreviewView', () => {
  it('answers null with no window', () => {
    const create = createElectronHtmlPreviewView({ window: () => undefined, openExternal: vi.fn(), devTools: false })
    expect(create({ folder: '/x', fileName: 'index.html', onBlocked: vi.fn(), onGone: vi.fn() })).toBeNull()
  })

  it("don't make a view, and are logged, when the webPreferences fail the security check", async () => {
    vi.resetModules()
    vi.doMock('../security', () => ({
      checkSecurity: () => ({ ok: false, violations: [{ setting: 'sandbox', required: true, actual: false }] }),
      describeViolations: () => 'sandbox must be true (was false)',
    }))
    const fresh = await import('./html-preview-views')
    const log = createMemoryLog()
    const window = fakeWindow()
    const create = fresh.createElectronHtmlPreviewView({
      window: () => window as unknown as Electron.BrowserWindow,
      openExternal: vi.fn(),
      devTools: false,
      log: log.logger,
    })

    expect(create({ folder: '/x', fileName: 'index.html', onBlocked: vi.fn(), onGone: vi.fn() })).toBeNull()
    expect(window.contentView.addChildView).not.toHaveBeenCalled()
    expect(log.records).toContainEqual(expect.objectContaining({ message: 'html preview refused: insecure settings' }))
    vi.doUnmock('../security')
  })

  it('makes a sandboxed view, tagged with the preview’s own (square) radius, and loads the file at the scheme’s root', () => {
    const { view, fake, window } = make()

    expect(window.contentView.addChildView).toHaveBeenCalledWith(fake)
    expect(fake.webContents.loadURL).toHaveBeenCalledWith('glade-html-preview://preview/index.html')
    expect(fake.setBorderRadius).toHaveBeenCalledWith(HTML_PREVIEW_RADIUS)
    expect(viewRadius(fake as unknown as Electron.WebContentsView, 99)).toBe(HTML_PREVIEW_RADIUS)
    expect(fake.setVisible).toHaveBeenCalledWith(false)

    view.place({ x: 1, y: 2, width: 300, height: 200 })
    expect(fake.setBounds).toHaveBeenCalledWith({ x: 1, y: 2, width: 300, height: 200 })
    expect(fake.setVisible).toHaveBeenLastCalledWith(true)

    view.hide()
    expect(fake.setVisible).toHaveBeenLastCalledWith(false)

    view.reload()
    expect(fake.webContents.reload).toHaveBeenCalledOnce()

    view.destroy()
    expect(window.contentView.removeChildView).toHaveBeenCalledWith(fake)
    expect(fake.webContents.close).toHaveBeenCalledOnce()
    // Destroying again, or placing, hiding or reloading after, does nothing more.
    view.destroy()
    view.place({ x: 0, y: 0, width: 1, height: 1 })
    view.hide()
    view.reload()
    expect(window.contentView.removeChildView).toHaveBeenCalledOnce()
    expect(fake.setBounds).toHaveBeenCalledOnce()
    expect(fake.webContents.reload).toHaveBeenCalledOnce()
  })

  it('serves only the file’s own folder, with the preview’s CSP, cancelling and reporting every other request', () => {
    const { ses, onBlocked } = make()

    expect(ses.protocol.handle).toHaveBeenCalledWith('glade-html-preview', expect.any(Function))

    const cancelled: boolean[] = []
    const callback = vi.fn((result: { cancel: boolean }) => cancelled.push(result.cancel))
    ses.beforeRequest?.({ url: 'glade-html-preview://preview/index.html' }, callback)
    ses.beforeRequest?.({ url: 'https://example.com/' }, callback)
    expect(cancelled).toEqual([false, true])
    expect(onBlocked).toHaveBeenCalledOnce()

    const headersCallback = vi.fn()
    ses.headersReceived?.({ responseHeaders: { 'X-Foo': ['bar'] } }, headersCallback)
    expect(headersCallback).toHaveBeenCalledWith({
      responseHeaders: { 'X-Foo': ['bar'], 'Content-Security-Policy': [HTML_PREVIEW_CSP] },
    })

    const permissionCallback = vi.fn()
    ses.permissionRequest?.(undefined, 'camera', permissionCallback)
    expect(permissionCallback).toHaveBeenCalledWith(false)
    expect(ses.permissionCheck?.()).toBe(false)
    expect(ses.devicePermission?.()).toBe(false)
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(false)

    const download = { preventDefault: vi.fn() }
    ses.listeners.get('will-download')?.(download)
    expect(download.preventDefault).toHaveBeenCalledOnce()
  })

  it('refuses windows and navigation, handing an http(s) or mailto link to the browser instead', async () => {
    const { fake, openExternal } = make()

    expect(fake.windowOpenHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')

    const navigate = { preventDefault: vi.fn(), url: 'mailto:a@b.com' }
    fake.listeners.get('will-navigate')?.(navigate)
    expect(navigate.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(openExternal).toHaveBeenCalledWith('mailto:a@b.com')

    const redirect = { preventDefault: vi.fn() }
    fake.listeners.get('will-redirect')?.(redirect)
    expect(redirect.preventDefault).toHaveBeenCalledOnce()

    const webview = { preventDefault: vi.fn() }
    fake.listeners.get('will-attach-webview')?.(webview)
    expect(webview.preventDefault).toHaveBeenCalledOnce()

    // A scheme that isn't openable (never handed to the browser) is refused and logged, not thrown.
    const openScript = { preventDefault: vi.fn(), url: 'javascript:alert(1)' }
    fake.listeners.get('will-navigate')?.(openScript)
    await Promise.resolve()
    expect(openExternal).not.toHaveBeenCalledWith('javascript:alert(1)')
  })

  it('reports a CSP violation (a fetch or an image the policy itself refused) as blocked, and ignores other console messages', () => {
    const { fake, onBlocked } = make()

    fake.listeners.get('console-message')?.(
      {},
      1,
      "Refused to connect to 'https://example.com/' because it violates the following Content Security Policy directive",
      1,
      'index.html',
    )
    expect(onBlocked).toHaveBeenCalledOnce()

    fake.listeners.get('console-message')?.({}, 1, 'just a log line', 1, 'index.html')
    expect(onBlocked).toHaveBeenCalledOnce()
  })

  it('reports a failed load and destroys itself when its page is gone', () => {
    const { fake, onGone, log } = make()

    fake.listeners.get('did-fail-load')?.({}, -6, 'ERR_FAILED')
    expect(log.records.some(({ message }) => message === "html preview's page failed to load")).toBe(true)

    fake.listeners.get('render-process-gone')?.({}, { reason: 'crashed' })
    expect(onGone).toHaveBeenCalledOnce()
  })

  it('destroys itself, telling the host, when its window closes', () => {
    const { window, onGone, fake } = make()

    window.listeners.get('closed')?.()
    expect(onGone).toHaveBeenCalledOnce()
    expect(fake.webContents.close).toHaveBeenCalledOnce()
  })

  it('logs, without throwing, when the page fails to start loading', async () => {
    electron.load.next = () => Promise.reject(new Error('boom'))
    const { log } = make()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log.records.some(({ message }) => message === "html preview's page didn't load")).toBe(true)
  })
})
