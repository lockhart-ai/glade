import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { PluginCapability, PluginStatus, type InstalledPlugin, type PluginManifest } from '../../shared/plugins'
import { CommandFailure } from '../bridge/errors'
import { getPluginGrants, getPluginStates } from '../db/repositories/plugins'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { createPlugins, pluginSignature, type Plugins, type PluginsContext } from './plugins'
import { SAMPLE_SVG, sampleManifest, tempPluginsParent, writePlugin } from './test-plugins'

let parent: string
let folder: string
let database: TestDatabase
let emit: Mock<(event: GladeEvent) => void>
let openPath: Mock<(path: string) => Promise<string>>

beforeEach(() => {
  parent = tempPluginsParent()
  folder = join(parent, 'plugins')
  database = openTestDatabase()
  emit = vi.fn()
  openPath = vi.fn(() => Promise.resolve(''))
})

afterEach(() => {
  database.close()
  rmSync(parent, { recursive: true, force: true })
})

function plugins(overrides: Partial<PluginsContext> = {}): Plugins {
  return createPlugins({ db: database.db, emit, folder, openPath, ...overrides })
}

/** Each plugin as its folder and whether it's on, or `invalid`. */
function states(list: readonly InstalledPlugin[]): [string, boolean | 'invalid'][] {
  return list.map((plugin) => [plugin.folder, plugin.status === PluginStatus.Valid ? plugin.enabled : 'invalid'])
}

describe('list', () => {
  it('creates a missing plugins folder, and lists nothing', async () => {
    expect(await plugins().list()).toEqual([])
    expect(existsSync(folder)).toBe(true)
  })

  it('turns on a plugin found for the first time, saving it, and lists invalid ones with no state', async () => {
    writePlugin(folder, 'pomodoro')
    writePlugin(folder, 'broken', { ...sampleManifest('broken'), entry: '../x.html' })

    const listed = await plugins().list()

    expect(listed).toMatchObject([
      { folder: 'broken', status: PluginStatus.Invalid, reason: "entry: Expected a path inside the plugin's folder" },
      { folder: 'pomodoro', status: PluginStatus.Valid, enabled: true, manifest: { name: 'Pomodoro' } },
    ])
    expect(getPluginStates(database.db)).toEqual(new Map([['pomodoro', true]]))
  })

  it('broadcasts nothing the first time, nor when nothing changed, and the whole list when something did', async () => {
    const service = plugins()
    writePlugin(folder, 'pomodoro')
    await service.list()
    await service.list()
    expect(emit).not.toHaveBeenCalled()

    writePlugin(folder, 'abacus')
    const listed = await service.list()

    expect(emit).toHaveBeenCalledExactlyOnceWith({ type: EventType.PluginsChanged, plugins: listed })
    expect(states(listed)).toEqual([
      ['abacus', true],
      ['pomodoro', true],
    ])
  })

  it('finds a plugin edited since, and broadcasts it', async () => {
    const service = plugins()
    writePlugin(folder, 'pomodoro')
    await service.list()

    writePlugin(folder, 'pomodoro', { ...sampleManifest(), version: '0.5.0' })
    await service.list()

    expect(emit).toHaveBeenCalledOnce()
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      plugins: [{ manifest: { version: '0.5.0' } }],
    })
  })

  it("reloads a plugin whose files changed since it was last read, but not one that didn't", async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writePlugin(folder, 'pomodoro')
    writePlugin(folder, 'abacus')
    await service.list()

    // Read again with nothing touched: neither is reloaded.
    await service.list()
    expect(onReload).not.toHaveBeenCalled()

    // pomodoro's entry file is rewritten (a new build copied in); abacus is untouched.
    writePlugin(folder, 'pomodoro', sampleManifest(), {
      'index.html': '<!doctype html><title>Pomodoro v2</title>',
      'icon.svg': SAMPLE_SVG,
    })
    await service.list()

    expect(onReload).toHaveBeenCalledExactlyOnceWith(['pomodoro'])
  })

  it("doesn't reload a plugin found for the first time, or one whose folder came back the same as it left", async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writePlugin(folder, 'pomodoro')

    await service.list()
    expect(onReload).not.toHaveBeenCalled()

    // Removed, then reinstalled identically: nothing to compare against from before it was gone, so no reload.
    rmSync(join(folder, 'pomodoro'), { recursive: true })
    await service.list()
    writePlugin(folder, 'pomodoro')
    await service.list()

    expect(onReload).not.toHaveBeenCalled()
  })

  it('drops a plugin removed while Glade runs, keeping its state, and brings it back as it was', async () => {
    const service = plugins()
    const dir = writePlugin(folder, 'pomodoro')
    writePlugin(folder, 'abacus')
    await service.list()
    service.setEnabled('pomodoro', false)

    rmSync(dir, { recursive: true })
    expect(states(await service.list())).toEqual([['abacus', true]])
    expect(getPluginStates(database.db).get('pomodoro')).toBe(false)
    expect(() => service.setEnabled('pomodoro', true)).toThrow(CommandFailure)

    writePlugin(folder, 'pomodoro')
    expect(states(await service.list())).toEqual([
      ['abacus', true],
      ['pomodoro', false],
    ])
  })

  it('logs what it found, and each invalid plugin with why', async () => {
    const memory = createMemoryLog()
    writePlugin(folder, 'pomodoro')
    writePlugin(folder, 'broken', null)

    await plugins({ log: memory.logger.scoped(LogScope.Plugins) }).list()

    expect(memory.records.map(({ level, scope, message, fields }) => [level, scope, message, fields])).toEqual([
      [LogLevel.Warn, LogScope.Plugins, 'invalid plugin', { folder: 'broken', reason: 'No manifest.json' }],
      [LogLevel.Info, LogScope.Plugins, 'plugins found', { folder, valid: 1, invalid: 1 }],
    ])
  })

  it('lists nothing when the app quits while the folder is being read', async () => {
    writePlugin(folder, 'pomodoro')
    const listing = plugins().list()
    database.close()

    expect(await listing).toEqual([])
    expect(emit).not.toHaveBeenCalled()
    // A fresh one, for afterEach to close.
    database = openTestDatabase()
  })

  it("lists nothing, and logs why, when the plugins folder can't be read", async () => {
    const memory = createMemoryLog()
    writeFileSync(join(parent, 'file'), '')

    const listed = await plugins({ folder: join(parent, 'file'), log: memory.logger }).list()

    expect(listed).toEqual([])
    expect(memory.records[0]).toMatchObject({
      level: LogLevel.Error,
      message: "the plugins folder can't be read",
    })
  })
})

describe('setEnabled', () => {
  it('turns a plugin off and on, saving it and broadcasting the list', async () => {
    const service = plugins()
    writePlugin(folder, 'pomodoro')
    writePlugin(folder, 'abacus')
    await service.list()

    const off = service.setEnabled('pomodoro', false)

    expect(states(off)).toEqual([
      ['abacus', true],
      ['pomodoro', false],
    ])
    expect(emit).toHaveBeenLastCalledWith({ type: EventType.PluginsChanged, plugins: off })
    expect(getPluginStates(database.db).get('pomodoro')).toBe(false)

    expect(states(service.setEnabled('pomodoro', true))).toEqual([
      ['abacus', true],
      ['pomodoro', true],
    ])
    expect(getPluginStates(database.db).get('pomodoro')).toBe(true)
  })

  it('keeps the state across a relaunch: a new service on the same database', async () => {
    writePlugin(folder, 'pomodoro')
    const first = plugins()
    await first.list()
    first.setEnabled('pomodoro', false)

    expect(states(await plugins().list())).toEqual([['pomodoro', false]])
  })

  it('refuses a plugin that is invalid, unknown, or not listed yet', async () => {
    const service = plugins()
    writePlugin(folder, 'pomodoro')
    writePlugin(folder, 'broken', null)
    expect(() => service.setEnabled('pomodoro', false)).toThrow('No plugin pomodoro')
    await service.list()

    for (const id of ['broken', 'nothing']) {
      let failure: unknown
      try {
        service.setEnabled(id, false)
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(CommandFailure)
      expect(failure).toMatchObject({ code: BridgeErrorCode.NotFound })
    }
    expect(getPluginStates(database.db).has('broken')).toBe(false)
  })

  it('logs each change', async () => {
    const memory = createMemoryLog()
    writePlugin(folder, 'pomodoro')
    const service = plugins({ log: memory.logger })
    await service.list()

    service.setEnabled('pomodoro', false)
    service.setEnabled('pomodoro', true)

    expect(memory.records.slice(-2).map(({ message, fields }) => [message, fields])).toEqual([
      ['plugin turned off', { id: 'pomodoro' }],
      ['plugin turned on', { id: 'pomodoro' }],
    ])
  })
})

describe('setCapability', () => {
  /** A plugin that asks for the machine's readings. */
  function writeGauge(capabilities: unknown = ['machine']): void {
    writePlugin(folder, 'gauge', { ...sampleManifest('gauge'), name: 'Load Gauge', capabilities })
  }

  /** What each valid plugin has been granted, by folder. */
  function grants(list: readonly InstalledPlugin[]): [string, readonly PluginCapability[]][] {
    return list.flatMap((plugin) => (plugin.status === PluginStatus.Valid ? [[plugin.folder, plugin.granted]] : []))
  }

  it('lists a capability a plugin asks for as off, until it is turned on', async () => {
    writeGauge()
    writePlugin(folder, 'pomodoro')

    const listed = await plugins().list()

    expect(listed).toMatchObject([
      { folder: 'gauge', manifest: { capabilities: [PluginCapability.Machine] }, granted: [] },
      { folder: 'pomodoro', manifest: { capabilities: [] }, granted: [] },
    ])
  })

  it('turns it on and off, saving it, broadcasting the list and reloading the plugin each time it changes', async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writeGauge()
    await service.list()

    const on = service.setCapability('gauge', PluginCapability.Machine, true)
    expect(grants(on)).toEqual([['gauge', [PluginCapability.Machine]]])
    expect(emit).toHaveBeenLastCalledWith({ type: EventType.PluginsChanged, plugins: on })
    expect(getPluginGrants(database.db).get('gauge')).toEqual(new Set([PluginCapability.Machine]))
    expect(onReload).toHaveBeenLastCalledWith(['gauge'])

    const off = service.setCapability('gauge', PluginCapability.Machine, false)
    expect(grants(off)).toEqual([['gauge', []]])
    expect(getPluginGrants(database.db).has('gauge')).toBe(false)
    expect(onReload).toHaveBeenCalledTimes(2)
  })

  it("doesn't reload the plugin when the switch is set to what it already was", async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writeGauge()
    await service.list()

    service.setCapability('gauge', PluginCapability.Machine, false)
    service.setCapability('gauge', PluginCapability.Machine, true)
    service.setCapability('gauge', PluginCapability.Machine, true)

    expect(onReload).toHaveBeenCalledTimes(1)
  })

  it('keeps it across a relaunch, and whether the plugin is on or off', async () => {
    writeGauge()
    const first = plugins()
    await first.list()
    first.setCapability('gauge', PluginCapability.Machine, true)
    first.setEnabled('gauge', false)

    expect(grants(await plugins().list())).toEqual([['gauge', [PluginCapability.Machine]]])
  })

  it('keeps a grant off while the manifest stops asking for it, and back on once it asks again', async () => {
    const service = plugins()
    writeGauge()
    await service.list()
    service.setCapability('gauge', PluginCapability.Machine, true)

    writeGauge([])
    expect(grants(await service.list())).toEqual([['gauge', []]])

    writeGauge(['machine'])
    expect(grants(await service.list())).toEqual([['gauge', [PluginCapability.Machine]]])
  })

  it("refuses a capability the plugin doesn't ask for, saving nothing and reloading nothing", async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writePlugin(folder, 'pomodoro')
    await service.list()

    expect(() => service.setCapability('pomodoro', PluginCapability.Machine, true)).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.InvalidRequest }),
    )
    expect(getPluginGrants(database.db).size).toBe(0)
    expect(onReload).not.toHaveBeenCalled()
  })

  it('refuses a plugin that is invalid, unknown, or not listed yet', async () => {
    const service = plugins()
    writeGauge()
    writePlugin(folder, 'broken', null)
    expect(() => service.setCapability('gauge', PluginCapability.Machine, true)).toThrow('No plugin gauge')
    await service.list()

    for (const id of ['broken', 'nothing']) {
      expect(() => service.setCapability(id, PluginCapability.Machine, true)).toThrow(
        expect.objectContaining({ code: BridgeErrorCode.NotFound }),
      )
    }
  })

  it('logs each change', async () => {
    const memory = createMemoryLog()
    writeGauge()
    const service = plugins({ log: memory.logger })
    await service.list()

    service.setCapability('gauge', PluginCapability.Machine, true)
    service.setCapability('gauge', PluginCapability.Machine, false)

    expect(memory.records.slice(-2).map(({ message, fields }) => [message, fields])).toEqual([
      ['plugin capability turned on', { id: 'gauge', capability: 'machine' }],
      ['plugin capability turned off', { id: 'gauge', capability: 'machine' }],
    ])
  })
})

describe('pluginSignature', () => {
  it('answers null, not a rejection, for a plugin whose entry file is gone since discovery resolved it', async () => {
    writePlugin(folder, 'pomodoro')
    const manifest: PluginManifest = {
      id: 'pomodoro',
      name: 'Pomodoro',
      version: '1.0.0',
      entry: 'index.html',
      icon: null,
      capabilities: [],
    }
    rmSync(join(folder, 'pomodoro', 'index.html'))

    expect(
      await pluginSignature(folder, { status: PluginStatus.Valid, folder: 'pomodoro', manifest, iconUrl: null }),
    ).toBeNull()
  })
})

describe('reload', () => {
  it('reloads a plugin by hand, without reading the folder again', async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writePlugin(folder, 'pomodoro')
    await service.list()

    service.reload('pomodoro')

    expect(onReload).toHaveBeenCalledExactlyOnceWith(['pomodoro'])
  })

  it('reloads even when nothing on disk changed: an explicit reload, not a rescan', async () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writePlugin(folder, 'pomodoro')
    await service.list()
    await service.list()
    onReload.mockClear()

    service.reload('pomodoro')

    expect(onReload).toHaveBeenCalledExactlyOnceWith(['pomodoro'])
  })

  it('logs it', async () => {
    const memory = createMemoryLog()
    writePlugin(folder, 'pomodoro')
    const service = plugins({ log: memory.logger })
    await service.list()

    service.reload('pomodoro')

    expect(memory.records.at(-1)).toMatchObject({ message: 'plugin reloaded', fields: { id: 'pomodoro' } })
  })

  it('refuses a plugin that is invalid, unknown, or not listed yet, without touching the views', () => {
    const onReload = vi.fn()
    const service = plugins({ onReload })
    writePlugin(folder, 'broken', null)
    expect(() => {
      service.reload('pomodoro')
    }).toThrow('No plugin pomodoro')
    expect(() => {
      service.reload('broken')
    }).toThrow('No plugin broken')
    expect(onReload).not.toHaveBeenCalled()
  })
})

describe('openFolder', () => {
  it('opens the plugins folder, creating it if it is missing', async () => {
    await plugins().openFolder()

    expect(openPath).toHaveBeenCalledExactlyOnceWith(folder)
    expect(existsSync(folder)).toBe(true)
  })

  it("fails with macOS's reason when it can't open it", async () => {
    openPath.mockResolvedValue('No application knows how to open it')

    await expect(plugins().openFolder()).rejects.toThrow(
      "Couldn't open the plugins folder: No application knows how to open it",
    )
  })
})

describe('onUpdate', () => {
  it('hears the plugins each time they are read or turned on or off, changed or not', async () => {
    writePlugin(folder, 'pomodoro')
    const onUpdate = vi.fn()
    const installed = plugins({ onUpdate })

    await installed.list()
    await installed.list()
    installed.setEnabled('pomodoro', false)

    expect(onUpdate.mock.calls.map(([list]) => states(list as InstalledPlugin[]))).toEqual([
      [['pomodoro', true]],
      [['pomodoro', true]],
      [['pomodoro', false]],
    ])
  })
})
