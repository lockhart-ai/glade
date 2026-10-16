/**
 * The Files viewer's shown HTML preview (#614): at most one, over the viewer's body, created the first time it's
 * placed and destroyed once a different file is shown (or the app is quitting). A request the sandboxed page makes
 * for anything but its own file is cancelled (`./html-preview-views`) and broadcasts `files.htmlPreviewBlocked`, once
 * per load, for the viewer's quiet "this preview is offline" notice.
 */
import { EventType, type PluginViewBounds } from '../../shared/bridge'
import type { Emit } from '../bridge/events'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { CreateHtmlPreviewView, HtmlPreviewView } from './html-preview-views'

export interface HtmlPreviewViewsOptions {
  readonly emit: Emit
  /** Makes the view; none by default, where placing does nothing. */
  readonly createView?: CreateHtmlPreviewView
  readonly log?: Logger
}

export interface HtmlPreviewViews {
  /**
   * Shows `taskId`'s `path` over the viewer's body at `bounds`, its file at `fileName` in `folder`: makes the view
   * the first time, or when a different file was shown (destroying that one). With `reopen`, this is the preview's
   * first show for a fresh showing of the viewer (the tab was closed, or the file shows again): the view kept may
   * hold this file's page from before, with the file since changed on disk, so it's reloaded fresh from disk. A
   * later place (a resize, an overlay's giving way) only moves the view, so its page keeps its state.
   */
  place(
    taskId: string,
    path: string,
    folder: string,
    fileName: string,
    bounds: PluginViewBounds,
    reopen?: boolean,
  ): void
  /** Hides the view for `taskId`'s `path`, keeping its page; a no-op for a file that isn't the one shown. */
  hide(taskId: string, path: string): void
  /** Reloads the file fresh from disk, if it's the one shown; a no-op otherwise. */
  reload(taskId: string, path: string): void
  /** Destroys the view, if there is one: the app is quitting. */
  close(): void
}

/** The view showing now, and whether this load has already told the window it's blocked. */
interface Shown {
  readonly taskId: string
  readonly path: string
  readonly view: HtmlPreviewView
  blockedNotified: boolean
}

export function createHtmlPreviewViews({
  emit,
  createView,
  log = SILENT_LOGGER,
}: HtmlPreviewViewsOptions): HtmlPreviewViews {
  let shown: Shown | null = null

  const destroy = (reason: string): void => {
    if (shown === null) return
    const { taskId, path, view } = shown
    shown = null
    view.destroy()
    log.info('html preview destroyed', { taskId, path, reason })
  }

  const open = (taskId: string, path: string, folder: string, fileName: string): Shown | null => {
    if (createView === undefined) return null
    let current: Shown | null = null
    const view = createView({
      folder,
      fileName,
      onBlocked: () => {
        if (current === null || current.blockedNotified) return
        current.blockedNotified = true
        emit({ type: EventType.HtmlPreviewBlocked, taskId, path })
      },
      onGone: () => {
        if (current !== null && shown === current) destroy('its page is gone')
      },
    })
    if (view === null) return null
    current = { taskId, path, view, blockedNotified: false }
    log.info('html preview created', { taskId, path })
    return current
  }

  return {
    place(taskId, path, folder, fileName, bounds, reopen = false) {
      if (shown !== null && (shown.taskId !== taskId || shown.path !== path)) destroy('another file is shown')
      if (shown !== null && reopen) {
        // The view already holds this file's page, from before it was hidden: reload it fresh from disk, since the
        // file may have changed on disk while it wasn't showing. A new page means the blocked notice can recur.
        shown.blockedNotified = false
        shown.view.reload()
      }
      shown ??= open(taskId, path, folder, fileName)
      shown?.view.place(bounds)
    },
    hide(taskId, path) {
      if (shown !== null && shown.taskId === taskId && shown.path === path) shown.view.hide()
    },
    reload(taskId, path) {
      if (shown?.taskId !== taskId || shown.path !== path) return
      shown.blockedNotified = false
      shown.view.reload()
    },
    close() {
      destroy('the app is quitting')
    },
  }
}
