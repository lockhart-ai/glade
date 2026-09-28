import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageLevel, UsageLimitKind, type Account, type UsageReading } from '../../../shared/account'
import {
  deleteResetUsageReadings,
  getAccount,
  listUsageReadings,
  replaceUsageReadings,
  saveAccount,
  saveUsageReading,
} from './account'
import { openTestDatabase, type TestDatabase } from './test-database'

let database: TestDatabase

beforeEach(() => {
  database = openTestDatabase()
})

afterEach(() => {
  database.close()
})

const LOGIN: Account = {
  email: 'sam@acme.dev',
  organization: 'Acme Robotics',
  subscriptionType: 'Claude Max',
  tokenSource: null,
  apiKeySource: null,
  apiProvider: 'firstParty',
  readAt: 10,
}

describe('the account', () => {
  it('has none until one is saved, then the one saved last', () => {
    expect(getAccount(database.db)).toBeNull()

    saveAccount(database.db, LOGIN)
    expect(getAccount(database.db)).toEqual(LOGIN)

    const key: Account = {
      email: null,
      organization: null,
      subscriptionType: null,
      tokenSource: 'claude.ai',
      apiKeySource: 'ANTHROPIC_API_KEY',
      apiProvider: null,
      readAt: 20,
    }
    saveAccount(database.db, key)
    expect(getAccount(database.db)).toEqual(key)
    expect(database.db.prepare('SELECT COUNT(*) FROM account').pluck().get()).toBe(1)
  })
})

const SESSION: UsageReading = {
  limit: { kind: UsageLimitKind.Session },
  utilization: 0.38,
  resetsAt: 100,
  level: UsageLevel.Within,
  readAt: 10,
}
const WEEK: UsageReading = { ...SESSION, limit: { kind: UsageLimitKind.Weekly }, utilization: 0.22, resetsAt: 900 }
const OPUS: UsageReading = { ...WEEK, limit: { kind: UsageLimitKind.WeeklyModel, model: 'Opus' }, utilization: 0.09 }
const SONNET: UsageReading = { ...OPUS, limit: { kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' } }
const EXTRA: UsageReading = { ...SESSION, limit: { kind: UsageLimitKind.ExtraUsage }, resetsAt: null }

describe('the usage readings', () => {
  it('has none until one is saved, then one per limit, in the meter’s order', () => {
    expect(listUsageReadings(database.db)).toEqual([])

    for (const reading of [EXTRA, SONNET, WEEK, OPUS, SESSION]) saveUsageReading(database.db, reading)
    expect(listUsageReadings(database.db)).toEqual([SESSION, WEEK, OPUS, SONNET, EXTRA])

    // A newer reading of a limit replaces its last.
    const closer = { ...SESSION, utilization: 0.85, level: UsageLevel.Warning, resetsAt: null, readAt: 20 }
    saveUsageReading(database.db, closer)
    expect(listUsageReadings(database.db)).toEqual([closer, WEEK, OPUS, SONNET, EXTRA])
  })

  it('replaces every reading at once', () => {
    replaceUsageReadings(database.db, [SESSION, WEEK, OPUS])
    replaceUsageReadings(database.db, [WEEK])
    expect(listUsageReadings(database.db)).toEqual([WEEK])
    replaceUsageReadings(database.db, [])
    expect(listUsageReadings(database.db)).toEqual([])
  })

  it('drops the readings whose window has reset, never one with no reset time', () => {
    replaceUsageReadings(database.db, [SESSION, WEEK, EXTRA])
    expect(deleteResetUsageReadings(database.db, 99)).toBe(0)
    expect(deleteResetUsageReadings(database.db, 100)).toBe(1)
    expect(listUsageReadings(database.db)).toEqual([WEEK, EXTRA])
    expect(deleteResetUsageReadings(database.db, Number.MAX_SAFE_INTEGER)).toBe(1)
    expect(listUsageReadings(database.db)).toEqual([EXTRA])
  })
})
