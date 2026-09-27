import { expect, it } from 'vitest'
import { UsageLevel, UsageLimitKind } from '../../../shared/account'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getAccount, listUsageReadings } from '../repositories/account'
import { MIGRATIONS } from '.'
import { usageReadingsMigration } from './0042-usage-readings'

it('is migration 42', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 42)).toBe(usageReadingsMigration)
})

it('drops the usage warning, keeps the account, and checks each reading’s values', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 42),
  )
  db.prepare("INSERT INTO account (id, email, read_at) VALUES (1, 'sam@acme.dev', 1)").run()
  db.prepare(
    "INSERT INTO usage_warning (id, utilization, usage_window, resets_at) VALUES (1, 0.85, 'five_hour', 9)",
  ).run()

  migrate(db, MIGRATIONS)

  expect(getAccount(db)?.email).toBe('sam@acme.dev')
  // The warning isn't carried over: the next turn reads the limits afresh.
  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'usage_warning'").all()).toEqual([])
  expect(listUsageReadings(db)).toEqual([])

  const insert = (kind: string, model: string, utilization: number | null, level: string) =>
    db
      .prepare('INSERT INTO usage_readings (kind, model, utilization, level, read_at) VALUES (?, ?, ?, ?, 1)')
      .run(kind, model, utilization, level)
  expect(() => insert('fortnightly', '', 0.4, 'within')).toThrow(/CHECK/)
  expect(() => insert('session', '', -0.1, 'within')).toThrow(/CHECK/)
  expect(() => insert('session', '', 0.4, 'fine')).toThrow(/CHECK/)
  // A model's name for a per-model weekly limit, and only for one.
  expect(() => insert('weekly_model', '', 0.4, 'within')).toThrow(/CHECK/)
  expect(() => insert('weekly', 'Opus', 0.4, 'within')).toThrow(/CHECK/)
  insert('weekly_model', 'Opus', 0.09, 'within')
  insert('session', '', null, 'warning')
  expect(() => insert('session', '', 0.5, 'within')).toThrow(/UNIQUE/)
  expect(listUsageReadings(db)).toEqual([
    {
      limit: { kind: UsageLimitKind.Session },
      utilization: null,
      resetsAt: null,
      level: UsageLevel.Warning,
      readAt: 1,
    },
    {
      limit: { kind: UsageLimitKind.WeeklyModel, model: 'Opus' },
      utilization: 0.09,
      resetsAt: null,
      level: UsageLevel.Within,
      readAt: 1,
    },
  ])
  db.close()
})
