/**
 * The shown plugin's real view: an Electron `WebContentsView` over the plugin card's body, in a sandboxed process of its
 * own with a session of its own (`docs/plugin-api.md`, "The sandbox"). The session serves the plugin's files under its
 * scheme, from its folder only, with the CSP; cancels every request but those and localhost; and refuses every
 * permission and download. The page can't navigate or open windows, and its only preload relays messages.
 */
import { join } from 'node:path'
import { session, WebContentsView, type BrowserWindow, type WebPreferences } from 'electron'
import type { PluginViewBounds } from '../../shared/bridge'
import { PLUGIN_MESSAGE_CHANNEL, PLUGIN_POST_CHANNEL, PLUGIN_SCHEME } from '../../shared/plugin-api'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { checkSecurity, describeViolations } from '../security'
import { isAllowedPluginRequest } from './network'
import { createPluginFileHandler, PLUGIN_CSP } from './protocol'
import type { CreatePluginView } from './views'

/** The `panel` design token, the card's surface, so the view never flashes white before the page paints. */
const VIEW_BACKGROUND = '#181921'

/** The card's corner radius (`--radius-card`) less its 1px border: the view's corners sit inside the card's. */
export const PLUGIN_VIEW_RADIUS = 15

/**
 * Registers the plugin scheme as a standard, secure one, so a plugin's page has an origin of its own
 * (`glade-plugin://<id>`) for its CSP's `'self'` and relative URLs, and can `fetch` its own files. Call before the app
 * is ready.
 */
export function registerPluginScheme(protocol: Pick<Electron.Protocol, 'registerSchemesAsPrivileged'>): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ])
}

/** A plugin's session partition: its own, and in memory, so it shares no storage with Glade or another plugin. */
export function pluginPartition(id: string): string {
  return `glade-plugin-${id}`
}

/** A plugin page's first URL: its manifest's `entry`, under its scheme. */
export function pluginEntryUrl(id: string, entry: string): string {
  return `${PLUGIN_SCHEME}://${id}/${entry.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * The only webPreferences a plugin's view is made with, checked by `checkSecurity` before it's made: sandboxed, isolated,
 * no Node, the relaying preload alone, its own partition, no dialogs, no webviews, and DevTools only outside a packaged
 * app. A capture draws it offscreen: it can't capture a view in a window that's never shown.
 */
export function pluginWebPreferences(id: string, devTools: boolean, offscreen = false): WebPreferences {
  return {
    ...(offscreen ? { offscreen: true } : {}),
    preload: join(__dirname, '../preload/plugin.js'),
    partition: pluginPartition(id),
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

/** The parts of a plugin's Electron session it's set up through. */
export type PluginSession = Pick<
  Electron.Session,
  | 'protocol'
  | 'webRequest'
  | 'setPermissionRequestHandler'
  | 'setPermissionCheckHandler'
  | 'setDevicePermissionHandler'
  | 'setSpellCheckerEnabled'
  | 'on'
>

/** What a plugin's session serves and allows. */
export interface PluginSessionSpec {
  readonly id: string
  readonly folder: string
  readonly log?: Logger
}

/**
 * Sets up a plugin's session: its scheme serves its folder, every other request is cancelled but localhost, every
 * response carries the CSP, and every permission, device, download and spellcheck dictionary is refused.
 */
export function setUpPluginSession(ses: PluginSession, { id, folder, log = SILENT_LOGGER }: PluginSessionSpec): void {
  ses.protocol.handle(PLUGIN_SCHEME, createPluginFileHandler({ id, folder, log }))
  ses.webRequest.onBeforeRequest((details, callback) => {
    const allowed = isAllowedPluginRequest(details.url, id)
    if (!allowed) log.warn('plugin request blocked', { id, url: details.url })
    callback({ cancel: !allowed })
  })
  // Its own files carry the CSP already; this puts it on everything else too, such as a localhost server's page.
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [PLUGIN_CSP] } })
  })
  ses.setPermissionRequestHandler((_contents, permission, callback) => {
    log.warn('plugin permission refused', { id, permission })
    callback(false)
  })
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)
  // The spellchecker would fetch its dictionaries from the network, outside the page's requests.
  ses.setSpellCheckerEnabled(false)
  ses.on('will-download', (event) => {
    log.warn('plugin download refused', { id })
    event.preventDefault()
  })
}

export interface ElectronPluginViewsOptions {
  /** The window the view goes in: Glade's, or none while it's closed. */
  readonly window: () => BrowserWindow | undefined
  /** Whether the view's DevTools can open: never in a packaged app. */
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

/** Makes plugin views in Glade's window. A view whose webPreferences fail `checkSecurity` isn't made. */
export function createElectronPluginViews({
  window: currentWindow,
  devTools,
  offscreen = false,
  log = SILENT_LOGGER,
}: ElectronPluginViewsOptions): CreatePluginView {
  // Each plugin's session lives as long as the app, so it's set up once however often its view is made.
  const setUp = new Set<string>()

  return ({ plugin, folder, onMessage, onGone }) => {
    const id = plugin.folder
    const window = currentWindow()
    if (window === undefined) return null
    const webPreferences = pluginWebPreferences(id, devTools, offscreen)
    const security = checkSecurity(webPreferences)
    if (!security.ok) {
      log.error('plugin view refused: insecure settings', { id, detail: describeViolations(security.violations) })
      return null
    }
    if (!setUp.has(id)) {
      setUpPluginSession(session.fromPartition(pluginPartition(id)), { id, folder, log })
      setUp.add(id)
    }

    const view = new WebContentsView({ webPreferences })
    const contents = view.webContents
    view.setBackgroundColor(VIEW_BACKGROUND)
    view.setBorderRadius(PLUGIN_VIEW_RADIUS)
    view.setVisible(false)

    contents.setWindowOpenHandler(() => {
      log.warn('plugin window refused', { id })
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event) => {
      log.warn('plugin navigation refused', { id, url: event.url })
      event.preventDefault()
    })
    contents.on('will-redirect', (event) => {
      log.warn('plugin redirect refused', { id, url: event.url })
      event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => {
      event.preventDefault()
    })
    contents.on('did-fail-load', (_event, code, description) => {
      log.warn("plugin's page failed to load", { id, code, description })
    })
    contents.on('render-process-gone', (_event, details) => {
      log.error("plugin's process is gone", { id, reason: details.reason })
      onGone()
    })
    // Only this view's page can post on it: `webContents.ipc` hears its own renderer alone.
    contents.ipc.on(PLUGIN_POST_CHANNEL, (_event, message: unknown) => {
      onMessage(message)
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
    contents.loadURL(pluginEntryUrl(id, plugin.manifest.entry)).catch((error: unknown) => {
      log.warn("plugin's page didn't load", { id, error })
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
      send(message) {
        if (!destroyed) contents.send(PLUGIN_MESSAGE_CHANNEL, message)
      },
      destroy,
    }
  }
}
