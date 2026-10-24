import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLog } from '../logging/memory-sink'
import { checkSecurity } from '../security'
import { viewRadius } from '../native-view-radius'

type Handler = (...args: unknown[]) => unknown

const electron = vi.hoisted(() => {
  /** A fake Electron session: what a live preview's session is set up with, so a test can call it. */
  class FakeSession {
    beforeRequest: Handler | undefined
    permissionRequest: Handler | undefined
    permissionCheck: Handler | undefined
    devicePermission: Handler | undefined
    readonly listeners = new Map<string, Handler>()
    readonly setSpellCheckerEnabled = vi.fn()
    readonly webRequest = {
      onBeforeRequest: vi.fn((handler: Handler) => {
        this.beforeRequest = handler
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
      focus: vi.fn(),
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

const { createElectronLivePreviewView, livePreviewWebPreferences, LIVE_PREVIEW_RADIUS } =
  await import('./live-preview-views')

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

/** Makes the preview's view in `window`, its blocks, connection and going recorded. */
function make(window = fakeWindow(), devTools = false, url = 'http://localhost:3000/') {
  const log = createMemoryLog()
  const onBlocked = vi.fn()
  const onConnection = vi.fn()
  const onGone = vi.fn()
  const openExternal = vi.fn(() => Promise.resolve())
  const create = createElectronLivePreviewView({
    window: () => window as unknown as Electron.BrowserWindow,
    openExternal,
    devTools,
    log: log.logger,
  })
  const view = create({ url, onBlocked, onConnection, onGone })
  const fake = electron.views.at(-1)
  const ses = electron.sessions.at(-1)
  if (view === null || fake === undefined || ses === undefined) throw new Error('no view')
  return { view, fake, ses, window, log, onBlocked, onConnection, onGone, openExternal, create }
}

describe('livePreviewWebPreferences', () => {
  it('passes the security check the window does', () => {
    expect(checkSecurity(livePreviewWebPreferences('glade-live-preview-1', false))).toEqual({ ok: true })
  })

  it('sandboxes the page with no preload at all, its own partition, and no webviews or dialogs', () => {
    expect(livePreviewWebPreferences('glade-live-preview-1', false)).toMatchObject({
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      disableDialogs: true,
      partition: 'glade-live-preview-1',
      devTools: false,
    })
    expect(livePreviewWebPreferences('glade-live-preview-1', false)).not.toHaveProperty('preload')
  })

  it('draws offscreen only for a capture, and is as secure either way', () => {
    expect(livePreviewWebPreferences('glade-live-preview-1', false)).not.toHaveProperty('offscreen')
    expect(checkSecurity(livePreviewWebPreferences('glade-live-preview-1', false, true))).toEqual({ ok: true })
  })
})

describe('createElectronLivePreviewView', () => {
  it('answers null with no window', () => {
    const create = createElectronLivePreviewView({ window: () => undefined, openExternal: vi.fn(), devTools: false })
    expect(
      create({ url: 'http://localhost:3000/', onBlocked: vi.fn(), onConnection: vi.fn(), onGone: vi.fn() }),
    ).toBeNull()
  })

  it("don't make a view, and are logged, when the webPreferences fail the security check", async () => {
    vi.resetModules()
    vi.doMock('../security', () => ({
      checkSecurity: () => ({ ok: false, violations: [{ setting: 'sandbox', required: true, actual: false }] }),
      describeViolations: () => 'sandbox must be true (was false)',
    }))
    const fresh = await import('./live-preview-views')
    const log = createMemoryLog()
    const window = fakeWindow()
    const create = fresh.createElectronLivePreviewView({
      window: () => window as unknown as Electron.BrowserWindow,
      openExternal: vi.fn(),
      devTools: false,
      log: log.logger,
    })

    expect(
      create({ url: 'http://localhost:3000/', onBlocked: vi.fn(), onConnection: vi.fn(), onGone: vi.fn() }),
    ).toBeNull()
    expect(window.contentView.addChildView).not.toHaveBeenCalled()
    expect(log.records).toContainEqual(expect.objectContaining({ message: 'live preview refused: insecure settings' }))
    vi.doUnmock('../security')
  })

  it('makes a sandboxed view, loads the loopback page straight, and places/hides/reloads/destroys it', () => {
    const { view, fake, window } = make()

    expect(window.contentView.addChildView).toHaveBeenCalledWith(fake)
    expect(fake.webContents.loadURL).toHaveBeenCalledWith('http://localhost:3000/')
    expect(fake.setBorderRadius).toHaveBeenCalledWith(LIVE_PREVIEW_RADIUS)
    expect(viewRadius(fake as unknown as Electron.WebContentsView, 99)).toBe(LIVE_PREVIEW_RADIUS)
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

  it('lets only loopback requests through, reporting and cancelling everything else', () => {
    const { ses, onBlocked } = make()

    const cancelled: boolean[] = []
    const callback = vi.fn((result: { cancel: boolean }) => cancelled.push(result.cancel))
    ses.beforeRequest?.({ url: 'http://localhost:3000/main.js' }, callback)
    ses.beforeRequest?.({ url: 'ws://localhost:3000/hmr' }, callback)
    ses.beforeRequest?.({ url: 'https://fonts.googleapis.com/css' }, callback)
    ses.beforeRequest?.({ url: 'not a url' }, callback)
    expect(cancelled).toEqual([false, false, true, true])
    expect(onBlocked).toHaveBeenCalledWith('fonts.googleapis.com')
    // A request whose URL can't even be parsed is still reported, by its raw text.
    expect(onBlocked).toHaveBeenCalledWith('not a url')
  })

  it('grants only fullscreen, refusing every other permission, device and download', () => {
    const { ses } = make()

    const fullscreen = vi.fn()
    ses.permissionRequest?.(undefined, 'fullscreen', fullscreen)
    expect(fullscreen).toHaveBeenCalledWith(true)
    expect(ses.permissionCheck?.(undefined, 'fullscreen')).toBe(true)

    const camera = vi.fn()
    ses.permissionRequest?.(undefined, 'camera', camera)
    expect(camera).toHaveBeenCalledWith(false)
    expect(ses.permissionCheck?.(undefined, 'camera')).toBe(false)
    expect(ses.devicePermission?.()).toBe(false)
    expect(ses.setSpellCheckerEnabled).toHaveBeenCalledWith(false)

    const download = { preventDefault: vi.fn() }
    ses.listeners.get('will-download')?.(download)
    expect(download.preventDefault).toHaveBeenCalledOnce()
  })

  it('lets the page navigate within loopback, but refuses leaving it and hands the link to the browser', async () => {
    const { fake, openExternal } = make()

    const withinLoopback = { preventDefault: vi.fn(), url: 'http://localhost:3000/level-2' }
    fake.listeners.get('will-navigate')?.(withinLoopback)
    expect(withinLoopback.preventDefault).not.toHaveBeenCalled()

    const leaving = { preventDefault: vi.fn(), url: 'https://example.com/' }
    fake.listeners.get('will-navigate')?.(leaving)
    expect(leaving.preventDefault).toHaveBeenCalledOnce()
    await Promise.resolve()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')

    const redirectWithin = { preventDefault: vi.fn(), url: 'http://localhost:3000/next' }
    fake.listeners.get('will-redirect')?.(redirectWithin)
    expect(redirectWithin.preventDefault).not.toHaveBeenCalled()

    const redirectAway = { preventDefault: vi.fn(), url: 'https://example.com/' }
    fake.listeners.get('will-redirect')?.(redirectAway)
    expect(redirectAway.preventDefault).toHaveBeenCalledOnce()

    // A scheme that isn't openable (never handed to the browser) is refused and logged, not thrown.
    const openScript = { preventDefault: vi.fn(), url: 'javascript:alert(1)' }
    fake.listeners.get('will-navigate')?.(openScript)
    await Promise.resolve()
    expect(openExternal).not.toHaveBeenCalledWith('javascript:alert(1)')

    const webview = { preventDefault: vi.fn() }
    fake.listeners.get('will-attach-webview')?.(webview)
    expect(webview.preventDefault).toHaveBeenCalledOnce()
  })

  it('refuses a new window, opening a loopback target in place and handing off anything else', async () => {
    const { fake, openExternal } = make()

    expect(fake.windowOpenHandler?.({ url: 'http://localhost:3000/popup' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(openExternal).not.toHaveBeenCalled()

    expect(fake.windowOpenHandler?.({ url: 'https://example.com/' })).toEqual({ action: 'deny' })
    await Promise.resolve()
    expect(openExternal).toHaveBeenCalledWith('https://example.com/')
  })

  it('tracks the connection: up when the page loads, down when it fails or crashes', () => {
    const { fake, onConnection, onGone, log } = make()

    fake.listeners.get('did-finish-load')?.()
    expect(onConnection).toHaveBeenLastCalledWith(true)

    fake.listeners.get('did-fail-load')?.({}, -6, 'ERR_FAILED')
    expect(onConnection).toHaveBeenLastCalledWith(false)
    expect(log.records.some(({ message }) => message === "live preview's page failed to load")).toBe(true)

    fake.listeners.get('render-process-gone')?.({}, { reason: 'crashed' })
    expect(onConnection).toHaveBeenLastCalledWith(false)
    expect(onGone).toHaveBeenCalledOnce()
  })

  it('gives the page the keyboard focus on a real mouse-down, not on a mouse-up', () => {
    const { fake } = make()

    fake.listeners.get('before-mouse-event')?.({}, { type: 'mouseUp' })
    expect(fake.webContents.focus).not.toHaveBeenCalled()

    fake.listeners.get('before-mouse-event')?.({}, { type: 'mouseDown' })
    expect(fake.webContents.focus).toHaveBeenCalledOnce()
  })

  it('destroys itself, telling the host, when its window closes', () => {
    const { window, onGone, fake } = make()

    window.listeners.get('closed')?.()
    expect(onGone).toHaveBeenCalledOnce()
    expect(fake.webContents.close).toHaveBeenCalledOnce()
  })

  it('logs and reports disconnection, without throwing, when the page fails to start loading', async () => {
    electron.load.next = () => Promise.reject(new Error('boom'))
    const { log, onConnection } = make()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(log.records.some(({ message }) => message === "live preview's page didn't load")).toBe(true)
    expect(onConnection).toHaveBeenCalledWith(false)
  })
})
