import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { PluginStatus, type InstalledPlugin } from '../../shared/plugins'
import { CommandFailure } from '../bridge/errors'
import { getPluginStates } from '../db/repositories/plugins'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { LogLevel, LogScope } from '../logging/logger'
import { createMemoryLog } from '../logging/memory-sink'
import { createPlugins, type Plugins, type PluginsContext } from './plugins'
import { sampleManifest, tempPluginsParent, writePlugin } from './test-plugins'

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
