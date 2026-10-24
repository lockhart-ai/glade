/**
 * Helpers for the specs that drive the Files viewer's live preview and its native view (#764). Mirrors
 * `./html-preview.ts`, which does the same for the offline HTML preview; the difference is that a live preview's page
 * loads its own real URL straight (no fixed scheme to match it by), so these take the URL (or its host) to find it by.
 */
import { expect, type Glade } from './fixtures'
import { inMain } from './in-main'
import { filesTab } from './selectors'
import { boxOf } from './window-layout'

/** Every page whose URL starts with `prefix`, in any window; at most one live preview shows at a time. */
export async function livePreviewPages({ app }: Glade, prefix: string): Promise<number> {
  return inMain(
    app,
    ({ webContents }, urlPrefix) =>
      webContents.getAllWebContents().filter((page) => page.getURL().startsWith(urlPrefix)).length,
    prefix,
  )
}

/** The preview's view in the window, as main has it; null when there's none. */
export interface LivePreviewViewState {
  readonly bounds: { x: number; y: number; width: number; height: number }
  readonly visible: boolean
  readonly url: string
  /** Whether its page's process runs in the OS sandbox, as Electron's process metrics have it. */
  readonly sandboxed: boolean | undefined
}

/** The live preview's view whose URL starts with `prefix`; null when there's none. */
export async function livePreviewView({ app }: Glade, prefix: string): Promise<LivePreviewViewState | null> {
  return inMain(
    app,
    ({ app: electronApp, BrowserWindow, WebContentsView }, urlPrefix) => {
      const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
        (child): child is Electron.WebContentsView =>
          child instanceof WebContentsView && child.webContents.getURL().startsWith(urlPrefix),
      )
      if (view === undefined) return null
      const pid = view.webContents.getOSProcessId()
      return {
        bounds: view.getBounds(),
        visible: view.getVisible(),
        url: view.webContents.getURL(),
        sandboxed: electronApp.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed,
      }
    },
    prefix,
  )
}

/** The slot's box, rounded to whole points, as main places the view. */
export async function liveSlotBounds(glade: Glade): Promise<LivePreviewViewState['bounds']> {
  const box = await boxOf(filesTab(glade.window).livePreviewSlot)
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

/** Waits until the live preview's view (whose URL starts with `prefix`) is over its slot and showing. */
export async function expectLivePreviewOverSlot(glade: Glade, prefix: string): Promise<void> {
  await expect
    .poll(async () => {
      const view = await livePreviewView(glade, prefix)
      return view === null ? null : { bounds: view.bounds, visible: view.visible }
    })
    .toEqual({ bounds: await liveSlotBounds(glade), visible: true })
}

/** Runs `code` in the live preview's page (whose URL starts with `prefix`), and answers with what it resolves to. */
export async function inLivePreview<T>({ app }: Glade, prefix: string, code: string): Promise<T> {
  return inMain(
    app,
    async ({ webContents }, { urlPrefix, source }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(urlPrefix))
      if (page === undefined) throw new Error('No live preview page is running')
      return (await page.executeJavaScript(source)) as unknown
    },
    { urlPrefix: prefix, source: code },
  ) as Promise<T>
}
