import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { UsageWindow, type Account } from '../../../shared/account'
import { getAccount, getUsageWarning, saveAccount, setUsageWarning } from './account'
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

describe('the usage warning', () => {
  it('has none until one is set, keeps the one set last, and clears', () => {
    expect(getUsageWarning(database.db)).toBeNull()

    setUsageWarning(database.db, { utilization: 0.85, window: UsageWindow.Session, resetsAt: 100 })
    expect(getUsageWarning(database.db)).toEqual({ utilization: 0.85, window: UsageWindow.Session, resetsAt: 100 })

    setUsageWarning(database.db, { utilization: null, window: UsageWindow.Other, resetsAt: null })
    expect(getUsageWarning(database.db)).toEqual({ utilization: null, window: UsageWindow.Other, resetsAt: null })
    expect(database.db.prepare('SELECT COUNT(*) FROM usage_warning').pluck().get()).toBe(1)

    setUsageWarning(database.db, null)
    expect(getUsageWarning(database.db)).toBeNull()
  })
})
