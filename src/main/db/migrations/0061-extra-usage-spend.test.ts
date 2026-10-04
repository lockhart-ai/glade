import { expect, it } from 'vitest'
import { UsageLevel, UsageLimitKind, type UsageReading } from '../../../shared/account'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listUsageReadings, saveUsageReading } from '../repositories/account'
import { MIGRATIONS } from '.'
import { extraUsageSpendMigration } from './0061-extra-usage-spend'

it('is migration 61, after every earlier one', () => {
  expect(extraUsageSpendMigration.version).toBe(61)
  expect(MIGRATIONS.indexOf(extraUsageSpendMigration)).toBe(MIGRATIONS.filter((m) => m.version < 61).length)
})

it('keeps the readings made before it, with nothing said of extra usage’s money until the next usage call', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 61),
  )
  db.prepare(
    `INSERT INTO usage_readings (kind, model, utilization, resets_at, level, read_at)
    VALUES ('session', '', 0.38, 100, 'within', 10), ('extra_usage', '', NULL, NULL, 'within', 10)`,
  ).run()

  migrate(db, MIGRATIONS)

  const session: UsageReading = {
    limit: { kind: UsageLimitKind.Session },
    utilization: 0.38,
    resetsAt: 100,
    level: UsageLevel.Within,
    readAt: 10,
  }
  const extra: UsageReading = {
    ...session,
    limit: { kind: UsageLimitKind.ExtraUsage },
    utilization: null,
    resetsAt: null,
  }
  expect(listUsageReadings(db)).toEqual([session, extra])
  expect(listUsageReadings(db).every((reading) => !('extraUsage' in reading))).toBe(true)

  // The next usage call's reading takes the old one's place, with the money.
  const spent: UsageReading = {
    ...extra,
    readAt: 20,
    extraUsage: { available: true, spend: { spent: 1234, cap: null, currency: 'CAD', decimalPlaces: 2 } },
  }
  saveUsageReading(db, spent)
  expect(listUsageReadings(db)).toEqual([session, spent])
  db.close()
})

it('takes money only on extra usage’s reading, and only whole: an amount with its currency and its places', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  const insert = (kind: string, columns: string, values: string): (() => unknown) => {
    return () =>
      db
        .prepare(
          `INSERT INTO usage_readings (kind, model, level, read_at, ${columns})
          VALUES ('${kind}', '', 'within', 1, ${values})`,
        )
        .run()
  }
  const money = 'extra_available, spent, spend_cap, spend_currency, spend_decimal_places'

  // Another limit says nothing of extra usage.
  expect(insert('session', 'extra_available', '1')).toThrow(/CHECK/)
  expect(insert('extra_usage', 'extra_available', '2')).toThrow(/CHECK/)
  // An amount needs extra usage's status, its currency and its places; a cap needs an amount; none is negative.
  expect(insert('extra_usage', 'spent, spend_currency, spend_decimal_places', "1234, 'CAD', 2")).toThrow(/CHECK/)
  expect(insert('extra_usage', money, '1, 1234, NULL, NULL, 2')).toThrow(/CHECK/)
  expect(insert('extra_usage', money, "1, 1234, NULL, 'CAD', NULL")).toThrow(/CHECK/)
  expect(insert('extra_usage', money, "1, NULL, 5000, 'CAD', 2")).toThrow(/CHECK/)
  expect(insert('extra_usage', money, "1, -1, NULL, 'CAD', 2")).toThrow(/CHECK/)
  expect(insert('extra_usage', money, "1, 1234, -1, 'CAD', 2")).toThrow(/CHECK/)
  expect(insert('extra_usage', money, "1, 1234, NULL, 'CAD', -1")).toThrow(/CHECK/)

  expect(insert('extra_usage', money, "0, 1234, 5000, 'CAD', 2")).not.toThrow()
  expect(listUsageReadings(db)[0]?.extraUsage).toEqual({
    available: false,
    spend: { spent: 1234, cap: 5000, currency: 'CAD', decimalPlaces: 2 },
  })
  db.close()
})
