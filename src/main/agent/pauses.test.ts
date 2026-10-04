import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  UsageLevel,
  usageLevel,
  UsageLimitKind,
  type UsageLimit,
  type UsageReading,
  type UsageSnapshot,
} from '../../shared/account'
import { AgentErrorKind, PauseReason, type TaskPause } from '../../shared/domain'
import {
  canRunAgain,
  checkedOffline,
  createPauseTimers,
  MAX_TIMER_MS,
  OFFLINE_FIRST_CHECK_MS,
  OFFLINE_MAX_CHECK_MS,
  offlineCheckDelay,
  pauseFor,
  pauseReason,
  RunAgainReason,
  USAGE_LIMIT_FALLBACK_MS,
  USAGE_RECHECK_MIN_GAP_MS,
  USAGE_RECHECK_MS,
} from './pauses'

const NOW = 1_790_000_000_000
const SESSION: UsageLimit = { kind: UsageLimitKind.Session }
const OPUS_WEEK: UsageLimit = { kind: UsageLimitKind.WeeklyModel, model: 'Opus' }

describe('pauseReason', () => {
  it('pauses on a usage limit or offline, and stops on any other error', () => {
    expect(pauseReason({ kind: AgentErrorKind.UsageLimit })).toBe(PauseReason.UsageLimit)
    expect(pauseReason({ kind: AgentErrorKind.Offline })).toBe(PauseReason.Offline)
    expect(pauseReason({ kind: AgentErrorKind.Transient })).toBeNull()
    expect(pauseReason({ kind: AgentErrorKind.Permanent })).toBeNull()
    expect(pauseReason({ kind: AgentErrorKind.SafetyRefusal })).toBeNull()
  })

  it('stops on a lost login: nothing to wait out, you log in and retry', () => {
    expect(pauseReason({ kind: AgentErrorKind.LoggedOut })).toBeNull()
  })
})

describe('pauseFor', () => {
  it('resumes a usage limit when the rejecting limit resets, and keeps which limit it was', () => {
    const limit = { rejected: true, resetsAt: NOW + 30 * 60_000, limit: OPUS_WEEK }

    expect(pauseFor(PauseReason.UsageLimit, 'Limit.', limit, NOW)).toEqual({
      reason: PauseReason.UsageLimit,
      since: NOW,
      resumesAt: NOW + 30 * 60_000,
      checks: 0,
      details: 'Limit.',
      limit: OPUS_WEEK,
    })
  })

  it('names no limit when the SDK named a window Glade doesn’t know, or the limit wasn’t rejecting', () => {
    const unknown = { rejected: true, resetsAt: NOW + 60_000, limit: null }
    const allowed = { rejected: false, resetsAt: NOW + 60_000, limit: SESSION }

    expect(pauseFor(PauseReason.UsageLimit, 'Limit.', unknown, NOW)).not.toHaveProperty('limit')
    expect(pauseFor(PauseReason.UsageLimit, 'Limit.', allowed, NOW)).not.toHaveProperty('limit')
    expect(pauseFor(PauseReason.UsageLimit, 'Limit.', null, NOW)).not.toHaveProperty('limit')
    expect(pauseFor(PauseReason.Offline, 'Connection error.', unknown, NOW)).not.toHaveProperty('limit')
  })

  it.each([
    ['no word from the SDK', null],
    ['a limit that is not rejecting', { rejected: false, resetsAt: NOW + 60_000, limit: SESSION }],
    ['no reset time', { rejected: true, resetsAt: null, limit: SESSION }],
    ['a reset time already past', { rejected: true, resetsAt: NOW - 1, limit: SESSION }],
  ])('tries a usage limit again after a while, given %s', (_, limit) => {
    expect(pauseFor(PauseReason.UsageLimit, 'Limit.', limit, NOW).resumesAt).toBe(NOW + USAGE_LIMIT_FALLBACK_MS)
  })

  it('checks for the network soon after going offline', () => {
    expect(pauseFor(PauseReason.Offline, 'Connection error.', null, NOW)).toEqual({
      reason: PauseReason.Offline,
      since: NOW,
      resumesAt: NOW + OFFLINE_FIRST_CHECK_MS,
      checks: 0,
      details: 'Connection error.',
    })
  })
})

describe('reading usage again', () => {
  it('is every few minutes: sooner than the blind retry, and never twice within seconds', () => {
    expect(USAGE_RECHECK_MS).toBeGreaterThanOrEqual(2 * 60_000)
    expect(USAGE_RECHECK_MS).toBeLessThan(USAGE_LIMIT_FALLBACK_MS)
    expect(USAGE_RECHECK_MIN_GAP_MS).toBeLessThan(USAGE_RECHECK_MS)
  })
})

describe('canRunAgain', () => {
  const HOUR = 3_600_000
  const reading = (limit: UsageLimit, utilization: number | null, level = usageLevel(utilization)): UsageReading => ({
    limit,
    utilization,
    resetsAt: limit.kind === UsageLimitKind.ExtraUsage ? null : NOW + HOUR,
    level,
    readAt: NOW,
  })
  const pausedOn = (limit?: UsageLimit, reason = PauseReason.UsageLimit): TaskPause => ({
    reason,
    since: NOW - 60_000,
    resumesAt: NOW + HOUR,
    checks: 0,
    details: 'Limit.',
    ...(limit === undefined ? {} : { limit }),
  })
  const usage = (readings: readonly UsageReading[], extraUsageAvailable = false): UsageSnapshot => ({
    readings,
    extraUsageAvailable,
  })
  const EXTRA: UsageLimit = { kind: UsageLimitKind.ExtraUsage }
  const WEEK: UsageLimit = { kind: UsageLimitKind.Weekly }
  const CLEARED = RunAgainReason.LimitCleared
  const BY_EXTRA = RunAgainReason.ExtraUsage

  it.each<[string, TaskPause, UsageSnapshot, RunAgainReason | null]>([
    // The limit that turned the turn away.
    ['its limit is still spent', pausedOn(SESSION), usage([reading(SESSION, 1)]), null],
    ['its limit is past spent', pausedOn(SESSION), usage([reading(SESSION, 1.04)]), null],
    ['its limit has room again', pausedOn(SESSION), usage([reading(SESSION, 0.2)]), CLEARED],
    ['its limit is close, but under', pausedOn(SESSION), usage([reading(SESSION, 0.99)]), CLEARED],
    [
      'its limit is said to be at the limit, whatever the amount',
      pausedOn(SESSION),
      usage([reading(SESSION, 0.4, UsageLevel.Limited)]),
      null,
    ],
    [
      'another limit has room, its own is spent',
      pausedOn(OPUS_WEEK),
      usage([reading(OPUS_WEEK, 1), reading(WEEK, 0.3)]),
      null,
    ],
    [
      'its own has room, another is spent',
      pausedOn(OPUS_WEEK),
      usage([reading(OPUS_WEEK, 0.6), reading(SESSION, 1)]),
      CLEARED,
    ],
    [
      'another model’s week has room',
      pausedOn(OPUS_WEEK),
      usage([reading({ kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' }, 0.1)]),
      null,
    ],
    ['the reading doesn’t tell of its limit', pausedOn(SESSION), usage([reading(WEEK, 0.3)]), null],
    ['the reading tells of nothing', pausedOn(SESSION), usage([]), null],
    // A pause that doesn't say which limit it was is never guessed at.
    ['no limit named, every limit has room', pausedOn(), usage([reading(SESSION, 0.1), reading(WEEK, 0.1)]), null],
    // Extra usage.
    ['extra usage is on with room', pausedOn(SESSION), usage([reading(SESSION, 1), reading(EXTRA, 0)], true), BY_EXTRA],
    [
      'extra usage is on with no cap',
      pausedOn(SESSION),
      usage([reading(SESSION, 1), reading(EXTRA, null)], true),
      BY_EXTRA,
    ],
    ['extra usage is on, no limit named', pausedOn(), usage([reading(EXTRA, 0.5)], true), BY_EXTRA],
    [
      'extra usage is on, though the reading has no row for it',
      pausedOn(SESSION),
      usage([reading(SESSION, 1)], true),
      BY_EXTRA,
    ],
    [
      'extra usage shows a row but isn’t available',
      pausedOn(SESSION),
      usage([reading(SESSION, 1), reading(EXTRA, 0.2)]),
      null,
    ],
    ['extra usage is spent', pausedOn(SESSION), usage([reading(SESSION, 1), reading(EXTRA, 1)]), null],
    [
      'its limit has room and extra usage is on',
      pausedOn(SESSION),
      usage([reading(SESSION, 0.5), reading(EXTRA, 0)], true),
      CLEARED,
    ],
    // Extra usage that turned the turn away is back only when the reading says it's available.
    ['extra usage turned it away, and shows room', pausedOn(EXTRA), usage([reading(EXTRA, 0.4)]), null],
    [
      'extra usage turned it away, and is available again',
      pausedOn(EXTRA),
      usage([reading(EXTRA, 0.4)], true),
      BY_EXTRA,
    ],
    // Offline, the network decides.
    [
      'offline, whatever usage says',
      pausedOn(undefined, PauseReason.Offline),
      usage([reading(SESSION, 0.1)], true),
      null,
    ],
  ])('%s', (_, pause, snapshot, reason) => {
    expect(canRunAgain(pause, snapshot)?.reason ?? null).toBe(reason)
  })

  it('says what the reading said, so a later reading that says the same is told from one that doesn’t', () => {
    const pause = pausedOn(SESSION)
    const before = canRunAgain(pause, usage([reading(SESSION, 1), reading(EXTRA, 0)], true))

    // The same again, read later: nothing new.
    const again = usage(
      [
        { ...reading(SESSION, 1), readAt: NOW + 5 },
        { ...reading(EXTRA, 0), readAt: NOW + 5 },
      ],
      true,
    )
    expect(canRunAgain(pause, again)).toEqual(before)
    // Extra usage being spent, its limit lifting, or a row gone: each is something else.
    const spending = canRunAgain(pause, usage([reading(SESSION, 1), reading(EXTRA, 0.1)], true))
    const lifted = canRunAgain(pause, usage([reading(SESSION, 0.5), reading(EXTRA, 0)], true))
    const rowless = canRunAgain(pause, usage([reading(SESSION, 1)], true))
    const evidence = [before, spending, lifted, rowless].map((verdict) => verdict?.evidence)
    expect(new Set(evidence).size).toBe(4)
    expect(evidence).not.toContain(undefined)
    // What another limit says is no part of it.
    expect(canRunAgain(pause, usage([reading(SESSION, 1), reading(WEEK, 0.7), reading(EXTRA, 0)], true))).toEqual(
      before,
    )
  })
})

describe('offline checks', () => {
  it('wait twice as long each time the network is still down, up to a minute', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(offlineCheckDelay)).toEqual([
      5_000,
      10_000,
      20_000,
      40_000,
      OFFLINE_MAX_CHECK_MS,
      OFFLINE_MAX_CHECK_MS,
      OFFLINE_MAX_CHECK_MS,
    ])
  })

  it('count each check that found the network down', () => {
    const pause = pauseFor(PauseReason.Offline, 'Connection error.', null, NOW)
    const later = checkedOffline(pause, NOW + 5_000)

    expect(later).toEqual({ ...pause, checks: 1, resumesAt: NOW + 5_000 + 10_000 })
    expect(checkedOffline(later, NOW + 15_000)).toMatchObject({ checks: 2, resumesAt: NOW + 15_000 + 20_000 })
  })
})

describe('createPauseTimers', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: NOW })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('calls back with the task when its time comes, and not before', () => {
    const due = vi.fn()
    const timers = createPauseTimers(due)

    timers.arm('t1', NOW + 60_000)
    timers.arm('t2', NOW + 120_000)
    vi.advanceTimersByTime(59_999)
    expect(due).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(due).toHaveBeenCalledExactlyOnceWith('t1')
    vi.advanceTimersByTime(60_000)
    expect(due).toHaveBeenLastCalledWith('t2')
  })

  it('calls back at once for a time already past', () => {
    const due = vi.fn()
    createPauseTimers(due).arm('t1', NOW - 5_000)

    vi.advanceTimersByTime(0)
    expect(due).toHaveBeenCalledExactlyOnceWith('t1')
  })

  it('re-arms a task to its new time, and forgets a disarmed one', () => {
    const due = vi.fn()
    const timers = createPauseTimers(due)

    timers.arm('t1', NOW + 60_000)
    timers.arm('t1', NOW + 120_000)
    timers.arm('t2', NOW + 60_000)
    timers.disarm('t2')
    vi.advanceTimersByTime(60_000)
    expect(due).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(due).toHaveBeenCalledExactlyOnceWith('t1')
  })

  it('waits out a time too far off for one timer in several', () => {
    const due = vi.fn()
    const at = NOW + MAX_TIMER_MS + 1_000
    createPauseTimers(due).arm('t1', at)

    vi.advanceTimersByTime(MAX_TIMER_MS)
    expect(due).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(due).toHaveBeenCalledExactlyOnceWith('t1')
  })

  it('clears every timer on close', () => {
    const due = vi.fn()
    const timers = createPauseTimers(due)
    timers.arm('t1', NOW + 1_000)
    timers.arm('t2', NOW + 2_000)

    timers.close()
    vi.advanceTimersByTime(10_000)
    expect(due).not.toHaveBeenCalled()
  })
})
