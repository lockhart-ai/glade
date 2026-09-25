/** Helpers for the specs that drive a plugin's card and its native view in the bottom bar. */
import { cpSync, existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, pluginsFolder, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { settings } from './selectors'
import { boxOf } from './window-layout'

/** The e2e fixture plugin (e2e/plugins/fixture-plugin): it lists Glade's messages and says hello in its status. */
export const FIXTURE = resolve(__dirname, 'plugins', 'fixture-plugin')

/** Copies the fixture plugin into a data folder's plugins folder, as installing it does. */
export function installFixture(userData: string): void {
  cpSync(FIXTURE, join(pluginsFolder(userData), 'fixture-plugin'), { recursive: true })
}

/** The plugin's card beside the terminal, and its parts. */
export function pluginCard(glade: Glade) {
  const card = glade.window.getByRole('region', { name: 'Fixture' })
  return { card, status: card.getByTestId('plugin-status'), slot: card.getByTestId('plugin-view-slot') }
}

/** The plugin's view in the window, as main has it; null when there's none. */
export interface ViewState {
  readonly bounds: { x: number; y: number; width: number; height: number }
  readonly visible: boolean
  readonly url: string
  /** Whether its page's process runs in the OS sandbox, as Electron's process metrics have it. */
  readonly sandboxed: boolean | undefined
}

export async function pluginView({ app }: Glade): Promise<ViewState | null> {
  return app.evaluate(({ app: electronApp, BrowserWindow, WebContentsView }) => {
    const view = BrowserWindow.getAllWindows()[0]?.contentView.children.find(
      (child): child is Electron.WebContentsView => child instanceof WebContentsView,
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

/** Runs `code` in the plugin's page, as its own scripts would (its main world), and answers with what it resolves to. */
export async function inPlugin<T>({ app }: Glade, code: string): Promise<T> {
  return app.evaluate(async ({ webContents }, source) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('glade-plugin:'))
    if (page === undefined) throw new Error('No plugin page is running')
    return (await page.executeJavaScript(source)) as unknown
  }, code) as Promise<T>
}

/** The slot's box, rounded to whole points, as main places the view. */
export async function slotBounds(glade: Glade): Promise<ViewState['bounds']> {
  const box = await boxOf(pluginCard(glade).slot)
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.round(box.width),
    height: Math.round(box.height),
  }
}

/** Waits until the view is over its slot and showing. */
export async function expectViewOverSlot(glade: Glade): Promise<void> {
  await expect
    .poll(async () => {
      const view = await pluginView(glade)
      return view === null ? null : { bounds: view.bounds, visible: view.visible }
    })
    .toEqual({ bounds: await slotBounds(glade), visible: true })
}

/** The log's lines saying `msg`. */
export function logged({ logFile }: Glade, msg: string): Record<string, unknown>[] {
  if (!existsSync(logFile)) return []
  return readFileSync(logFile, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.msg === msg)
}

/** Opens Settings › Plugins, and waits until it has read the plugins folder. */
export async function openPlugins(glade: Glade): Promise<ReturnType<typeof settings>> {
  const modal = settings(glade.window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('Plugins').click()
  await expect(modal.plugins).toHaveAttribute('aria-busy', 'false')
  return modal
}
