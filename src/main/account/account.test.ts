import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageWindow, type UsageWarning } from '../../shared/account'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { AgentEventKind, RateLimitStatus, type RateLimitEvent } from '../agent/events'
import { MAX_TIMER_MS } from '../agent/pauses'
import { getAccount, getUsageWarning, saveAccount, setUsageWarning } from '../db/repositories/account'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { LogLevel } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { createAccountTracker, parseAccountInfo, usageWarningFor, type AccountTracker } from './account'

const NOW = 1_790_000_000_000
const HOUR = 3_600_000

let database: TestDatabase
let events: GladeEvent[]
let log: MemoryLog
let tracker: AccountTracker | null

function track(): AccountTracker {
  tracker = createAccountTracker({ db: database.db, emit: (event) => events.push(event), log: log.logger })
  return tracker
}

function limit(fields: Partial<RateLimitEvent> = {}): RateLimitEvent {
  return {
    kind: AgentEventKind.RateLimit,
    status: RateLimitStatus.AllowedWarning,
    resetsAt: NOW + HOUR,
    utilization: 0.85,
    window: UsageWindow.Session,
    ...fields,
  }
}

const WARNING: UsageWarning = { utilization: 0.85, window: UsageWindow.Session, resetsAt: NOW + HOUR }

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
  database = openTestDatabase()
  events = []
  log = createMemoryLog()
  tracker = null
})

afterEach(() => {
  tracker?.close()
  database.close()
  vi.useRealTimers()
})

describe('parseAccountInfo', () => {
  it('reads what Claude Code reports, field for field, a field it leaves out as null', () => {
    expect(
      parseAccountInfo(
        {
          email: 'sam@acme.dev',
          organization: 'Acme Robotics',
          subscriptionType: 'Claude Max',
          apiProvider: 'firstParty',
        },
        5,
      ),
    ).toEqual({
      email: 'sam@acme.dev',
      organization: 'Acme Robotics',
      subscriptionType: 'Claude Max',
      tokenSource: null,
      apiKeySource: null,
      apiProvider: 'firstParty',
      readAt: 5,
    })
  })

  it('takes a malformed or empty field as left out, and anything but an object as nothing to read', () => {
    expect(parseAccountInfo({ email: 42, tokenSource: '', apiKeySource: 'apiKeyHelper', extra: true }, 5)).toEqual({
      email: null,
      organization: null,
      subscriptionType: null,
      tokenSource: null,
      apiKeySource: 'apiKeyHelper',
      apiProvider: null,
      readAt: 5,
    })
    expect(parseAccountInfo({}, 5)).toMatchObject({ email: null, apiProvider: null })
    for (const raw of [null, undefined, 'sam@acme.dev', []]) expect(parseAccountInfo(raw, 5)).toBeNull()
  })
})

describe('usageWarningFor', () => {
  it('warns from 70% of the window, as Claude Code does, however early the API says allowed_warning', () => {
    expect(usageWarningFor(limit(), NOW)).toEqual(WARNING)
    expect(usageWarningFor(limit({ utilization: 0.7 }), NOW)).toMatchObject({ utilization: 0.7 })
    // As probed: a warning at 28% of a week. Claude Code shows nothing, and nor does Glade.
    expect(usageWarningFor(limit({ utilization: 0.28, window: UsageWindow.Weekly }), NOW)).toBeNull()
    expect(usageWarningFor(limit({ utilization: 0.69 }), NOW)).toBeNull()
  })

  it("warns when the SDK doesn't say how much is used, or when the window resets", () => {
    expect(usageWarningFor(limit({ utilization: null, resetsAt: null }), NOW)).toEqual({
      utilization: null,
      window: UsageWindow.Session,
      resetsAt: null,
    })
  })

  it('has no warning for a limit that is fine, spent, or whose window has already reset', () => {
    expect(usageWarningFor(limit({ status: RateLimitStatus.Allowed }), NOW)).toBeNull()
    expect(usageWarningFor(limit({ status: RateLimitStatus.Rejected }), NOW)).toBeNull()
    expect(usageWarningFor(limit({ resetsAt: NOW }), NOW)).toBeNull()
  })
})

describe('createAccountTracker', () => {
  it('has no account and no warning to begin with', () => {
    expect(track().status()).toEqual({ account: null, usageWarning: null })
  })

  it('saves each account read, broadcasts it, and logs it without the email or organization', () => {
    const account = track()
    account.accountRead({
      email: 'sam@acme.dev',
      organization: 'Acme Robotics',
      subscriptionType: 'Claude Max',
      apiProvider: 'firstParty',
    })

    const saved = getAccount(database.db)
    expect(saved).toMatchObject({ email: 'sam@acme.dev', subscriptionType: 'Claude Max', readAt: NOW })
    expect(events).toEqual([{ type: EventType.AccountChanged, status: { account: saved, usageWarning: null } }])
    expect(JSON.stringify(log.records)).not.toMatch(/sam@acme|Acme Robotics/)
    expect(log.withMessage('account read')[0]?.fields).toMatchObject({ kind: 'login', plan: 'Claude Max' })

    // Signed in again with an API key: it replaces the one before.
    vi.advanceTimersByTime(1000)
    account.accountRead({ tokenSource: 'claude.ai', apiKeySource: 'ANTHROPIC_API_KEY', apiProvider: 'firstParty' })
    expect(getAccount(database.db)).toEqual({
      email: null,
      organization: null,
      subscriptionType: null,
      tokenSource: 'claude.ai',
      apiKeySource: 'ANTHROPIC_API_KEY',
      apiProvider: 'firstParty',
      readAt: NOW + 1000,
    })
    expect(events).toHaveLength(2)
  })

  it('keeps the account it has when a read makes no sense', () => {
    const before = parseAccountInfo({ email: 'sam@acme.dev' }, 1)
    if (before !== null) saveAccount(database.db, before)
    const account = track()

    account.accountRead('not an account')

    expect(getAccount(database.db)?.email).toBe('sam@acme.dev')
    expect(events).toEqual([])
    expect(log.records).toContainEqual(expect.objectContaining({ level: LogLevel.Warn }))
  })

  it('warns, and broadcasts only when the warning changes', () => {
    const account = track()
    account.rateLimit(limit())
    account.rateLimit(limit())

    expect(getUsageWarning(database.db)).toEqual(WARNING)
    expect(events).toEqual([{ type: EventType.AccountChanged, status: { account: null, usageWarning: WARNING } }])

    account.rateLimit(limit({ utilization: 0.9 }))
    expect(events).toHaveLength(2)
    expect(account.status().usageWarning?.utilization).toBe(0.9)
  })

  it('never broadcasts for limits that stay fine', () => {
    const account = track()
    account.rateLimit(limit({ status: RateLimitStatus.Allowed }))
    account.rateLimit(limit({ utilization: 0.3 }))

    expect(events).toEqual([])
  })

  it('clears the warning once the limit is spent, so the paused tasks’ banner takes over', () => {
    const account = track()
    account.rateLimit(limit())
    account.rateLimit(limit({ status: RateLimitStatus.Rejected }))

    expect(getUsageWarning(database.db)).toBeNull()
    expect(events.at(-1)).toEqual({ type: EventType.AccountChanged, status: { account: null, usageWarning: null } })
  })

  it('clears the warning when the SDK says the limit is fine again', () => {
    const account = track()
    account.rateLimit(limit())
    account.rateLimit(limit({ status: RateLimitStatus.Allowed, utilization: 0.1 }))

    expect(account.status().usageWarning).toBeNull()
    expect(events).toHaveLength(2)
  })

  it('clears the warning when its window resets, and not a moment before', () => {
    const account = track()
    account.rateLimit(limit())

    vi.advanceTimersByTime(HOUR - 1)
    expect(account.status().usageWarning).toEqual(WARNING)
    vi.advanceTimersByTime(1)
    expect(account.status().usageWarning).toBeNull()
    expect(events.at(-1)).toEqual({ type: EventType.AccountChanged, status: { account: null, usageWarning: null } })
    expect(log.records).toContainEqual(expect.objectContaining({ message: 'usage warning over: its window reset' }))
  })

  it('times a newer warning’s window, not the one it replaced', () => {
    const account = track()
    account.rateLimit(limit({ resetsAt: NOW + 1000 }))
    account.rateLimit(limit({ resetsAt: NOW + HOUR }))

    vi.advanceTimersByTime(1000)
    expect(account.status().usageWarning).toEqual(WARNING)
    vi.advanceTimersByTime(HOUR)
    expect(account.status().usageWarning).toBeNull()
  })

  it('keeps a warning with no reset time until the SDK says otherwise', () => {
    const account = track()
    account.rateLimit(limit({ resetsAt: null }))

    vi.advanceTimersByTime(7 * 24 * HOUR)
    expect(account.status().usageWarning).toMatchObject({ resetsAt: null })
  })

  it('waits out a window longer than one timer can', () => {
    const account = track()
    const far = NOW + MAX_TIMER_MS + HOUR
    account.rateLimit(limit({ resetsAt: far }))

    vi.advanceTimersByTime(MAX_TIMER_MS)
    expect(account.status().usageWarning).not.toBeNull()
    vi.advanceTimersByTime(HOUR)
    expect(account.status().usageWarning).toBeNull()
  })

  it('times a warning left from before a relaunch again, and drops one whose window reset while the app was closed', () => {
    setUsageWarning(database.db, WARNING)
    const account = track()
    expect(account.status().usageWarning).toEqual(WARNING)
    vi.advanceTimersByTime(HOUR)
    expect(account.status().usageWarning).toBeNull()
    account.close()

    setUsageWarning(database.db, { ...WARNING, resetsAt: NOW })
    expect(track().status().usageWarning).toBeNull()

    setUsageWarning(database.db, { ...WARNING, resetsAt: null })
    expect(track().status().usageWarning).toEqual({ ...WARNING, resetsAt: null })
  })

  it('does nothing once closed', () => {
    const account = track()
    account.rateLimit(limit())
    account.close()

    vi.advanceTimersByTime(HOUR)
    expect(getUsageWarning(database.db)).toEqual(WARNING)
  })
})
