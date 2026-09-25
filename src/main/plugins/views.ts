/**
 * The shown plugin's view (`docs/plugin-api.md`, "The sandbox" and "Talking to Glade"): one at a time, over the plugin
 * card's body, created when the window first places it and destroyed when the plugin is turned off. What the page posts
 * is rate-limited and checked here; `ready` is answered with `hello` and the feed's snapshot and changes (`./feed`), and
 * `status` sets the card's header. A plugin that's turned off (or gone) stops being fed with its view.
 */
import { join } from 'node:path'
import { BridgeErrorCode, EventType, type PluginViewBounds } from '../../shared/bridge'
import {
  PLUGIN_API_VERSION,
  PluginEventType,
  PluginMessageType,
  type GladeMessage,
  type PluginEvent,
} from '../../shared/plugin-api'
import { PluginStatus, type InstalledPlugin, type ValidPlugin } from '../../shared/plugins'
import { CommandFailure } from '../bridge/errors'
import type { Emit } from '../bridge/events'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { PluginFeed, Unsubscribe } from './feed'
import { createRateLimiter, cutStatus, parsePluginMessage, PLUGIN_RATE_LIMIT, type RateLimit } from './messages'

/** A plugin's view in the window, as the host drives it (`./electron-view` makes the real one). */
export interface PluginView {
  /** Moves it over the card's body, in the page's CSS pixels, and shows it. */
  place(bounds: PluginViewBounds): void
  /** Hides it, keeping its page. */
  hide(): void
  /** Sends the page one of Glade's messages. */
  send(message: GladeMessage): void
  /** Takes it out of the window and ends its page. */
  destroy(): void
}

/** What a plugin's view is made from. */
export interface PluginViewSpec {
  readonly plugin: ValidPlugin
  /** Its folder, whose files are all the view is served. */
  readonly folder: string
  /** What its page posts, as it arrives: unchecked. */
  readonly onMessage: (message: unknown) => void
  /** Its page is gone (it crashed, or the window closed): it's destroyed. */
  readonly onGone: () => void
}

/** Makes a plugin's view, or answers null when it can't be made safely (it's logged). */
export type CreatePluginView = (spec: PluginViewSpec) => PluginView | null

export interface PluginViewsOptions {
  readonly emit: Emit
  /** The task and agent events a plugin is fed after `ready`. */
  readonly feed: Pick<PluginFeed, 'subscribe'>
  /** The plugins folder: each plugin's is `<folder>/<id>`. */
  readonly folder: string
  /** Glade's version, for `hello`. */
  readonly appVersion: string
  /** Makes the views; none by default, where placing does nothing but check the plugin. */
  readonly createView?: CreatePluginView
  /** How many messages a plugin may post. */
  readonly rateLimit?: RateLimit
  readonly now?: () => number
  readonly log?: Logger
}

/** The shown plugin's view. */
export interface PluginViews {
  /**
   * Puts the plugin's view over its card's body, or hides it (`bounds: null`), and answers with its status. Makes the
   * view the first time it's shown, destroying another plugin's. Fails with `not_found` for a plugin that isn't on.
   */
  place(id: string, bounds: PluginViewBounds | null): { readonly status: string }
  /** The plugins changed: a view whose plugin is no longer on (or gone, or invalid) is destroyed. */
  update(plugins: readonly InstalledPlugin[]): void
  /** Destroys the view, if there is one: the app is quitting. */
  close(): void
}

/** The view showing now, and what its page has said. */
interface Shown {
  readonly id: string
  readonly view: PluginView
  /** The last message's `seq`, counting from 1 after each `hello`. */
  seq: number
  /** Stops the feed's events, once `ready` has started them. */
  unsubscribe: Unsubscribe | null
  status: string
  /** Whether messages are being dropped for coming too fast, so the log says so once, not per message. */
  flooding: boolean
}

export function createPluginViews({
  emit,
  feed,
  folder,
  appVersion,
  createView,
  rateLimit = PLUGIN_RATE_LIMIT,
  now = Date.now,
  log = SILENT_LOGGER,
}: PluginViewsOptions): PluginViews {
  let plugins: readonly InstalledPlugin[] = []
  let shown: Shown | null = null

  const enabled = (id: string): ValidPlugin | undefined =>
    plugins.find(
      (plugin): plugin is ValidPlugin => plugin.folder === id && plugin.status === PluginStatus.Valid && plugin.enabled,
    )

  const send = (current: Shown, event: PluginEvent): void => {
    current.seq += 1
    current.view.send({ source: 'glade', apiVersion: PLUGIN_API_VERSION, seq: current.seq, event })
  }

  const setStatus = (current: Shown, text: string): void => {
    if (current.status === text) return
    current.status = text
    log.debug('plugin status', { id: current.id, text })
    emit({ type: EventType.PluginStatusChanged, id: current.id, text })
  }

  const destroy = (current: Shown, reason: string): void => {
    if (shown === current) shown = null
    current.unsubscribe?.()
    current.unsubscribe = null
    current.view.destroy()
    log.info('plugin view destroyed', { id: current.id, reason })
    setStatus(current, '')
  }

  const receive = (current: Shown, limiter: { take(): boolean }, raw: unknown): void => {
    // A page that's been replaced can't talk for the one after it.
    if (shown !== current) return
    if (!limiter.take()) {
      if (!current.flooding) log.warn('plugin messages dropped: too many', { id: current.id })
      current.flooding = true
      return
    }
    current.flooding = false
    const parsed = parsePluginMessage(raw)
    if (!parsed.ok) {
      log.warn('plugin message dropped', { id: current.id, reason: parsed.reason })
      return
    }
    const { message } = parsed
    switch (message.type) {
      case PluginMessageType.Ready:
        // Ready again starts over: the old feed stops before the new hello, so nothing of it follows.
        current.unsubscribe?.()
        current.seq = 0
        send(current, { type: PluginEventType.Hello, app: { name: 'Glade', version: appVersion } })
        current.unsubscribe = feed.subscribe((event) => {
          send(current, event)
        })
        return
      case PluginMessageType.Status:
        setStatus(current, cutStatus(message.text))
        return
    }
  }

  const open = (plugin: ValidPlugin): Shown | null => {
    if (createView === undefined) return null
    const limiter = createRateLimiter(rateLimit, now)
    let current: Shown | null = null
    const view = createView({
      plugin,
      folder: join(folder, plugin.folder),
      onMessage: (raw) => {
        if (current !== null) receive(current, limiter, raw)
      },
      onGone: () => {
        if (current !== null && shown === current) destroy(current, 'its page is gone')
      },
    })
    if (view === null) return null
    current = { id: plugin.folder, view, seq: 0, unsubscribe: null, status: '', flooding: false }
    log.info('plugin view created', { id: plugin.folder })
    return current
  }

  return {
    place(id, bounds) {
      const plugin = enabled(id)
      if (plugin === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `No enabled plugin ${id}`)
      if (shown !== null && shown.id !== id) destroy(shown, 'another plugin is shown')
      if (bounds === null) {
        shown?.view.hide()
        return { status: shown?.status ?? '' }
      }
      shown ??= open(plugin)
      shown?.view.place(bounds)
      return { status: shown?.status ?? '' }
    },
    update(next) {
      plugins = next
      if (shown !== null && enabled(shown.id) === undefined) destroy(shown, 'the plugin is off')
    },
    close() {
      if (shown !== null) destroy(shown, 'the app is quitting')
    },
  }
}
