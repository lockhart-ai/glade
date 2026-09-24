import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentErrorKind, PauseReason } from '../../shared/domain'
import {
  checkedOffline,
  createPauseTimers,
  MAX_TIMER_MS,
  OFFLINE_FIRST_CHECK_MS,
  OFFLINE_MAX_CHECK_MS,
  offlineCheckDelay,
  pauseFor,
  pauseReason,
  USAGE_LIMIT_FALLBACK_MS,
} from './pauses'

const NOW = 1_790_000_000_000

describe('pauseReason', () => {
  it('pauses on a usage limit or offline, and stops on any other error', () => {
    expect(pauseReason({ kind: AgentErrorKind.UsageLimit })).toBe(PauseReason.UsageLimit)
    expect(pauseReason({ kind: AgentErrorKind.Offline })).toBe(PauseReason.Offline)
    expect(pauseReason({ kind: AgentErrorKind.Transient })).toBeNull()
    expect(pauseReason({ kind: AgentErrorKind.Permanent })).toBeNull()
  })
})

describe('pauseFor', () => {
  it('resumes a usage limit when the rejecting limit resets', () => {
    const limit = { rejected: true, resetsAt: NOW + 30 * 60_000 }

    expect(pauseFor(PauseReason.UsageLimit, 'Limit.', limit, NOW)).toEqual({
      reason: PauseReason.UsageLimit,
      since: NOW,
      resumesAt: NOW + 30 * 60_000,
      checks: 0,
      details: 'Limit.',
    })
  })

  it.each([
    ['no word from the SDK', null],
    ['a limit that is not rejecting', { rejected: false, resetsAt: NOW + 60_000 }],
    ['no reset time', { rejected: true, resetsAt: null }],
    ['a reset time already past', { rejected: true, resetsAt: NOW - 1 }],
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
