import { afterEach, beforeEach, expect, it } from 'vitest'
import { ALIAS_MODELS, SDK_MODELS } from '../../../shared/test-models'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '../migrations'
import { reportedContextWindowsMigration } from '../migrations/0051-reported-context-windows'
import { getReportedWindows, guessModelWindow, recordReportedWindow } from './context-windows'
import { offeredModels, setSdkModels } from './sdk-models'
import { openTestDatabase, type TestDatabase } from './test-database'

let test: TestDatabase

beforeEach(() => {
  test = openTestDatabase()
})

afterEach(() => {
  test.close()
})

it('is migration 51, after every earlier one, and starts with no window reported', () => {
  expect(reportedContextWindowsMigration.version).toBe(51)
  expect(MIGRATIONS.indexOf(reportedContextWindowsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 51).length)

  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 51),
  )
  expect(() => getReportedWindows(db)).toThrow(/no such table/)
  migrate(db, MIGRATIONS)
  expect(getReportedWindows(db).size).toBe(0)
  expect(() => {
    db.prepare('INSERT INTO reported_context_windows VALUES (?, ?, ?)').run('opus', 0, 1)
  }).toThrow(/CHECK/)
  db.close()
})

it('remembers the window reported for a model under each id it went by, the latest report winning', () => {
  recordReportedWindow(test.db, ['claude-opus-5-5', 'opus', 'opus'], 1_000_000, 1_000)
  recordReportedWindow(test.db, ['claude-haiku-4-5-20251001'], 200_000, 2_000)
  expect(Object.fromEntries(getReportedWindows(test.db))).toEqual({
    'claude-opus-5-5': 1_000_000,
    opus: 1_000_000,
    'claude-haiku-4-5-20251001': 200_000,
  })

  recordReportedWindow(test.db, ['opus'], 200_000)
  expect(getReportedWindows(test.db).get('opus')).toBe(200_000)
  expect(getReportedWindows(test.db).get('claude-opus-5-5')).toBe(1_000_000)
  const row = test.db.prepare("SELECT reported_at FROM reported_context_windows WHERE model = 'opus'").get()
  expect(row).toEqual({ reported_at: expect.any(Number) as unknown })
  expect(row).not.toEqual({ reported_at: 1_000 })
})

it('offers the built-in models until the SDK has reported its own', () => {
  expect(offeredModels(test.db).map(({ id }) => id)).toEqual([
    'claude-opus-5-5[1m]',
    'claude-sonnet-5',
    'claude-haiku-4-5',
  ])
  setSdkModels(test.db, SDK_MODELS)
  expect(offeredModels(test.db)).toEqual(SDK_MODELS)
})

it('guesses a model’s window from the reports, then the list, then the id', () => {
  // The built-in list: only the suffix says.
  expect(guessModelWindow(test.db, 'claude-opus-5-5[1m]')).toBe(1_000_000)
  expect(guessModelWindow(test.db, 'opus')).toBe(200_000)

  // The SDK's list says `default` stands for a 1M model.
  setSdkModels(test.db, SDK_MODELS)
  expect(guessModelWindow(test.db, 'default')).toBe(1_000_000)

  // #416: nothing in this list says Opus 5.5 runs at 1M, until a session reports it.
  setSdkModels(test.db, ALIAS_MODELS)
  expect(guessModelWindow(test.db, 'opus')).toBe(200_000)
  recordReportedWindow(test.db, ['claude-opus-5-5'], 1_000_000)
  expect(guessModelWindow(test.db, 'opus')).toBe(1_000_000)
  expect(guessModelWindow(test.db, 'default')).toBe(1_000_000)
  expect(guessModelWindow(test.db, 'sonnet')).toBe(200_000)
})
