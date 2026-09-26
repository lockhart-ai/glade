import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getAccount, getUsageWarning } from '../repositories/account'
import { MIGRATIONS } from '.'
import { accountMigration } from './0031-account'

it('is migration 31', () => {
  expect(MIGRATIONS[30]).toBe(accountMigration)
})

it('starts with no account and no warning, keeps one row of each, and checks the warning’s values', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 30))
  migrate(db, MIGRATIONS)

  expect(getAccount(db)).toBeNull()
  expect(getUsageWarning(db)).toBeNull()

  db.prepare("INSERT INTO account (id, email, read_at) VALUES (1, 'sam@acme.dev', 1)").run()
  expect(() => db.prepare('INSERT INTO account (id, read_at) VALUES (2, 1)').run()).toThrow(/CHECK/)
  expect(() => db.prepare('INSERT INTO account (id) VALUES (1)').run()).toThrow(/NOT NULL|UNIQUE/)

  const warn = (id: number, utilization: number | null, window: string) =>
    db
      .prepare('INSERT INTO usage_warning (id, utilization, usage_window) VALUES (?, ?, ?)')
      .run(id, utilization, window)
  expect(() => warn(2, 0.8, 'five_hour')).toThrow(/CHECK/)
  expect(() => warn(1, -0.1, 'five_hour')).toThrow(/CHECK/)
  expect(() => warn(1, 0.8, 'fortnightly')).toThrow(/CHECK/)
  warn(1, null, 'seven_day')
  expect(getUsageWarning(db)).toEqual({ utilization: null, window: 'seven_day', resetsAt: null })
  db.close()
})
