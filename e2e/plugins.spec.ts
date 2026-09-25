import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, openedInEditor, pluginsFolder, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { settings } from './selectors'

/** The sample plugins in scripts/fixtures/plugins: `valid` (Pomodoro, Tide Clock) and `invalid`. */
const FIXTURES = resolve(__dirname, '..', 'scripts', 'fixtures', 'plugins')

/** Copies a sample plugin into a data folder's plugins folder, as installing it does. */
function install(userData: string, kind: 'valid' | 'invalid', id: string): void {
  cpSync(join(FIXTURES, kind, id), join(pluginsFolder(userData), id), { recursive: true })
}

/** Opens Settings › Plugins, and waits until it has read the plugins folder. */
async function openPlugins(glade: Glade): Promise<ReturnType<typeof settings>> {
  const modal = settings(glade.window)
  await chooseMenuItem(glade, 'Glade', 'Settings…')
  await modal.section('Plugins').click()
  await expect(modal.heading).toHaveText('Plugins')
  await expect(modal.plugins).toHaveAttribute('aria-busy', 'false')
  return modal
}

test('a plugin in the plugins folder is listed with its name, version and icon, and stays off across a relaunch', async ({
  launch,
  userData,
}) => {
  install(userData, 'valid', 'pomodoro')
  const glade = await launch()
  const modal = await openPlugins(glade)

  // Found for the first time, it's on.
  const pomodoro = modal.plugin('Pomodoro')
  await expect(pomodoro).toContainText('Pomodoro0.4.2')
  await expect(pomodoro.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/)
  await expect(modal.toggle('Pomodoro')).toBeChecked()

  await modal.toggle('Pomodoro').click()
  await expect(modal.toggle('Pomodoro')).not.toBeChecked()

  // A relaunch keeps it off.
  await glade.close()
  const relaunched = await launch()
  const again = await openPlugins(relaunched)
  await expect(again.toggle('Pomodoro')).not.toBeChecked()

  // And back on, which a relaunch keeps too.
  await again.toggle('Pomodoro').click()
  await expect(again.toggle('Pomodoro')).toBeChecked()
  await relaunched.close()
  const third = await launch()
  await expect((await openPlugins(third)).toggle('Pomodoro')).toBeChecked()
})

test('Plugins lists invalid plugins with why, finds plugins added and removed while Glade runs, and opens the folder', async ({
  launch,
  userData,
}) => {
  // There's no plugins folder yet: Glade makes it, and there's nothing in it.
  const glade = await launch()
  const modal = await openPlugins(glade)
  await expect(modal.dialog).toContainText('No plugins installed.')
  expect(existsSync(pluginsFolder(userData))).toBe(true)

  // Plugins copied in while Glade runs show up the next time Plugins opens: a valid one, and invalid ones.
  await modal.close.click()
  install(userData, 'valid', 'pomodoro')
  install(userData, 'invalid', 'weather-strip')
  install(userData, 'invalid', 'notes-panel')
  const escaping = join(pluginsFolder(userData), 'escape-hatch')
  mkdirSync(escaping)
  writeFileSync(
    join(escaping, 'manifest.json'),
    JSON.stringify({ id: 'escape-hatch', name: 'Escape Hatch', version: '1.0.0', entry: '../pomodoro/index.html' }),
  )
  await openPlugins(glade)

  await expect(modal.plugins.getByRole('listitem')).toHaveCount(4)
  await expect(modal.dialog).not.toContainText('No plugins installed.')
  await expect(modal.plugin('weather-strip')).toContainText("entry: Expected a path inside the plugin's folder")
  await expect(modal.plugin('escape-hatch')).toContainText("entry: Expected a path inside the plugin's folder")
  await expect(modal.plugin('notes-panel')).toContainText('No manifest.json')
  await expect(modal.plugins.getByRole('switch')).toHaveCount(1)
  await modal.toggle('Pomodoro').click()
  await expect(modal.toggle('Pomodoro')).not.toBeChecked()

  // Removed while Glade runs, it's gone the next time Plugins opens; put back, it's as it was.
  await modal.close.click()
  rmSync(join(pluginsFolder(userData), 'pomodoro'), { recursive: true })
  await openPlugins(glade)
  await expect(modal.plugin('Pomodoro')).toBeHidden()
  await expect(modal.plugins.getByRole('listitem')).toHaveCount(3)
  await modal.close.click()
  install(userData, 'valid', 'pomodoro')
  await openPlugins(glade)
  await expect(modal.toggle('Pomodoro')).not.toBeChecked()

  // Open plugins folder opens it in Finder (recorded in its place: an e2e run never opens Finder).
  await modal.openPluginsFolder.click()
  await expect.poll(() => openedInEditor(glade)).toEqual([pluginsFolder(userData)])
})
