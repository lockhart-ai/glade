/**
 * The messages Glade and a plugin's page send each other (`docs/plugin-api.md`, "Talking to Glade"). Shared by main,
 * which sends and checks them, and the plugin preload, which only relays them, so it imports nothing but constants.
 */

/** The version of the schema every message Glade sends follows. */
export const PLUGIN_API_VERSION = 1

/** The scheme a plugin's files are served under, `glade-plugin://<id>/<path>`, from its own folder only. */
export const PLUGIN_SCHEME = 'glade-plugin'

/** The IPC channel main sends a plugin's page Glade's messages on; its preload posts each to the page. */
export const PLUGIN_MESSAGE_CHANNEL = 'glade:plugin-message'

/** The IPC channel a plugin's preload sends the page's `window.glade.post` messages on. */
export const PLUGIN_POST_CHANNEL = 'glade:plugin-post'

/** The name the bridge has on a plugin page's `window`: `window.glade.post(message)`. */
export const PLUGIN_BRIDGE_KEY = 'glade'

/**
 * The largest message a plugin may post, as JSON. The preload drops anything bigger before it reaches main, and main's
 * schema caps each field as well.
 */
export const MAX_PLUGIN_MESSAGE_BYTES = 16 * 1024

/** The longest status the panel header shows; a longer one is cut. */
export const MAX_PLUGIN_STATUS = 40

export enum PluginEventType {
  Hello = 'hello',
}

/** Glade's name and version, in `hello`. */
export interface PluginAppInfo {
  readonly name: 'Glade'
  readonly version: string
}

/** First, after each `ready`: which Glade the plugin is talking to. */
export interface PluginHelloEvent {
  readonly type: PluginEventType.Hello
  readonly app: PluginAppInfo
}

/** What Glade tells a plugin. The task and agent events join it in P12-04. */
export type PluginEvent = PluginHelloEvent

/** The envelope every message from Glade to a plugin comes in. */
export interface GladeMessage {
  readonly source: 'glade'
  /** The schema version this message follows. */
  readonly apiVersion: typeof PLUGIN_API_VERSION
  /** Counts up from 1 with each message since the last `hello`. */
  readonly seq: number
  readonly event: PluginEvent
}

export enum PluginMessageType {
  /** Asks for `hello` (and, from P12-04, a snapshot). */
  Ready = 'ready',
  /** Sets the short status at the right of the panel header; `''` clears it. */
  Status = 'status',
}

export interface PluginReadyMessage {
  readonly type: PluginMessageType.Ready
}

export interface PluginStatusMessage {
  readonly type: PluginMessageType.Status
  readonly text: string
}

/** What a plugin can post back with `window.glade.post`. Anything else is dropped. */
export type PluginMessage = PluginReadyMessage | PluginStatusMessage

/** What a plugin page's `window.glade` holds: `post`, and nothing else. */
export interface PluginBridge {
  post(message: unknown): void
}
