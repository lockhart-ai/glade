import { afterEach, beforeEach, expect, it } from 'vitest'
import { getPluginStates, notePluginsFound, setPluginEnabled } from './plugins'
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
