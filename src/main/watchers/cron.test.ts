import { describe, expect, it } from 'vitest'
import { nextCronTime } from './cron'

/** A local time, as cron reads it. */
function at(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime()
}

describe('nextCronTime', () => {
  it('finds the next minute a schedule matches, strictly after the time given', () => {
    const now = at(2026, 9, 25, 13, 7, 30)
    expect(nextCronTime('* * * * *', now)).toBe(at(2026, 9, 25, 13, 8))
    expect(nextCronTime('*/10 * * * *', now)).toBe(at(2026, 9, 25, 13, 10))
    expect(nextCronTime('7 * * * *', now)).toBe(at(2026, 9, 25, 14, 7))
    expect(nextCronTime('0 9 * * *', now)).toBe(at(2026, 9, 26, 9, 0))
    // On the minute itself, the next one is a minute later.
    expect(nextCronTime('* * * * *', at(2026, 9, 25, 13, 8))).toBe(at(2026, 9, 25, 13, 9))
  })

  it('reads ranges, steps and lists', () => {
    const now = at(2026, 9, 25, 13, 7)
    expect(nextCronTime('0-30/15 13 * * *', now)).toBe(at(2026, 9, 25, 13, 15))
    expect(nextCronTime('5/20 * * * *', now)).toBe(at(2026, 9, 25, 13, 25))
    expect(nextCronTime('1,15,30 13 * * *', now)).toBe(at(2026, 9, 25, 13, 15))
    expect(nextCronTime('30 14 25 9 *', now)).toBe(at(2026, 9, 25, 14, 30))
    expect(nextCronTime('0 0 1 1 *', now)).toBe(at(2027, 1, 1))
  })

  it('reads days of the week, Sunday as 0 or 7, and matches either day when both are set, as cron does', () => {
    // 25 September 2026 is a Friday.
    const friday = at(2026, 9, 25, 13, 7)
    expect(nextCronTime('0 9 * * 1-5', friday)).toBe(at(2026, 9, 28, 9, 0))
    expect(nextCronTime('0 9 * * 0', friday)).toBe(at(2026, 9, 27, 9, 0))
    expect(nextCronTime('0 9 * * 7', friday)).toBe(at(2026, 9, 27, 9, 0))
    // The 1st of the month, or any Monday: Monday the 28th comes first.
    expect(nextCronTime('0 9 1 * 1', friday)).toBe(at(2026, 9, 28, 9, 0))
    // Only the day of the month is set: the weekday doesn't matter.
    expect(nextCronTime('0 9 1 * *', friday)).toBe(at(2026, 10, 1, 9, 0))
  })

  it('has no next time for an expression that is not a 5-field cron, or one that never matches', () => {
    const now = at(2026, 9, 25, 13, 7)
    for (const bad of [
      '',
      '* * * *',
      '* * * * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
    ]) {
      expect(nextCronTime(bad, now), bad).toBeNull()
    }
    for (const bad of ['a * * * *', '5-1 * * * *', '*/0 * * * *', '1,,2 * * * *']) {
      expect(nextCronTime(bad, now), bad).toBeNull()
    }
    expect(nextCronTime('0 0 30 2 *', now)).toBeNull()
  })
})
