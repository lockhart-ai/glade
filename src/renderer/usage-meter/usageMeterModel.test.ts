import { describe, expect, it } from 'vitest'
import { UsageLevel, UsageLimitKind, type Account, type ExtraUsageSpend, type UsageReading } from '../../shared/account'
import {
  currentReadings,
  usageBar,
  usageFraction,
  usageLimitLabel,
  usageLimitReachedLabel,
  UsageMeterKind,
  usageMeterState,
  usagePercent,
  usageResets,
  usageResetsAt,
  usageSpend,
  usageUpdated,
} from './usageMeterModel'

/** Sep 27, 2026, 12:00 local time. */
const NOW = new Date(2026, 8, 27, 12, 0).getTime()
const MINUTE = 60_000
const HOUR = 60 * MINUTE

const LOGIN: Account = {
  email: 'sam@acme.dev',
  organization: null,
  subscriptionType: 'Claude Max',
  tokenSource: null,
  apiKeySource: null,
  apiProvider: 'firstParty',
  readAt: NOW,
}
const API_KEY: Account = { ...LOGIN, email: null, subscriptionType: null, apiKeySource: 'ANTHROPIC_API_KEY' }
const BEDROCK: Account = { ...API_KEY, apiKeySource: null, apiProvider: 'bedrock' }
const SIGNED_OUT: Account = { ...API_KEY, apiKeySource: null }

const SESSION: UsageReading = {
  limit: { kind: UsageLimitKind.Session },
  utilization: 0.38,
  resetsAt: new Date(2026, 8, 27, 15, 40).getTime(),
  level: UsageLevel.Within,
  readAt: NOW - 2 * MINUTE,
}
const WEEK: UsageReading = {
  limit: { kind: UsageLimitKind.Weekly },
  utilization: 0.22,
  resetsAt: new Date(2026, 9, 1, 9, 0).getTime(),
  level: UsageLevel.Within,
  readAt: NOW - 2 * MINUTE,
}
const OPUS: UsageReading = { ...WEEK, limit: { kind: UsageLimitKind.WeeklyModel, model: 'Opus' }, utilization: 0.09 }

describe('usageMeterState', () => {
  it('shows the most-used limit, blue below 70%', () => {
    expect(usageMeterState(LOGIN, [SESSION, WEEK, OPUS], NOW)).toEqual({
      kind: UsageMeterKind.Normal,
      reading: SESSION,
    })
    const busyWeek = { ...WEEK, utilization: 0.5 }
    expect(usageMeterState(LOGIN, [SESSION, busyWeek, OPUS], NOW)).toEqual({
      kind: UsageMeterKind.Normal,
      reading: busyWeek,
    })
  })

  it('turns purple for a limit that is close, whichever limit it is', () => {
    const closeOpus = { ...OPUS, utilization: 0.84, level: UsageLevel.Warning }
    expect(usageMeterState(LOGIN, [SESSION, WEEK, closeOpus], NOW)).toEqual({
      kind: UsageMeterKind.Warning,
      reading: closeOpus,
    })
    // Claude Code warned without saying how much: that still outranks a limit that is further off.
    const warned = { ...WEEK, utilization: null, level: UsageLevel.Warning }
    expect(usageMeterState(LOGIN, [SESSION, warned], NOW)).toEqual({ kind: UsageMeterKind.Warning, reading: warned })
  })

  it('is at the limit while one has run out, showing the one that resets last', () => {
    const session = { ...SESSION, utilization: null, level: UsageLevel.Limited }
    const week = { ...WEEK, utilization: 1, level: UsageLevel.Limited }
    expect(usageMeterState(LOGIN, [session, OPUS], NOW)).toEqual({ kind: UsageMeterKind.Limited, reading: session })
    expect(usageMeterState(LOGIN, [session, week, OPUS], NOW)).toEqual({ kind: UsageMeterKind.Limited, reading: week })
    // One with no reset time is as good as resetting soonest.
    const unknown = { ...session, resetsAt: null }
    expect(usageMeterState(LOGIN, [unknown, week], NOW)).toMatchObject({ reading: week })
    expect(usageMeterState(LOGIN, [unknown], NOW)).toMatchObject({ reading: unknown })
  })

  it('says “within limits” while nothing says how much is used, or nothing is read', () => {
    expect(usageMeterState(null, [], NOW)).toEqual({ kind: UsageMeterKind.Unknown })
    expect(usageMeterState(LOGIN, [], NOW)).toEqual({ kind: UsageMeterKind.Unknown })
    expect(usageMeterState(SIGNED_OUT, [], NOW)).toEqual({ kind: UsageMeterKind.Unknown })
    expect(usageMeterState(LOGIN, [{ ...SESSION, utilization: null }], NOW)).toEqual({
      kind: UsageMeterKind.Unknown,
    })
  })

  it('leaves out readings whose window has reset', () => {
    const reset = { ...SESSION, utilization: 0.99, level: UsageLevel.Warning, resetsAt: NOW }
    expect(currentReadings([reset, WEEK, { ...OPUS, resetsAt: null }], NOW)).toEqual([
      WEEK,
      { ...OPUS, resetsAt: null },
    ])
    expect(usageMeterState(LOGIN, [reset, WEEK], NOW)).toEqual({ kind: UsageMeterKind.Normal, reading: WEEK })
    expect(usageMeterState(LOGIN, [{ ...reset, level: UsageLevel.Limited }], NOW)).toEqual({
      kind: UsageMeterKind.Unknown,
    })
  })

  it('hides for an API key or a cloud provider, which have no plan limits, whatever was read before', () => {
    expect(usageMeterState(API_KEY, [SESSION], NOW)).toEqual({ kind: UsageMeterKind.Hidden })
    expect(usageMeterState(BEDROCK, [], NOW)).toEqual({ kind: UsageMeterKind.Hidden })
  })
})

describe('the meter’s words', () => {
  it('names each limit, and each once it has run out', () => {
    const limits = [
      { kind: UsageLimitKind.Session },
      { kind: UsageLimitKind.Weekly },
      { kind: UsageLimitKind.WeeklyModel, model: 'Opus' },
      { kind: UsageLimitKind.ExtraUsage },
    ] as const
    expect(limits.map(usageLimitLabel)).toEqual(['Session', 'This week', 'This week · Opus', 'Extra usage'])
    expect(limits.map(usageLimitReachedLabel)).toEqual([
      'Session limit',
      'Weekly limit',
      'Weekly Opus limit',
      'Extra usage limit',
    ])
  })

  it('rounds how much is used down, as Claude Code does, and says where it stands without an amount', () => {
    expect(usagePercent(SESSION)).toBe('38%')
    expect(usagePercent({ ...SESSION, utilization: 0.999 })).toBe('99%')
    expect(usagePercent({ ...SESSION, utilization: 0 })).toBe('0%')
    expect(usagePercent({ ...SESSION, utilization: null })).toBe('within limits')
    expect(usagePercent({ ...SESSION, utilization: null, level: UsageLevel.Warning })).toBe('near limit')
    expect(usagePercent({ ...SESSION, utilization: null, level: UsageLevel.Limited })).toBe('limit reached')
  })

  it('fills the ring and bar by how much is used, all of it at the limit', () => {
    expect(usageFraction(SESSION)).toBe(0.38)
    expect(usageFraction({ ...SESSION, utilization: null })).toBe(0)
    expect(usageFraction({ ...SESSION, utilization: 1.4, level: UsageLevel.Warning })).toBe(1)
    expect(usageFraction({ ...SESSION, utilization: 0.4, level: UsageLevel.Limited })).toBe(1)
  })

  it('says when a limit resets: the time today, the day and time after', () => {
    expect(usageResets(SESSION, NOW)).toBe('resets 15:40')
    expect(usageResets(WEEK, NOW)).toBe('resets Oct 1 09:00')
    expect(usageResets({ ...SESSION, resetsAt: null }, NOW)).toBeNull()
    expect(usageResetsAt(SESSION, NOW)).toBe('Resets at 15:40')
    expect(usageResetsAt({ ...SESSION, resetsAt: null }, NOW)).toBeNull()
  })

  it('says how long ago the newest reading was taken', () => {
    expect(usageUpdated([], NOW)).toBeNull()
    expect(usageUpdated([{ ...SESSION, readAt: NOW - 59_000 }], NOW)).toBe('updated just now')
    expect(usageUpdated([SESSION, { ...WEEK, readAt: NOW - HOUR }], NOW)).toBe('updated 2 min ago')
    expect(usageUpdated([{ ...SESSION, readAt: NOW - 3 * HOUR - MINUTE }], NOW)).toBe('updated 3 h ago')
    expect(usageUpdated([{ ...SESSION, readAt: NOW - 50 * HOUR }], NOW)).toBe('updated 2 d ago')
  })
})

/** Extra usage's reading as the usage call gives it: CA$12.34 spent with no cap, and available, unless said. */
function extra(
  spend: Partial<ExtraUsageSpend> | null = {},
  fields: Partial<UsageReading> = {},
  available = true,
): UsageReading {
  return {
    limit: { kind: UsageLimitKind.ExtraUsage },
    utilization: null,
    resetsAt: null,
    level: UsageLevel.Within,
    readAt: NOW - 2 * MINUTE,
    extraUsage: {
      available,
      spend: spend === null ? null : { spent: 1234, cap: null, currency: 'CAD', decimalPlaces: 2, ...spend },
    },
    ...fields,
  }
}

describe('usageSpend (#530)', () => {
  it('says what’s been spent, in the account’s currency, from its minor units', () => {
    expect(usageSpend(extra())).toEqual({ amount: 'CA$12.34', rest: 'spent' })
    expect(usageSpend(extra({ currency: 'USD' }))).toEqual({ amount: '$12.34', rest: 'spent' })
    expect(usageSpend(extra({ spent: 0 }))).toEqual({ amount: 'CA$0.00', rest: 'spent' })
    expect(usageSpend(extra({ spent: 123456 }))).toEqual({ amount: 'CA$1,234.56', rest: 'spent' })
    // Whole cents show as two places, and a part of a cent rounds to the cent.
    expect(usageSpend(extra({ spent: 1200 }))?.amount).toBe('CA$12.00')
    expect(usageSpend(extra({ spent: 1234.4 }))?.amount).toBe('CA$12.34')
  })

  it('sets it against the monthly cap, when there is one', () => {
    expect(usageSpend(extra({ cap: 5000 }))).toEqual({ amount: 'CA$12.34', rest: 'of CA$50.00' })
    expect(usageSpend(extra({ cap: 5000, currency: 'USD' }))).toEqual({ amount: '$12.34', rest: 'of $50.00' })
    expect(usageSpend(extra({ spent: 6000, cap: 5000 }))).toEqual({ amount: 'CA$60.00', rest: 'of CA$50.00' })
    expect(usageSpend(extra({ spent: 0, cap: 0 }))).toEqual({ amount: 'CA$0.00', rest: 'of CA$0.00' })
  })

  it('divides by the currency’s own decimal places: none for yen, three for dinars', () => {
    expect(usageSpend(extra({ currency: 'JPY', decimalPlaces: 0 }))).toEqual({ amount: '¥1,234', rest: 'spent' })
    expect(usageSpend(extra({ currency: 'JPY', decimalPlaces: 0, cap: 500000 }))?.rest).toBe('of ¥500,000')
    expect(usageSpend(extra({ currency: 'KWD', decimalPlaces: 3 }))?.amount).toMatch(/^KWD\s1\.234$/)
    // The call's places, not the currency's usual ones: the minor unit is what the call says it is.
    expect(usageSpend(extra({ currency: 'JPY', decimalPlaces: 2 }))?.amount).toBe('¥12.34')
  })

  it('names a currency it has no symbol for by its code', () => {
    expect(usageSpend(extra({ currency: 'XTS' }))?.amount).toMatch(/^XTS\s12\.34$/)
  })

  it('has no amount for a currency or places Intl rejects, rather than a wrong one', () => {
    expect(usageSpend(extra({ currency: 'dollars' }))).toBeNull()
    expect(usageSpend(extra({ currency: '' }))).toBeNull()
    expect(usageSpend(extra({ currency: 'C4D', cap: 5000 }))).toBeNull()
    expect(usageSpend(extra({ decimalPlaces: 400 }))).toBeNull()
    expect(usageSpend(extra({ decimalPlaces: -1 }))).toBeNull()
  })

  it('has none when the usage call gave none, and for every other limit', () => {
    expect(usageSpend(extra(null))).toBeNull()
    expect(usageSpend({ ...extra(), extraUsage: undefined })).toBeNull()
    expect(usageSpend(SESSION)).toBeNull()
  })
})

describe('usageBar (#530)', () => {
  it('draws no bar for money spent with no cap: there’s nothing for it to be a fraction of', () => {
    expect(usageBar(extra())).toBeNull()
    expect(usageBar(extra({ spent: 0 }))).toBeNull()
  })

  it('draws how much of the cap is spent, and all of it at the limit', () => {
    expect(usageBar(extra({ spent: 1250, cap: 5000 }, { utilization: 0.25 }))).toBe(0.25)
    expect(usageBar(extra({ spent: 6000, cap: 5000 }, { utilization: 1.2, level: UsageLevel.Limited }))).toBe(1)
    // Nothing spent of a cap is an empty bar, not none.
    expect(usageBar(extra({ spent: 0, cap: 5000 }, { utilization: 0 }))).toBe(0)
    // With no cap, a rate limit event can still say extra usage ran out, or how much is used.
    expect(usageBar(extra({}, { level: UsageLevel.Limited }))).toBe(1)
    expect(usageBar(extra({}, { utilization: 0.4 }))).toBe(0.4)
  })

  it('draws every other reading as before', () => {
    expect(usageBar(SESSION)).toBe(0.38)
    expect(usageBar({ ...SESSION, utilization: null })).toBe(0)
    // Extra usage with no amount the meter can show keeps its empty bar.
    expect(usageBar(extra(null))).toBe(0)
    expect(usageBar({ ...extra(), extraUsage: undefined })).toBe(0)
    expect(usageBar(extra({ currency: 'dollars' }))).toBe(0)
  })
})

describe('usageMeterState, while the account runs on extra usage (#530)', () => {
  const SPENT_SESSION: UsageReading = { ...SESSION, utilization: 1, level: UsageLevel.Limited }

  it('shows extra usage once a plan limit is spent and extra usage is available', () => {
    const running = extra()
    expect(usageMeterState(LOGIN, [SPENT_SESSION, WEEK, running], NOW)).toEqual({
      kind: UsageMeterKind.ExtraUsage,
      reading: running,
    })
    // Any plan limit: the week, or one model's.
    const spentOpus = { ...OPUS, utilization: null, level: UsageLevel.Limited }
    expect(usageMeterState(LOGIN, [SESSION, WEEK, spentOpus, running], NOW).kind).toBe(UsageMeterKind.ExtraUsage)
    // With a cap, close to it or not.
    const capped = extra({ spent: 4000, cap: 5000 }, { utilization: 0.8, level: UsageLevel.Warning })
    expect(usageMeterState(LOGIN, [SPENT_SESSION, capped], NOW)).toEqual({
      kind: UsageMeterKind.ExtraUsage,
      reading: capped,
    })
    // And with no amount it can show: it's still what the account runs on.
    expect(usageMeterState(LOGIN, [SPENT_SESSION, extra(null)], NOW).kind).toBe(UsageMeterKind.ExtraUsage)
  })

  it('still shows it once a turn’s rate limit event lets requests through on a spent limit', () => {
    // Requests the SDK lets through are never "at the limit": the event leaves the session at 100%, close to it.
    const allowed = { ...SESSION, utilization: 1, level: UsageLevel.Warning }
    expect(usageMeterState(LOGIN, [allowed, WEEK, extra()], NOW).kind).toBe(UsageMeterKind.ExtraUsage)
    expect(usageMeterState(LOGIN, [{ ...allowed, utilization: 1.3 }, extra()], NOW).kind).toBe(
      UsageMeterKind.ExtraUsage,
    )
  })

  it('keeps the limit that ran out, "limited", when extra usage isn’t available', () => {
    const limited = { kind: UsageMeterKind.Limited, reading: SPENT_SESSION }
    // Off: no reading of it at all.
    expect(usageMeterState(LOGIN, [SPENT_SESSION, WEEK], NOW)).toEqual(limited)
    // On, but the call didn't say it can take requests (disabled, its spend limit reached, its cap spent).
    expect(usageMeterState(LOGIN, [SPENT_SESSION, WEEK, extra({}, {}, false)], NOW)).toEqual(limited)
    // Only a rate limit event has told of it: nothing says it's available.
    expect(usageMeterState(LOGIN, [SPENT_SESSION, { ...extra(), extraUsage: undefined }], NOW)).toEqual(limited)
    // Said available, and since turned away itself.
    expect(usageMeterState(LOGIN, [SPENT_SESSION, extra({}, { level: UsageLevel.Limited })], NOW)).toEqual(limited)
  })

  it('shows the limit closest to running out, as ever, while no plan limit is spent', () => {
    expect(usageMeterState(LOGIN, [SESSION, WEEK, extra()], NOW)).toEqual({
      kind: UsageMeterKind.Normal,
      reading: SESSION,
    })
    // Extra usage close to its own cap is the closest, and its own cap spent is its own limit: neither is a plan's.
    const close = extra({ spent: 4000, cap: 5000 }, { utilization: 0.8, level: UsageLevel.Warning })
    expect(usageMeterState(LOGIN, [SESSION, close], NOW)).toEqual({ kind: UsageMeterKind.Warning, reading: close })
    const over = extra({ spent: 6000, cap: 5000 }, { utilization: 1.2, level: UsageLevel.Limited }, false)
    expect(usageMeterState(LOGIN, [SESSION, over], NOW)).toEqual({ kind: UsageMeterKind.Limited, reading: over })
    // A spent limit whose window has reset is spent no more.
    const reset = { ...SPENT_SESSION, resetsAt: NOW }
    expect(usageMeterState(LOGIN, [reset, WEEK, extra()], NOW)).toEqual({ kind: UsageMeterKind.Normal, reading: WEEK })
  })

  it('stays hidden for an account plan limits don’t apply to', () => {
    expect(usageMeterState(API_KEY, [SPENT_SESSION, extra()], NOW)).toEqual({ kind: UsageMeterKind.Hidden })
  })
})
