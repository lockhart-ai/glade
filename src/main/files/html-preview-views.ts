/**
 * The Files viewer's HTML preview (#614): an Electron `WebContentsView` over the viewer's body, in a sandboxed
 * process of its own with a fresh in-memory session, reusing the plugin sandbox's approach
 * (`../plugins/electron-view.ts`) rather than an iframe, since a frame shares the renderer's process and could reach
 * the preload bridge. The session serves the file's own folder under its scheme (`./html-preview-protocol`), with the
 * CSP; cancels every other request, so the preview is offline (Jared, Oct 12); and refuses every permission and
 * download. The page can't navigate or open windows; an http(s) or mailto link is handed to the existing
 * open-in-browser path (`../links/links`) instead. At most one preview shows at a time, as the Files viewer only ever
 * shows one file: showing another destroys the last.
 */
import { randomUUID } from 'node:crypto'
import { session, WebContentsView, type BrowserWindow, type WebPreferences } from 'electron'
import type { PluginViewBounds } from '../../shared/bridge'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { openLink, type OpenExternal } from '../links/links'
import { checkSecurity, describeViolations } from '../security'
import { setViewRadius } from '../native-view-radius'
import {
  createHtmlPreviewFileHandler,
  htmlPreviewEntryUrl,
  isAllowedHtmlPreviewRequest,
  HTML_PREVIEW_CSP,
  HTML_PREVIEW_SCHEME,
} from './html-preview-protocol'

/** The `panel` design token, the viewer's surface, so the view never flashes white before the page paints. */
const VIEW_BACKGROUND = '#181921'

/** The preview sits flush in the viewer's body, not floating like the plugin's card: no rounded corners. */
export const HTML_PREVIEW_RADIUS = 0

/** A preview's session partition: fresh and in memory each time a file is shown, shared with nothing else. */
function htmlPreviewPartition(): string {
  return `${HTML_PREVIEW_SCHEME}-${randomUUID()}`
}

/**
 * The only webPreferences a preview's view is made with, checked by `checkSecurity` before it's made: sandboxed,
 * isolated, no Node, no preload at all (the page can't reach anything of Glade's, not even a relay), its own
 * partition, no dialogs, no webviews, and DevTools only outside a packaged app.
 */
export function htmlPreviewWebPreferences(partition: string, devTools: boolean, offscreen = false): WebPreferences {
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

/** The parts of a preview's Electron session it's set up through. */
export type HtmlPreviewSession = Pick<
  Electron.Session,
  | 'protocol'
  | 'webRequest'
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler'
  | 'setSpellCheckerEnabled'
  | 'on'
>

export interface HtmlPreviewSessionSpec {
  readonly folder: string
  readonly onBlocked: () => void
  readonly log?: Logger
}

/**
 * Sets up a preview's session: its scheme serves the file's folder, every other request is cancelled (and reported
 * through `onBlocked`, for the viewer's quiet notice), every response carries the CSP, and every permission, device,
 * download and spellcheck dictionary is refused.
 */
export function setUpHtmlPreviewSession(
  ses: HtmlPreviewSession,
  { folder, onBlocked, log = SILENT_LOGGER }: HtmlPreviewSessionSpec,
): void {
  ses.protocol.handle(HTML_PREVIEW_SCHEME, createHtmlPreviewFileHandler({ folder, log }))
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedHtmlPreviewRequest(details.url)
    if (!allowed) {
      log.warn('html preview request blocked', { url: details.url })
      onBlocked()
    }
    callback({ cancel: !allowed })
  })
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [HTML_PREVIEW_CSP] } })
  })
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn('html preview permission refused', { permission })
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', (event) => {
    log.warn('html preview download refused')
    event.preventDefault()
  })
}

/** A preview's view in the window, as the host drives it. */
export interface HtmlPreviewView {
  /** Moves it over the viewer's body, in the page's CSS pixels, and shows it. */
  place(bounds: PluginViewBounds): void
  /** Hides it, keeping its page. */
  hide(): void
  /** Reloads the file fresh from disk, in place. */
  reload(): void
  /** Takes it out of the window and ends its page. */
  destroy(): void
}

/** What a preview's view is made from. */
export interface HtmlPreviewViewSpec {
  /** The HTML file's own folder, resolved and symlink-safe; all the preview may read. */
  readonly folder: string
  /** The file's name within that folder, served at the scheme's root. */
  readonly fileName: string
  /** A request was cancelled: fed to the viewer's quiet "blocked" notice (debounced per load, by the caller). */
  readonly onBlocked: () => void
  /** Its page is gone (it crashed, or the window closed): it's destroyed. */
  readonly onGone: () => void
}

/** Makes a preview's view, or answers null when it can't be made safely (it's logged), or there's no window. */
export type CreateHtmlPreviewView = (spec: HtmlPreviewViewSpec) => HtmlPreviewView | null

export interface ElectronHtmlPreviewViewsOptions {
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

/** Makes the preview's real view in Glade's window. A view whose webPreferences fail `checkSecurity` isn't made. */
export function createElectronHtmlPreviewView({
  window: currentWindow,
  openExternal,
  devTools,
  offscreen = false,
  log = SILENT_LOGGER,
}: ElectronHtmlPreviewViewsOptions): CreateHtmlPreviewView {
  return ({ folder, fileName, onBlocked, onGone }) => {
    const window = currentWindow()
    if (window === undefined) return null
    const partition = htmlPreviewPartition()
    const webPreferences = htmlPreviewWebPreferences(partition, devTools, offscreen)
    const security = checkSecurity(webPreferences)
    if (!security.ok) {
      log.error('html preview refused: insecure settings', { detail: describeViolations(security.violations) })
      return null
    }
    setUpHtmlPreviewSession(session.fromPartition(partition), { folder, onBlocked, log })

    const view = new WebContentsView({ webPreferences })
    setViewRadius(view, HTML_PREVIEW_RADIUS)
    const contents = view.webContents
    view.setBackgroundColor(VIEW_BACKGROUND)
    view.setBorderRadius(HTML_PREVIEW_RADIUS)
    view.setVisible(false)

    /** An http(s) or mailto navigation goes to the browser, never into the view; anything else is refused and logged. */
    const handOffOrRefuse = (url: string): void => {
      openLink({ openExternal, log }, url).catch(() => {
        log.warn('html preview navigation refused', { url })
      })
    }

    contents.setWindowOpenHandler(({ url }) => {
      handOffOrRefuse(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => {
      event.preventDefault()
      handOffOrRefuse(event.url)
    })
    contents.on('will-redirect', (event) => {
      event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.on('did-fail-load', (_event, code, description) => {
      log.warn("html preview's page failed to load", { code, description })
    })
    // The CSP refuses most of what's blocked (a fetch, an image, a frame) inside the page itself, before it ever
    // becomes a request main's `onBeforeRequest` sees: Chromium reports it to the console instead. This is the
    // notice's main source; `onBeforeRequest`'s own cancellations (above) catch what isn't CSP's to refuse.
    contents.on('console-message', (_event, _level, message) => {
      if (/content security policy/i.test(message)) {
        log.warn('html preview content blocked by its CSP', { message })
        onBlocked()
      }
    })
    contents.on('render-process-gone', (_event, details) => {
      log.error("html preview's process is gone", { reason: details.reason })
      onGone()
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
    contents.loadURL(htmlPreviewEntryUrl(fileName)).catch((error: unknown) => {
      log.warn("html preview's page didn't load", { error })
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
