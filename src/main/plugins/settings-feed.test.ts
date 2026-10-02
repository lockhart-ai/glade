// A plugin's settings end to end in main (#435): plugins in a plugins folder behind the real bridge, over IPC, with the
// real feed and database. A plugin that declares a select gets its value in its snapshot; choosing another in Settings
// (`plugins.setSetting`) saves it and tells the running page (`settings.changed`) without reloading it; the choice is
// still there for a new bridge over the same database (a relaunch) and after the plugin is updated on disk.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import { PluginEventType, type PluginEvent } from '../../shared/plugin-api'
import { gladeMessageSchema } from '../../shared/plugin-api-schema'
import { PluginStatus } from '../../shared/plugins'
import { registerBridge, type RegisteredBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { FakeAgentBackend } from '../agent/fake-backend'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { createFakePluginViews, type FakePluginViews } from './fake-view'
import { sampleManifest, tempPluginsParent, writePlugin } from './test-plugins'

const bounds = { x: 0, y: 0, width: 600, height: 250 }

const STYLE = {
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

/** One launch of Glade over the test's database and plugins folder. */
interface Launch {
  readonly glade: GladeBridge
  readonly bridge: RegisteredBridge
  readonly views: FakePluginViews
}

let database: TestDatabase
let pluginsParent: string
let pluginsFolder: string
let launches: Launch[]

function writeEasel(settings: unknown = [STYLE], version = '1.0.0'): void {
  writePlugin(pluginsFolder, 'easel', { ...sampleManifest('easel'), name: 'Easel', version, settings })
}

async function launch(): Promise<Launch> {
  const views = createFakePluginViews()
  const ipc = fakeIpcPair()
  const bridge = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder,
    createPluginView: views.create,
    appVersion: '0.20.0',
    agentBackend: new FakeAgentBackend(),
  })
  const glade = createBridge(ipc.renderer)
  await glade.invoke(CommandName.PluginsList, {})
  const started = { glade, bridge, views }
  launches.push(started)
  return started
}

beforeEach(() => {
  database = openTestDatabase()
  pluginsParent = tempPluginsParent()
  pluginsFolder = join(pluginsParent, 'plugins')
  launches = []
  // `easel` declares a select, and is the one shown (the first by id); `pomodoro` declares nothing.
  writeEasel()
  writePlugin(pluginsFolder, 'pomodoro')
})

afterEach(() => {
  for (const { bridge } of launches) {
    bridge.runner.close()
    bridge.pluginViews.close()
  }
  database.close()
  rmSync(pluginsParent, { recursive: true, force: true })
})

/** Everything the last view's page was sent, each checked against the plugin API's schema. */
function events({ views }: Launch): PluginEvent[] {
  return views.last().sent.map((message) => gladeMessageSchema.parse(message).event)
}

/** Shows `id`, has its page say `ready`, and waits for its snapshot. */
async function show(started: Launch, id: string): Promise<void> {
  await started.glade.invoke(CommandName.PluginsPlaceView, { id, bounds })
  started.views.last().post({ type: 'ready' })
  await vi.waitFor(() => {
    expect(events(started).map(({ type }) => type)).toContain(PluginEventType.Snapshot)
  })
}

it('hands a plugin its default in the snapshot, then each change as an event, in the page it already has', async () => {
  const first = await launch()
  await show(first, 'easel')
  expect(events(first)[1]).toMatchObject({ type: PluginEventType.Snapshot, settings: { style: 'ink' } })
  const page = first.views.last()

  const { plugins } = await first.glade.invoke(CommandName.PluginsSetSetting, {
    id: 'easel',
    key: 'style',
    value: 'chalk',
  })

  expect(plugins).toMatchObject([
    { folder: 'easel', settings: { style: 'chalk' } },
    { folder: 'pomodoro', settings: {} },
  ])
  expect(first.views.last()).toBe(page)
  expect(page.destroyed).toBe(false)
  expect(events(first).slice(2)).toEqual([{ type: PluginEventType.SettingsChanged, settings: { style: 'chalk' } }])
})

it('keeps the choice across a relaunch and an update of the plugin, and falls back once it is no longer offered', async () => {
  const first = await launch()
  await first.glade.invoke(CommandName.PluginsSetSetting, { id: 'easel', key: 'style', value: 'neon' })

  // A relaunch: a new bridge over the same database.
  const second = await launch()
  await show(second, 'easel')
  expect(events(second)[1]).toMatchObject({ settings: { style: 'neon' } })

  // A new build that still offers it keeps it; the page it reloads into is told so in its snapshot.
  writeEasel([{ ...STYLE, options: [...STYLE.options, { value: 'oil', label: 'Oil' }] }], '1.1.0')
  await second.glade.invoke(CommandName.PluginsList, {})
  second.views.last().post({ type: 'ready' })
  await vi.waitFor(() => {
    expect(events(second)[1]).toMatchObject({ settings: { style: 'neon' } })
  })

  // One that drops it falls back to its default, for the page and for Settings alike.
  writeEasel([{ ...STYLE, options: STYLE.options.slice(0, 2), default: 'chalk' }], '2.0.0')
  const { plugins } = await second.glade.invoke(CommandName.PluginsList, {})
  expect(plugins).toMatchObject([{ folder: 'easel', settings: { style: 'chalk' } }, { folder: 'pomodoro' }])
  second.views.last().post({ type: 'ready' })
  await vi.waitFor(() => {
    expect(events(second)[1]).toMatchObject({ settings: { style: 'chalk' } })
  })
})

it('gives a plugin that declares no settings exactly what it got before: no settings field, no event', async () => {
  rmSync(join(pluginsFolder, 'easel'), { recursive: true })
  const started = await launch()
  await show(started, 'pomodoro')

  expect(events(started).map(({ type }) => type)).toEqual([PluginEventType.Hello, PluginEventType.Snapshot])
  expect(events(started)[1]).not.toHaveProperty('settings')
  await expect(
    started.glade.invoke(CommandName.PluginsSetSetting, { id: 'pomodoro', key: 'style', value: 'ink' }),
  ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
  expect(events(started)).toHaveLength(2)
})

it("never shows one plugin another's values: the shown plugin hears nothing of a change to another", async () => {
  writePlugin(pluginsFolder, 'sketchpad', { ...sampleManifest('sketchpad'), settings: [STYLE] })
  const started = await launch()
  await show(started, 'easel')

  await started.glade.invoke(CommandName.PluginsSetSetting, { id: 'sketchpad', key: 'style', value: 'neon' })

  expect(events(started)).toHaveLength(2)
  expect(JSON.stringify(started.views.last().sent)).not.toContain('neon')
  const { plugins } = await started.glade.invoke(CommandName.PluginsList, {})
  expect(
    plugins.flatMap((plugin) => (plugin.status === PluginStatus.Valid ? [[plugin.folder, plugin.settings]] : [])),
  ).toEqual([
    ['easel', { style: 'ink' }],
    ['pomodoro', {}],
    ['sketchpad', { style: 'neon' }],
  ])
})

it('refuses a value the setting does not offer, saving and sending nothing', async () => {
  const started = await launch()
  await show(started, 'easel')

  await expect(
    started.glade.invoke(CommandName.PluginsSetSetting, { id: 'easel', key: 'style', value: 'oil' }),
  ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })

  expect(events(started)).toHaveLength(2)
  expect(database.db.prepare('SELECT COUNT(*) FROM plugin_settings').pluck().get()).toBe(0)
})
