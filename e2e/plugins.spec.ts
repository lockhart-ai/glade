import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inPlugin, installFixture } from './fixture-plugin'
import { expect, openedInEditor, pluginsFolder, test, type Glade } from './fixtures'
import { chooseMenuItem } from './menu'
import { pluginCard } from './plugin-view'
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

/** How many plugin pages are running, in any window or none: 0 while a reloaded view is being remade. */
async function pluginPages({ app }: Glade): Promise<number> {
  return app.evaluate(
    ({ webContents }) =>
      webContents.getAllWebContents().filter((page) => page.getURL().startsWith('glade-plugin:')).length,
  )
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

test('reloads a running plugin whose files changed since Glade last read the folder, but not one that did not', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch()
  const { status } = pluginCard(glade)
  await expect(status).toHaveText(/said hello$/)
  expect(await inPlugin(glade, 'window.received.length')).toBe(2)

  // Rescanning (Settings › Plugins opening) with nothing changed on disk leaves the running page alone.
  const unchanged = await openPlugins(glade)
  await unchanged.close.click()
  expect(await inPlugin(glade, 'window.received.length')).toBe(2)

  // A new build copied in over it: its entry file changes on disk.
  const entry = join(pluginsFolder(userData), 'fixture-plugin', 'index.html')
  writeFileSync(entry, readFileSync(entry, 'utf8').replace('Messages from Glade', 'Messages from Glade v2'))
  const changed = await openPlugins(glade)
  await changed.close.click()

  // The page reloaded on its own: a fresh window, freshly greeted, showing the new markup.
  await expect.poll(() => pluginPages(glade)).toBe(1)
  await expect.poll(() => inPlugin(glade, 'window.received.length')).toBe(2)
  expect(await inPlugin(glade, 'document.querySelector("h1").textContent')).toBe('Messages from Glade v2')
  await expect(status).toHaveText(/said hello$/)
})

test('the Reload button reloads the shown plugin at once, without reading the folder again', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const glade = await launch()
  const { status } = pluginCard(glade)
  await expect(status).toHaveText(/said hello$/)
  // Past the first greeting, so a reload shows up as the count resetting, not merely growing.
  await inPlugin(glade, "window.glade.post({ type: 'ready' })")
  await expect.poll(() => inPlugin(glade, 'window.received.length')).toBe(4)

  const modal = await openPlugins(glade)
  await modal.reloadPlugin('Fixture').click()
  await modal.close.click()

  await expect.poll(() => pluginPages(glade)).toBe(1)
  await expect.poll(() => inPlugin(glade, 'window.received.length')).toBe(2)
  await expect(status).toHaveText(/said hello$/)
})

/** The kinds of event the fixture plugin's page has been sent since its last `hello`. */
async function receivedTypes(glade: Glade): Promise<string[]> {
  return inPlugin(glade, 'window.received.map((message) => message.event.type)')
}

test("a plugin that asks to see the Mac's load gets it only once its switch is on, and keeps it across a relaunch", async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  const manifest = join(pluginsFolder(userData), 'fixture-plugin', 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), capabilities: ['machine'] }))
  const glade = await launch()
  const { status } = pluginCard(glade)
  await expect(status).toHaveText(/said hello$/)

  // Off until it's turned on: nothing new reaches the page.
  const modal = await openPlugins(glade)
  await expect(modal.plugin('Fixture')).toContainText("Can see your Mac's CPU, GPU and Docker load")
  await expect(modal.machineSwitch('Fixture')).not.toBeChecked()
  expect(await inPlugin(glade, "'machine' in window.received[1].event")).toBe(false)

  // On: the plugin starts over, with the readings in its snapshot and then one every 2 s (the test mode's fake Mac),
  // once it's showing again: Settings covers it, and a covered plugin isn't showing, so nothing is sampled for it.
  await modal.machineSwitch('Fixture').click()
  await expect(modal.machineSwitch('Fixture')).toBeChecked()
  await modal.close.click()
  await expect.poll(() => pluginPages(glade)).toBe(1)
  await expect(status).toHaveText(/said hello$/)
  await expect.poll(() => receivedTypes(glade), { timeout: 10_000 }).toContain('machine.reading')
  const [first] = await receivedTypes(glade)
  expect(first).toBe('hello')
  expect(await inPlugin(glade, 'Array.isArray(window.received[1].event.machine)')).toBe(true)
  const reading = await inPlugin<Record<string, unknown>>(
    glade,
    "window.received.find((message) => message.event.type === 'machine.reading').event.reading",
  )
  expect(reading).toMatchObject({ cpuCount: 10, total: 7.3, claude: 4.6, docker: 1.4, gpu: 88 })
  expect(reading.containers).toHaveLength(4)

  // A relaunch keeps it on: the readings come without touching Settings.
  await glade.close()
  const relaunched = await launch()
  await expect(pluginCard(relaunched).status).toHaveText(/said hello$/)
  await expect.poll(() => receivedTypes(relaunched), { timeout: 10_000 }).toContain('machine.reading')

  // Off again: the plugin starts over without them, and none follow.
  const again = await openPlugins(relaunched)
  await again.machineSwitch('Fixture').click()
  await expect(again.machineSwitch('Fixture')).not.toBeChecked()
  await again.close.click()
  await expect.poll(() => pluginPages(relaunched)).toBe(1)
  await expect(pluginCard(relaunched).status).toHaveText(/said hello$/)
  await expect.poll(() => receivedTypes(relaunched)).toEqual(['hello', 'snapshot'])
  expect(await inPlugin(relaunched, "'machine' in window.received[1].event")).toBe(false)
})

/** A made-up select setting for the fixture plugin's manifest. */
const ART_STYLE = {
  key: 'style',
  label: 'Art style',
  type: 'select',
  options: [
    { value: 'ink', label: 'Ink' },
    { value: 'chalk', label: 'Chalk' },
    { value: 'neon', label: 'Neon' },
  ],
  default: 'ink',
}

/** Rewrites the installed fixture plugin's manifest with `fields` over what it has. */
function editFixtureManifest(userData: string, fields: Record<string, unknown>): void {
  const manifest = join(pluginsFolder(userData), 'fixture-plugin', 'manifest.json')
  writeFileSync(manifest, JSON.stringify({ ...JSON.parse(readFileSync(manifest, 'utf8')), ...fields }))
}

test('a plugin that declares a select setting shows it in Plugins, gets the value chosen without reloading, and keeps it across a relaunch and an update', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  editFixtureManifest(userData, { settings: [ART_STYLE, { key: 'sound', label: 'Sound', type: 'toggle' }] })
  const glade = await launch()
  const { status } = pluginCard(glade)
  await expect(status).toHaveText(/said hello$/)

  // Its snapshot has every setting it declares that Glade knows, at its default.
  await expect.poll(() => receivedTypes(glade)).toEqual(['hello', 'snapshot'])
  expect(await inPlugin(glade, 'window.received[1].event.settings')).toEqual({ style: 'ink' })

  // Settings › Plugins shows it under the plugin, with the default chosen and its options in order; a setting of a
  // type Glade doesn't know isn't shown.
  const modal = await openPlugins(glade)
  const select = modal.pluginSetting('Fixture', 'Art style')
  await expect(modal.plugin('Fixture')).toContainText('Art style')
  await expect(modal.plugin('Fixture')).not.toContainText('Sound')
  await expect(select).toHaveText('Ink')
  await select.click()
  const options = glade.window.getByRole('menu', { name: 'Art style' }).getByRole('menuitemradio')
  await expect(options).toHaveText(['Ink', 'Chalk', 'Neon'])
  await expect(options.nth(0)).toBeChecked()

  // Choosing another reaches the page it already has, as an event with all its settings: no reload, no new snapshot.
  await options.nth(1).click()
  await expect(select).toHaveText('Chalk')
  await expect.poll(() => receivedTypes(glade)).toEqual(['hello', 'snapshot', 'settings.changed'])
  expect(await inPlugin(glade, 'window.received[2].event')).toEqual({
    type: 'settings.changed',
    settings: { style: 'chalk' },
  })
  expect(await inPlugin(glade, 'window.received[2].seq')).toBe(3)
  expect(await pluginPages(glade)).toBe(1)
  await modal.close.click()

  // A relaunch keeps it: in Settings, and in the snapshot the page starts from.
  await glade.close()
  const relaunched = await launch()
  await expect(pluginCard(relaunched).status).toHaveText(/said hello$/)
  await expect.poll(() => receivedTypes(relaunched)).toEqual(['hello', 'snapshot'])
  expect(await inPlugin(relaunched, 'window.received[1].event.settings')).toEqual({ style: 'chalk' })
  const again = await openPlugins(relaunched)
  await expect(again.pluginSetting('Fixture', 'Art style')).toHaveText('Chalk')
  await again.close.click()

  // An update that still offers it keeps it too (the new build reloads into it).
  editFixtureManifest(userData, {
    version: '1.1.0',
    settings: [{ ...ART_STYLE, options: [...ART_STYLE.options, { value: 'oil', label: 'Oil' }] }],
  })
  const updated = await openPlugins(relaunched)
  await expect(updated.plugin('Fixture')).toContainText('1.1.0')
  await expect(updated.pluginSetting('Fixture', 'Art style')).toHaveText('Chalk')
  await updated.close.click()
  await expect.poll(() => pluginPages(relaunched)).toBe(1)
  await expect.poll(() => receivedTypes(relaunched)).toEqual(['hello', 'snapshot'])
  expect(await inPlugin(relaunched, 'window.received[1].event.settings')).toEqual({ style: 'chalk' })

  // One that no longer offers it falls back to the new default.
  editFixtureManifest(userData, {
    version: '2.0.0',
    settings: [{ ...ART_STYLE, options: [ART_STYLE.options[0], ART_STYLE.options[2]], default: 'neon' }],
  })
  const dropped = await openPlugins(relaunched)
  await expect(dropped.plugin('Fixture')).toContainText('2.0.0')
  await expect(dropped.pluginSetting('Fixture', 'Art style')).toHaveText('Neon')
  await dropped.close.click()
  await expect.poll(() => pluginPages(relaunched)).toBe(1)
  await expect.poll(() => inPlugin(relaunched, 'window.received[1]?.event.settings')).toEqual({ style: 'neon' })
})

test('a plugin whose settings are malformed is listed as invalid with why, and one without settings has no select and no settings field', async ({
  launch,
  userData,
}) => {
  installFixture(userData)
  install(userData, 'valid', 'pomodoro')
  const pomodoro = join(pluginsFolder(userData), 'pomodoro', 'manifest.json')
  writeFileSync(
    pomodoro,
    JSON.stringify({ ...JSON.parse(readFileSync(pomodoro, 'utf8')), settings: [{ ...ART_STYLE, default: 'oil' }] }),
  )
  const glade = await launch()
  await expect(pluginCard(glade).status).toHaveText(/said hello$/)
  const modal = await openPlugins(glade)

  await expect(modal.plugin('pomodoro')).toContainText('settings.0.default: Expected one of the option values')
  await expect(modal.plugin('Fixture')).toBeVisible()
  await expect(modal.plugin('Fixture').getByRole('button')).toHaveCount(1)
  await expect.poll(() => receivedTypes(glade)).toEqual(['hello', 'snapshot'])
  expect(await inPlugin(glade, "'settings' in window.received[1].event")).toBe(false)
})

test("a plugin that doesn't ask to see the Mac's load has no switch for it", async ({ launch, userData }) => {
  installFixture(userData)
  const glade = await launch()
  const modal = await openPlugins(glade)

  await expect(modal.plugin('Fixture')).toBeVisible()
  await expect(modal.plugin('Fixture')).not.toContainText("Can see your Mac's")
  await expect(modal.plugin('Fixture').getByRole('switch')).toHaveCount(1)
})
