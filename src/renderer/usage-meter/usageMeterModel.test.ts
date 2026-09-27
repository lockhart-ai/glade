import { describe, expect, it } from 'vitest'
import { UsageLevel, UsageLimitKind, type Account, type UsageReading } from '../../shared/account'
import {
  currentReadings,
  usageFraction,
  usageLimitLabel,
  usageLimitReachedLabel,
  UsageMeterKind,
  usageMeterState,
  usagePercent,
  usageResets,
  usageResetsAt,
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
