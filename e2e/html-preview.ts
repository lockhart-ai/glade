/**
 * Helpers for the specs that drive the Files viewer's HTML preview and its native view (#614). Mirrors
 * `./plugin-view.ts`, which does the same for a plugin's view.
 */
import { expect, type Glade } from './fixtures'
import { inMain } from './in-main'
import { filesTab } from './selectors'
import { boxOf } from './window-layout'

/** Every page whose URL is the preview's scheme, in any window; at most one at a time. */
export async function htmlPreviewPages({ app }: Glade): Promise<number> {
  return inMain(
    app,
    ({ webContents }) =>
      webContents.getAllWebContents().filter((page) => page.getURL().startsWith('glade-html-preview:')).length,
  )
}

/** The preview's view in the window, as main has it; null when there's none. */
export interface PreviewViewState {
  readonly bounds: { x: number; y: number; width: number; height: number }
  readonly visible: boolean
  readonly url: string
  /** Whether its page's process runs in the OS sandbox, as Electron's process metrics have it. */
  readonly sandboxed: boolean | undefined
}

export async function htmlPreviewView({ app }: Glade): Promise<PreviewViewState | null> {
  return inMain(app, ({ app: electronApp, BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
      (child): child is Electron.WebContentsView =>
        child instanceof WebContentsView && child.webContents.getURL().startsWith('glade-html-preview:'),
    )
    if (view === undefined) return null
    const pid = view.webContents.getOSProcessId()
    return {
      bounds: view.getBounds(),
      visible: view.getVisible(),
      url: view.webContents.getURL(),
      sandboxed: electronApp.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed,
    }
  })
}

/** The slot's box, rounded to whole points, as main places the view. */
export async function slotBounds(glade: Glade): Promise<PreviewViewState['bounds']> {
  const box = await boxOf(filesTab(glade.window).htmlPreviewSlot)
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

/** Waits until the preview's view is over its slot and showing. */
export async function expectPreviewOverSlot(glade: Glade): Promise<void> {
  await expect
    .poll(async () => {
      const view = await htmlPreviewView(glade)
      return view === null ? null : { bounds: view.bounds, visible: view.visible }
    })
    .toEqual({ bounds: await slotBounds(glade), visible: true })
}

/** Runs `code` in the preview's page, as its own scripts would, and answers with what it resolves to. */
export async function inHtmlPreview<T>({ app }: Glade, code: string): Promise<T> {
  return inMain(
    app,
    async ({ webContents }, source) => {
      const page = webContents
        .getAllWebContents()
        .find((contents) => contents.getURL().startsWith('glade-html-preview:'))
      if (page === undefined) throw new Error('No preview page is running')
      return (await page.executeJavaScript(source)) as unknown
    },
    code,
  ) as Promise<T>
}
