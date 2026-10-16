/**
 * The Files viewer's shown HTML preview (#614): at most one, over the viewer's body, created the first time it's
 * placed and destroyed once a different file is shown (or the app is quitting). The file's folder on disk is resolved
 * (`resolveFile`) only when its view opens; every place after that goes straight to the view, in the order they came,
 * so a burst of resizes never leaves the view at stale bounds (#656). A request the sandboxed page makes for anything
 * but its own file is cancelled (`./html-preview-views`) and broadcasts `files.htmlPreviewBlocked`, once per load, for
 * the viewer's quiet "this preview is offline" notice.
 */
import { EventType, type PluginViewBounds } from '../../shared/bridge'
import type { Emit } from '../bridge/events'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import type { CreateHtmlPreviewView, HtmlPreviewView } from './html-preview-views'

/** The file to open a view on: its folder on disk (symlinks resolved) and its name within it. */
export interface HtmlPreviewFile {
  readonly folder: string
  readonly fileName: string
}

export interface HtmlPreviewViewsOptions {
  readonly emit: Emit
  /** Makes the view; none by default, where placing does nothing. */
  readonly createView?: CreateHtmlPreviewView
  /** Where the file lives on disk, resolved when its view opens; null when it isn't there (nor its workspace root). */
  readonly resolveFile: (taskId: string, path: string) => Promise<HtmlPreviewFile | null>
  readonly log?: Logger
}

export interface HtmlPreviewViews {
  /**
   * Shows `taskId`'s `path` over the viewer's body at `bounds`: while that file's view is showing, straight away; the
   * first time (or for a different file, destroying the last), once its folder on disk has resolved, in the order the
   * asks came — the newest one wins, so a burst never shows an ask that came before it.
   */
  place(taskId: string, path: string, bounds: PluginViewBounds): void
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

/** The newest place for a file whose view isn't showing yet: the open in flight acts on it, or gives up. */
interface Opening {
  readonly taskId: string
  readonly path: string
  readonly bounds: PluginViewBounds
}

export function createHtmlPreviewViews({
  emit,
  createView,
  resolveFile,
  log = SILENT_LOGGER,
}: HtmlPreviewViewsOptions): HtmlPreviewViews {
  let shown: Shown | null = null
  let opening: Opening | null = null
  /** The queued opens, one after another, so two files asked for together act on the newer ask alone. */
  let opens: Promise<void> = Promise.resolve()

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

  /** Opens the view for `opening`'s file once every open before it has finished, then places the newest bounds. */
  const drain = (): void => {
    opens = opens.then(async () => {
      const request = opening
      if (request === null) return
      let file: HtmlPreviewFile | null
      try {
        file = await resolveFile(request.taskId, request.path)
      } catch (error: unknown) {
        // Nothing opens, as for a missing file; the ask itself carries the failure back to the viewer's toast.
        log.warn("html preview's file didn't resolve", { taskId: request.taskId, path: request.path, error })
        return
      }
      // The file isn't there: the viewer's own notice already says so; nothing opens.
      if (file === null) return
      // While this resolved, a newer ask came for this file or another (or a hide gave up for it): it's the one
      // the next open acts on, with its own bounds.
      if (opening === null || opening !== request) return
      opening = null
      if (shown !== null && (shown.taskId !== request.taskId || shown.path !== request.path)) {
        destroy('another file is shown')
      }
      shown ??= open(request.taskId, request.path, file.folder, file.fileName)
      shown?.view.place(request.bounds)
    })
  }

  return {
    place(taskId, path, bounds) {
      // That file's view is showing already: its bounds go straight through, in the order they came, so the view is
      // never left at stale ones after a burst of resizes (#656). Only an open waits on the file's folder on disk.
      if (shown !== null && shown.taskId === taskId && shown.path === path) {
        shown.view.place(bounds)
        return
      }
      opening = { taskId, path, bounds }
      drain()
    },
    hide(taskId, path) {
      if (shown !== null && shown.taskId === taskId && shown.path === path) shown.view.hide()
      // An open for this file that hasn't resolved yet gives up too: the slot is gone (the file closed, an overlay
      // came over it). If its resolve has come back already, the next open acts on whatever was asked last.
      if (opening !== null && opening.taskId === taskId && opening.path === path) opening = null
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
