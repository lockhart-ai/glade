/**
 * The Files viewer's shown live preview (#764): at most one, over the viewer's body, created the first time it's
 * placed and destroyed once a different file (or URL) is shown, or the app is quitting — the same lifecycle as the
 * offline HTML preview (`./html-preview`), which this is modelled on. Unlike it, there's no file on disk to resolve:
 * the view loads the URL straight away. A request the sandboxed page makes for anything but loopback is cancelled
 * (`./live-preview-views`) and broadcasts `files.livePreviewBlocked`, once per load, for the viewer's quiet notice;
 * the page finishing, failing or crashing broadcasts `files.livePreviewConnectionChanged`, for its "Connected" line.
 */
import { EventType, type PluginViewBounds } from '../../shared/bridge'
import type { Emit } from '../bridge/events'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { CreateLivePreviewView, LivePreviewView } from './live-preview-views'

export interface LivePreviewViewsOptions {
  readonly emit: Emit
  /** Makes the view; none by default, where placing does nothing. */
  readonly createView?: CreateLivePreviewView
  readonly log?: Logger
}

export interface LivePreviewViews {
  /**
   * Shows `taskId`'s `url` over the viewer's body at `bounds`: while that URL's view is showing, straight away; the
   * first time (or for a different URL, destroying the last), after making the view. A later place (a resize, an
   * overlay's giving way) only moves the view, so its page keeps its state and doesn't reload: there's no file on
   * disk that could have changed while it was hidden, as the HTML preview's has, so nothing here reopens it fresh —
   * the viewer's Reload button is how a live page picks up a changed response.
   */
  place(taskId: string, url: string, bounds: PluginViewBounds): void
  /** Hides the view for `taskId`'s `url`, keeping its page; a no-op for a URL that isn't the one shown. */
  hide(taskId: string, url: string): void
  /** Reloads the page, if it's the one shown; a no-op otherwise. */
  reload(taskId: string, url: string): void
  /** Destroys the view, if there is one: the app is quitting. */
  close(): void
}

/** The view showing now, and whether this load has already told the window it's blocked. */
interface Shown {
  readonly taskId: string
  readonly url: string
  readonly view: LivePreviewView
  blockedNotified: boolean
}

export function createLivePreviewViews({
  emit,
  createView,
  log = SILENT_LOGGER,
}: LivePreviewViewsOptions): LivePreviewViews {
  let shown: Shown | null = null

  const destroy = (reason: string): void => {
    if (shown === null) return
    const { taskId, url, view } = shown
    shown = null
    view.destroy()
    log.info('live preview destroyed', { taskId, url, reason })
  }

  const open = (taskId: string, url: string): Shown | null => {
    if (createView === undefined) return null
    let current: Shown | null = null
    const view = createView({
      url,
      onBlocked: (host) => {
        if (current === null || current.blockedNotified) return
        current.blockedNotified = true
        emit({ type: EventType.LivePreviewBlocked, taskId, path: url, host })
      },
      onConnection: (connected) => {
        if (current === null || shown !== current) return
        emit({ type: EventType.LivePreviewConnectionChanged, taskId, path: url, connected })
      },
      onGone: () => {
        if (current !== null && shown === current) destroy('its page is gone')
      },
    })
    if (view === null) return null
    current = { taskId, url, view, blockedNotified: false }
    log.info('live preview created', { taskId, url })
    return current
  }

  return {
    place(taskId, url, bounds) {
      if (shown !== null && shown.taskId === taskId && shown.url === url) {
        shown.view.place(bounds)
        return
      }
      if (shown !== null) destroy('another file is shown')
      shown = open(taskId, url)
      shown?.view.place(bounds)
    },
    hide(taskId, url) {
      if (shown !== null && shown.taskId === taskId && shown.url === url) shown.view.hide()
    },
    reload(taskId, url) {
      if (shown?.taskId !== taskId || shown.url !== url) return
      shown.blockedNotified = false
      shown.view.reload()
    },
    close() {
      destroy('the app is quitting')
    },
  }
}
