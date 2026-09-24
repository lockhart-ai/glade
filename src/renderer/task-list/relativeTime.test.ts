import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatRelativeTime } from './relativeTime'

const NOW = Date.UTC(2026, 8, 23, 11, 30)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('formatRelativeTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [0, 'now'],
    [59 * SECOND, 'now'],
    [MINUTE, '1m'],
    [4 * MINUTE + 59 * SECOND, '4m'],
    [59 * MINUTE, '59m'],
    [HOUR, '1h'],
    [2 * HOUR + 30 * MINUTE, '2h'],
    [23 * HOUR, '23h'],
    [DAY, '1d'],
    [3 * DAY, '3d'],
    [6 * DAY + 23 * HOUR, '6d'],
    [7 * DAY, '1w'],
    [20 * DAY, '2w'],
    [400 * DAY, '57w'],
  ])('shows %i ms ago as %s', (ago, expected) => {
    expect(formatRelativeTime(NOW - ago)).toBe(expected)
  })

  it('shows a time in the future as now', () => {
    expect(formatRelativeTime(NOW + HOUR)).toBe('now')
  })

  it('measures from the current time as it moves on', () => {
    const at = Date.now()
    vi.advanceTimersByTime(5 * MINUTE)

    expect(formatRelativeTime(at)).toBe('5m')
  })

  it('measures from a given time', () => {
    expect(formatRelativeTime(1_000, 1_000 + 2 * HOUR)).toBe('2h')
  })
})
