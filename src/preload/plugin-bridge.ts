import {
  MAX_PLUGIN_MESSAGE_BYTES,
  PLUGIN_MESSAGE_CHANNEL,
  PLUGIN_POST_CHANNEL,
  type PluginBridge,
} from '../shared/plugin-api'

/** The part of Electron's `ipcRenderer` a plugin's preload uses, so tests can stand in a fake. */
export interface PluginIpc {
  send(channel: string, message: unknown): void
  on(channel: string, listener: (event: unknown, message: unknown) => void): unknown
}

/** The part of the page's `window` the preload posts Glade's messages to. */
export interface PluginWindow {
  postMessage(message: unknown, targetOrigin: string): void
}

/** How long `message` is as JSON, or null when it can't be written as JSON (a cycle, a BigInt, a function). */
function jsonLength(message: unknown): number | null {
  try {
    const json = JSON.stringify(message) as string | undefined
    return json === undefined ? null : json.length
  } catch {
    return null
  }
}

/**
 * Relays between main and a plugin's page, and does nothing else: each message main sends is posted to the page as a
 * `message` event, and the page's `window.glade.post(message)` goes to main, which checks it. A message that isn't
 * JSON, or is longer than `MAX_PLUGIN_MESSAGE_BYTES` as JSON, is dropped here, so it never costs main anything.
 */
export function createPluginBridge(ipc: PluginIpc, page: PluginWindow): PluginBridge {
  ipc.on(PLUGIN_MESSAGE_CHANNEL, (_event, message) => {
    // The page is the only thing in its window: its CSP has `frame-src 'none'`, and it can't open others.
    page.postMessage(message, '*')
  })
  return {
    post(message) {
      const length = jsonLength(message)
      if (length === null || length > MAX_PLUGIN_MESSAGE_BYTES) return
      ipc.send(PLUGIN_POST_CHANNEL, message)
    },
  }
}
