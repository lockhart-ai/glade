/**
 * The Files viewer's live preview (#764): an Electron `WebContentsView` over the viewer's body, in a sandboxed
 * process of its own with a fresh in-memory session, built the same way as the offline HTML preview
 * (`./html-preview-views`, which stays exactly as #614 left it) and the plugin sandbox (`../plugins/electron-view.ts`)
 * rather than an iframe, since a frame shares the renderer's process and could reach the preload bridge.
 *
 * Unlike the HTML preview, the page is loaded straight from its own loopback URL (`http://localhost:<port>/…`): there's
 * no scheme to serve it under, only a request filter (`./live-preview-network`) that lets the session reach loopback
 * alone, over `http`/`ws`, so a local dev server's hot reload keeps working. Every other request is cancelled and
 * reported through `onBlocked`, for the viewer's quiet notice. The page can only grant itself fullscreen; every other
 * permission and every download is refused. Leaving loopback — a navigation, a new window — is refused and handed to
 * the browser instead, as the HTML preview hands off its own links. A click inside the page gives it the keyboard
 * focus, so arrow keys and Shift reach it rather than Glade's own page.
 */
import { randomUUID } from 'node:crypto'
import { session, WebContentsView, type BrowserWindow, type WebPreferences } from 'electron'
import type { PluginViewBounds } from '../../shared/bridge'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { openLink, type OpenExternal } from '../links/links'
import { checkSecurity, describeViolations } from '../security'
import { setViewRadius } from '../native-view-radius'
import { isAllowedLivePreviewRequest, isLoopbackUrl } from './live-preview-network'

/** The `panel` design token, the viewer's surface, so the view never flashes white before the page paints. */
const VIEW_BACKGROUND = '#181921'

/** The preview sits flush in the viewer's body, not floating like the plugin's card: no rounded corners. */
export const LIVE_PREVIEW_RADIUS = 0

/** A live preview's session partition: fresh and in memory each time one opens, shared with nothing else. */
function livePreviewPartition(): string {
  return `glade-live-preview-${randomUUID()}`
}

/**
 * The only webPreferences a live preview's view is made with, checked by `checkSecurity` before it's made: sandboxed,
 * isolated, no Node, no preload at all, its own partition, no dialogs, no webviews, and DevTools only outside a
 * packaged app. Nothing here disables `webSecurity` or grants WebGL or Web Audio: a sandboxed page gets both already.
 */
export function livePreviewWebPreferences(partition: string, devTools: boolean, offscreen = false): WebPreferences {
  return {
    ...(offscreen ? { offscreen: true } : {}),
    partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
    experimentalFeatures: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    spellcheck: false,
    disableDialogs: true,
    devTools,
  }
}

/** The parts of a live preview's Electron session it's set up through. */
export type LivePreviewSession = Pick<
  Electron.Session,
  | 'webRequest'
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler'
  | 'setSpellCheckerEnabled'
  | 'on'
>

export interface LivePreviewSessionSpec {
  readonly onBlocked: (host: string) => void
  readonly log?: Logger
}

/** The one permission a live page may have: fullscreen, so a game can go full screen on request. */
const ALLOWED_PERMISSION = 'fullscreen'

/**
 * Sets up a live preview's session: only loopback requests go through (everything else is cancelled and reported,
 * through `onBlocked`, for the viewer's quiet notice), only `fullscreen` is granted, and every device, download and
 * spellcheck dictionary is refused.
 */
export function setUpLivePreviewSession(
  ses: LivePreviewSession,
  { onBlocked, log = SILENT_LOGGER }: LivePreviewSessionSpec,
): void {
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedLivePreviewRequest(details.url)
    if (!allowed) {
      const host = urlHost(details.url)
      log.warn('live preview request blocked', { url: details.url })
      onBlocked(host)
    }
    callback({ cancel: !allowed })
  })
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    const allowed = permission === ALLOWED_PERMISSION
    if (!allowed) log.warn('live preview permission refused', { permission })
    callback(allowed)
  })
  ses.setPermissionCheckHandler((_contents, permission) => permission === ALLOWED_PERMISSION)
  ses.setDevicePermissionHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', (event) => {
    log.warn('live preview download refused')
    event.preventDefault()
  })
}

/** The host a blocked request named, for the viewer's notice; the raw text when it isn't a URL at all. */
function urlHost(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return raw
  }
}

/** A live preview's view in the window, as the host drives it. */
export interface LivePreviewView {
  /** Moves it over the viewer's body, in the page's CSS pixels, and shows it. */
  place(bounds: PluginViewBounds): void
  /** Hides it, keeping its page. */
  hide(): void
  /** Reloads the page in place. */
  reload(): void
  /** Takes it out of the window and ends its page. */
  destroy(): void
}

/** What a live preview's view is made from. */
export interface LivePreviewViewSpec {
  /** The loopback page to load; refused by `checkSecurity`'s caller before this is ever reached. */
  readonly url: string
  /** A request was cancelled: fed to the viewer's quiet "blocked" notice, with the host that was refused. */
  readonly onBlocked: (host: string) => void
  /** The page finished loading, or failed to, or crashed: the viewer's "Connected" indicator follows this. */
  readonly onConnection: (connected: boolean) => void
  /** Its page is gone (it crashed, or the window closed): it's destroyed. */
  readonly onGone: () => void
}

/** Makes a live preview's view, or answers null when it can't be made safely (it's logged), or there's no window. */
export type CreateLivePreviewView = (spec: LivePreviewViewSpec) => LivePreviewView | null

export interface ElectronLivePreviewViewsOptions {
  readonly window: () => BrowserWindow | undefined
  readonly openExternal: OpenExternal
  readonly devTools: boolean
  /** Whether views are drawn offscreen, for a capture to paste into its page's; never outside capture mode. */
  readonly offscreen?: boolean
  readonly log?: Logger
}

/** The view's bounds in the window's points, from the page's CSS pixels at its zoom. */
function scaled(bounds: PluginViewBounds, zoom: number): Electron.Rectangle {
  return {
    x: Math.round(bounds.x * zoom),
    y: Math.round(bounds.y * zoom),
    width: Math.round(bounds.width * zoom),
    height: Math.round(bounds.height * zoom),
  }
}

/** Makes the live preview's real view in Glade's window. A view whose webPreferences fail `checkSecurity` isn't made. */
export function createElectronLivePreviewView({
  window: currentWindow,
  openExternal,
  devTools,
  offscreen = false,
  log = SILENT_LOGGER,
}: ElectronLivePreviewViewsOptions): CreateLivePreviewView {
  return ({ url, onBlocked, onConnection, onGone }) => {
    const window = currentWindow()
    if (window === undefined) return null
    const partition = livePreviewPartition()
    const webPreferences = livePreviewWebPreferences(partition, devTools, offscreen)
    const security = checkSecurity(webPreferences)
    if (!security.ok) {
      log.error('live preview refused: insecure settings', { detail: describeViolations(security.violations) })
      return null
    }
    setUpLivePreviewSession(session.fromPartition(partition), { onBlocked, log })

    const view = new WebContentsView({ webPreferences })
    setViewRadius(view, LIVE_PREVIEW_RADIUS)
    const contents = view.webContents
    view.setBackgroundColor(VIEW_BACKGROUND)
    view.setBorderRadius(LIVE_PREVIEW_RADIUS)
    view.setVisible(false)

    /** A loopback destination goes ahead (the page's own routing); anything else is handed to the browser or refused. */
    const handOffOrRefuse = (destination: string): void => {
      openLink({ openExternal, log }, destination).catch(() => {
        log.warn('live preview navigation refused', { url: destination })
      })
    }

    contents.setWindowOpenHandler(({ url: target }) => {
      if (isLoopbackUrl(target)) log.info('live preview window refused: opens in place only', { url: target })
      else handOffOrRefuse(target)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => {
      if (isLoopbackUrl(event.url)) return
      event.preventDefault()
      handOffOrRefuse(event.url)
    })
    contents.on('will-redirect', (event) => {
      if (isLoopbackUrl(event.url)) return
      event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.on('did-finish-load', () => {
      onConnection(true)
    })
    contents.on('did-fail-load', (_event, code, description) => {
      log.warn("live preview's page failed to load", { code, description })
      onConnection(false)
    })
    contents.on('render-process-gone', (_event, details) => {
      log.error("live preview's process is gone", { reason: details.reason })
      onConnection(false)
      onGone()
    })
    // A real OS click lands on this view directly (it's drawn over the page, not inside it), so nothing in Glade's
    // own page ever sees it: this is the only way to give the page the keyboard focus, for arrow keys and Shift.
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type === 'mouseDown') contents.focus()
    })

    let destroyed = false
    const onClosed = (): void => {
      destroy()
      onGone()
    }
    const destroy = (): void => {
      if (destroyed) return
      destroyed = true
      window.removeListener('closed', onClosed)
      if (!window.isDestroyed()) window.contentView.removeChildView(view)
      if (!contents.isDestroyed()) contents.close()
    }
    window.once('closed', onClosed)
    window.contentView.addChildView(view)
    contents.loadURL(url).catch((error: unknown) => {
      log.warn("live preview's page didn't load", { error })
      onConnection(false)
    })

    return {
      place(bounds) {
        if (destroyed) return
        view.setBounds(scaled(bounds, window.webContents.getZoomFactor()))
        view.setVisible(true)
      },
      hide() {
        if (!destroyed) view.setVisible(false)
      },
      reload() {
        if (!destroyed) contents.reload()
      },
      destroy,
    }
  }
}
