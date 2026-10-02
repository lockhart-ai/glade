import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PluginCapability } from '../../../shared/plugins'
import {
  getPluginGrants,
  getPluginSettings,
  getPluginStates,
  notePluginsFound,
  setPluginEnabled,
  setPluginGrant,
  setPluginSetting,
} from './plugins'
import { openTestDatabase, type TestDatabase } from './test-database'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

it('has no plugins to begin with', () => {
  expect(getPluginStates(database.db)).toEqual(new Map())
})

it('turns on a plugin found for the first time, and leaves one found before as it was', () => {
  notePluginsFound(database.db, ['pomodoro'], 1_000)
  setPluginEnabled(database.db, 'pomodoro', false, 2_000)

  notePluginsFound(database.db, ['pomodoro', 'abacus'], 3_000)

  expect(getPluginStates(database.db)).toEqual(
    new Map([
      ['pomodoro', false],
      ['abacus', true],
    ]),
  )
  expect(database.db.prepare('SELECT id, found_at FROM plugins ORDER BY id').all()).toEqual([
    { id: 'abacus', found_at: 3_000 },
    { id: 'pomodoro', found_at: 1_000 },
  ])
})

it('notes nothing for no plugins', () => {
  notePluginsFound(database.db, [])

  expect(getPluginStates(database.db).size).toBe(0)
})

it('saves the state of a plugin it has no row for yet', () => {
  setPluginEnabled(database.db, 'pomodoro', false)
  setPluginEnabled(database.db, 'abacus', true)

  expect(getPluginStates(database.db)).toEqual(
    new Map([
      ['pomodoro', false],
      ['abacus', true],
    ]),
  )
})

it('keeps one row per plugin, with its latest state', () => {
  notePluginsFound(database.db, ['pomodoro'])
  setPluginEnabled(database.db, 'pomodoro', false)
  setPluginEnabled(database.db, 'pomodoro', true)
  setPluginEnabled(database.db, 'pomodoro', false)

  expect(getPluginStates(database.db).get('pomodoro')).toBe(false)
  expect(database.db.prepare('SELECT COUNT(*) FROM plugins').pluck().get()).toBe(1)
})

describe('settings', () => {
  it('has none to begin with: every setting starts at its default', () => {
    notePluginsFound(database.db, ['sketchpad'])

    expect(getPluginSettings(database.db)).toEqual(new Map())
  })

  it('saves a value per plugin and key, replacing the one before, and keeps each plugin apart', () => {
    notePluginsFound(database.db, ['sketchpad', 'pomodoro'])
    setPluginSetting(database.db, 'sketchpad', 'style', 'chalk', 1_000)
    setPluginSetting(database.db, 'sketchpad', 'style', 'ink', 2_000)
    setPluginSetting(database.db, 'sketchpad', 'pace', 'slow', 3_000)
    setPluginSetting(database.db, 'pomodoro', 'style', 'neon', 4_000)

    expect(getPluginSettings(database.db)).toEqual(
      new Map([
        [
          'sketchpad',
          new Map([
            ['style', 'ink'],
            ['pace', 'slow'],
          ]),
        ],
        ['pomodoro', new Map([['style', 'neon']])],
      ]),
    )
    const rows = database.db.prepare(
      "SELECT key, updated_at FROM plugin_settings WHERE plugin_id = 'sketchpad' ORDER BY key",
    )
    expect(rows.all()).toEqual([
      { key: 'pace', updated_at: 3_000 },
      { key: 'style', updated_at: 2_000 },
    ])
  })

  it('needs the plugin to have been found', () => {
    expect(() => {
      setPluginSetting(database.db, 'nothing', 'style', 'ink')
    }).toThrow(/FOREIGN KEY/)
  })

  it("keeps a plugin's values while it's off, and through being found again", () => {
    notePluginsFound(database.db, ['sketchpad'])
    setPluginSetting(database.db, 'sketchpad', 'style', 'chalk')
    setPluginEnabled(database.db, 'sketchpad', false)
    notePluginsFound(database.db, ['sketchpad'])

    expect(getPluginSettings(database.db).get('sketchpad')).toEqual(new Map([['style', 'chalk']]))
  })
})

describe('grants', () => {
  it('has none to begin with: every capability starts off', () => {
    notePluginsFound(database.db, ['gauge'])

    expect(getPluginGrants(database.db)).toEqual(new Map())
  })

  it('turns a capability on and off, once per plugin, and keeps each plugin apart', () => {
    notePluginsFound(database.db, ['gauge', 'nekomata'])
    setPluginGrant(database.db, 'gauge', PluginCapability.Machine, true, 1_000)
    setPluginGrant(database.db, 'gauge', PluginCapability.Machine, true, 2_000)
    setPluginGrant(database.db, 'nekomata', PluginCapability.Machine, true)

    expect(getPluginGrants(database.db)).toEqual(
      new Map([
        ['gauge', new Set([PluginCapability.Machine])],
        ['nekomata', new Set([PluginCapability.Machine])],
      ]),
    )
    const grantedAt = database.db.prepare("SELECT granted_at FROM plugin_grants WHERE plugin_id = 'gauge'")
    expect(grantedAt.pluck().all()).toEqual([1_000])

    setPluginGrant(database.db, 'gauge', PluginCapability.Machine, false)
    setPluginGrant(database.db, 'gauge', PluginCapability.Machine, false)
    expect([...getPluginGrants(database.db).keys()]).toEqual(['nekomata'])
  })

  it("leaves out a capability this Glade doesn't know, saved by a newer one", () => {
    notePluginsFound(database.db, ['gauge'])
    database.db.prepare("INSERT INTO plugin_grants VALUES ('gauge', 'camera', 1)").run()

    expect(getPluginGrants(database.db)).toEqual(new Map())
  })

  it('needs the plugin to have been found', () => {
    expect(() => {
      setPluginGrant(database.db, 'nothing', PluginCapability.Machine, true)
    }).toThrow(/FOREIGN KEY/)
  })
})
