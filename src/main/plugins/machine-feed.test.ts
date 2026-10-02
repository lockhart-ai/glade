// The machine's readings end to end in main (#403): plugins in a plugins folder behind the real bridge, over IPC, with
// the fake machine and fake timers. Turning the capability on in Settings (`plugins.setCapability`) reloads the plugin,
// whose new page then gets the readings every 2 s; with it off, or not asked for, a plugin gets nothing new, and the
// monitor only samples while such a plugin is showing.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
  PluginEventType,
  type PluginEvent,
  type PluginMachineReading,
  type PluginSnapshotEvent,
} from '../../shared/plugin-api'
import { gladeMessageSchema } from '../../shared/plugin-api-schema'
import { PluginCapability } from '../../shared/plugins'
import { registerBridge, type RegisteredBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { FakeAgentBackend } from '../agent/fake-backend'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { createFakePluginViews, type FakePluginViews } from './fake-view'
import { MACHINE_SAMPLE_INTERVAL_MS } from './machine'
import { createFakeMachineSamplers, FAKE_CONTAINERS, FAKE_CPU_COUNT, FAKE_GPU } from './machine-fake'
import { sampleManifest, tempPluginsParent, writePlugin } from './test-plugins'

const bounds = { x: 0, y: 0, width: 600, height: 250 }

let database: TestDatabase
let glade: GladeBridge
let bridge: RegisteredBridge
let views: FakePluginViews
let pluginsParent: string

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  database = openTestDatabase()
  pluginsParent = tempPluginsParent()
  const pluginsFolder = join(pluginsParent, 'plugins')
  // `gauge` asks for the machine's readings, and is the one shown (the first by id); `pomodoro` doesn't ask.
  writePlugin(pluginsFolder, 'gauge', { ...sampleManifest('gauge'), capabilities: ['machine'] })
  writePlugin(pluginsFolder, 'pomodoro')
  views = createFakePluginViews()
  const ipc = fakeIpcPair()
  bridge = registerBridge({
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
    machineSamplers: createFakeMachineSamplers(),
    appVersion: '0.19.0',
    agentBackend: new FakeAgentBackend(),
  })
  glade = createBridge(ipc.renderer)
  await glade.invoke(CommandName.PluginsList, {})
})

afterEach(() => {
  bridge.runner.close()
  bridge.pluginViews.close()
  bridge.machine?.close()
  database.close()
  rmSync(pluginsParent, { recursive: true, force: true })
  vi.useRealTimers()
})

/** Everything the last view's page was sent, each checked against the plugin API's schema. */
function events(): PluginEvent[] {
  return views.last().sent.map((message) => gladeMessageSchema.parse(message).event)
}

function readings(): PluginMachineReading[] {
  return events().flatMap((event) => (event.type === PluginEventType.MachineReading ? [event.reading] : []))
}

async function show(id: string): Promise<void> {
  await glade.invoke(CommandName.PluginsPlaceView, { id, bounds })
  views.last().post({ type: 'ready' })
  await vi.advanceTimersByTimeAsync(0)
}

async function grant(id: string, granted: boolean): Promise<void> {
  await glade.invoke(CommandName.PluginsSetCapability, { id, capability: PluginCapability.Machine, granted })
  await vi.advanceTimersByTimeAsync(0)
}

it('sends a plugin nothing new, and samples nothing, until its capability is turned on', async () => {
  await show('gauge')
  await vi.advanceTimersByTimeAsync(10 * MACHINE_SAMPLE_INTERVAL_MS)

  expect(events().map(({ type }) => type)).toEqual([PluginEventType.Hello, PluginEventType.Snapshot])
  expect(events()[1]).not.toHaveProperty('machine')
  expect(bridge.machine?.sampling()).toBe(false)
})

it('reloads the plugin when the capability goes on, and its new page gets the readings every ~2 s', async () => {
  await show('gauge')
  const before = views.last()

  await grant('gauge', true)
  expect(before.destroyed).toBe(true)
  expect(views.last()).toMatchObject({ bounds, destroyed: false })

  views.last().post({ type: 'ready' })
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.machine?.sampling()).toBe(true)
  await vi.advanceTimersByTimeAsync(2 * MACHINE_SAMPLE_INTERVAL_MS)

  const types = events().map(({ type }) => type)
  expect(types.slice(0, 2)).toEqual([PluginEventType.Hello, PluginEventType.Snapshot])
  expect(events()[1]).toMatchObject({ machine: [] })
  expect(readings()).toHaveLength(3)
  expect(readings().at(-1)).toMatchObject({
    cpuCount: FAKE_CPU_COUNT,
    total: 7.3,
    claude: 4.6,
    docker: 1.4,
    gpu: FAKE_GPU,
    containers: FAKE_CONTAINERS,
  })
  const [first, second] = readings().map(({ t }) => t)
  expect((second ?? 0) - (first ?? 0)).toBe(MACHINE_SAMPLE_INTERVAL_MS)
})

it('has the readings so far in a fresh snapshot after ready', async () => {
  await grant('gauge', true)
  await show('gauge')
  await vi.advanceTimersByTimeAsync(2 * MACHINE_SAMPLE_INTERVAL_MS)

  views.last().post({ type: 'ready' })
  await vi.advanceTimersByTimeAsync(0)

  const latest = events()
    .filter((event): event is PluginSnapshotEvent => event.type === PluginEventType.Snapshot)
    .at(-1)
  expect(latest?.machine).toHaveLength(3)
  expect(latest?.machine?.every((reading) => reading.gpu === FAKE_GPU)).toBe(true)
})

it('stops sampling while the bottom bar hides the plugin, and when the capability or the plugin goes off', async () => {
  await grant('gauge', true)
  await show('gauge')
  expect(bridge.machine?.sampling()).toBe(true)

  await glade.invoke(CommandName.PluginsPlaceView, { id: 'gauge', bounds: null })
  expect(bridge.machine?.sampling()).toBe(false)
  const heard = readings().length
  await vi.advanceTimersByTimeAsync(10 * MACHINE_SAMPLE_INTERVAL_MS)
  expect(readings()).toHaveLength(heard)

  await glade.invoke(CommandName.PluginsPlaceView, { id: 'gauge', bounds })
  expect(bridge.machine?.sampling()).toBe(true)

  await grant('gauge', false)
  expect(bridge.machine?.sampling()).toBe(false)
  views.last().post({ type: 'ready' })
  await vi.advanceTimersByTimeAsync(10 * MACHINE_SAMPLE_INTERVAL_MS)
  expect(events().map(({ type }) => type)).toEqual([PluginEventType.Hello, PluginEventType.Snapshot])

  await grant('gauge', true)
  views.last().post({ type: 'ready' })
  await vi.advanceTimersByTimeAsync(0)
  expect(bridge.machine?.sampling()).toBe(true)
  await glade.invoke(CommandName.PluginsSetEnabled, { id: 'gauge', enabled: false })
  expect(bridge.machine?.sampling()).toBe(false)
})

it("never sends the readings to a plugin that doesn't ask for them", async () => {
  await grant('gauge', true)
  await glade.invoke(CommandName.PluginsSetEnabled, { id: 'gauge', enabled: false })
  await show('pomodoro')
  await vi.advanceTimersByTimeAsync(10 * MACHINE_SAMPLE_INTERVAL_MS)

  expect(views.last().spec.plugin.folder).toBe('pomodoro')
  expect(events().map(({ type }) => type)).toEqual([PluginEventType.Hello, PluginEventType.Snapshot])
  expect(bridge.machine?.sampling()).toBe(false)
  await expect(
    glade.invoke(CommandName.PluginsSetCapability, {
      id: 'pomodoro',
      capability: PluginCapability.Machine,
      granted: true,
    }),
  ).rejects.toMatchObject({ code: 'invalid_request' })
})
