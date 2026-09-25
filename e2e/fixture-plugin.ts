// The e2e fixture plugin (e2e/plugins/fixture-plugin), shared by the plugin specs: it lists what Glade sends it (and
// keeps it in `window.received`), and says hello back in its status.
import { cpSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pluginsFolder, type Glade } from './fixtures'

export const FIXTURE_PLUGIN = resolve(__dirname, 'plugins', 'fixture-plugin')

/** Copies the fixture plugin into a data folder's plugins folder, as installing it does. */
export function installFixture(userData: string): void {
  cpSync(FIXTURE_PLUGIN, join(pluginsFolder(userData), 'fixture-plugin'), { recursive: true })
}

/** Runs `code` in the plugin's page, as its own scripts would (its main world), and answers with what it resolves to. */
export async function inPlugin<T>({ app }: Glade, code: string): Promise<T> {
  return app.evaluate(async ({ webContents }, source) => {
    const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('glade-plugin:'))
    if (page === undefined) throw new Error('No plugin page is running')
    return (await page.executeJavaScript(source)) as unknown
  }, code) as Promise<T>
}
