import { afterEach, describe, expect, it, vi } from 'vitest'
import { ArtifactDateGroup, type EpochMs } from '../../shared/domain'
import { DATE_GROUPS, dateGroupOf, dateGroupTitle, groupByDate, isGroupOpen, opensByDefault } from './dateGroups'

const { Today, Yesterday, ThisWeek, LastWeek, ThisMonth, Older } = ArtifactDateGroup

/** A local time: `month` counts from 1, as a calendar does. */
function local(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0): EpochMs {
  return new Date(year, month - 1, day, hours, minutes, seconds).getTime()
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('dateGroupOf', () => {
  // Saturday 26 September 2026, mid-afternoon.
  const now = local(2026, 9, 26, 14, 20)

  it('puts each day of a month in its group, seen from a Saturday', () => {
    const cases: [EpochMs, ArtifactDateGroup][] = [
      [now, Today],
      [local(2026, 9, 26, 0, 0), Today],
      [local(2026, 9, 25, 23, 59, 59), Yesterday],
      [local(2026, 9, 25, 0, 0), Yesterday],
      [local(2026, 9, 24, 23, 59), ThisWeek],
      // Monday: the week starts.
      [local(2026, 9, 21, 0, 0), ThisWeek],
      [local(2026, 9, 20, 23, 59), LastWeek],
      [local(2026, 9, 14, 0, 0), LastWeek],
      [local(2026, 9, 13, 23, 59), ThisMonth],
      [local(2026, 9, 1, 0, 0), ThisMonth],
      [local(2026, 8, 31, 23, 59, 59), Older],
      [local(2025, 9, 26, 14, 20), Older],
      [0, Older],
    ]
    for (const [at, group] of cases) expect(dateGroupOf(at, now), new Date(at).toString()).toBe(group)
  })

  it('moves a time into Yesterday at midnight, and the rest along a day', () => {
    const at = local(2026, 9, 26, 23, 58)
    expect(dateGroupOf(at, local(2026, 9, 26, 23, 59, 59))).toBe(Today)
    expect(dateGroupOf(at, local(2026, 9, 27, 0, 0))).toBe(Yesterday)
    // Sunday: Saturday is yesterday, and Friday still this week.
    expect(dateGroupOf(local(2026, 9, 25, 12, 0), local(2026, 9, 27, 0, 0))).toBe(ThisWeek)
  })

  it('starts a new week on Monday: last week’s days move to Last week, and the week before’s out of it', () => {
    // Monday 28 September: yesterday is Sunday, and there's nothing earlier this week.
    const monday = local(2026, 9, 28, 9, 0)
    expect(dateGroupOf(local(2026, 9, 27, 18, 0), monday)).toBe(Yesterday)
    expect(dateGroupOf(local(2026, 9, 26, 18, 0), monday)).toBe(LastWeek)
    expect(dateGroupOf(local(2026, 9, 21, 0, 0), monday)).toBe(LastWeek)
    expect(dateGroupOf(local(2026, 9, 20, 23, 59), monday)).toBe(ThisMonth)
    // Tuesday: Monday is yesterday, so the week so far holds nothing earlier either.
    const tuesday = local(2026, 9, 29, 9, 0)
    expect(dateGroupOf(local(2026, 9, 28, 0, 0), tuesday)).toBe(Yesterday)
    expect(dateGroupOf(local(2026, 9, 27, 23, 59), tuesday)).toBe(LastWeek)
    // Sunday: the week is six days in.
    const sunday = local(2026, 10, 4, 22, 0)
    expect(dateGroupOf(local(2026, 9, 28, 0, 0), sunday)).toBe(ThisWeek)
    expect(dateGroupOf(local(2026, 9, 27, 23, 59), sunday)).toBe(LastWeek)
  })

  it('starts a new month on the 1st: last month’s days are Older unless they were yesterday or in a week shown', () => {
    // Thursday 1 October.
    const first = local(2026, 10, 1, 9, 0)
    expect(dateGroupOf(local(2026, 9, 30, 12, 0), first)).toBe(Yesterday)
    expect(dateGroupOf(local(2026, 9, 29, 12, 0), first)).toBe(ThisWeek)
    expect(dateGroupOf(local(2026, 9, 28, 0, 0), first)).toBe(ThisWeek)
    expect(dateGroupOf(local(2026, 9, 27, 12, 0), first)).toBe(LastWeek)
    expect(dateGroupOf(local(2026, 9, 21, 0, 0), first)).toBe(LastWeek)
    expect(dateGroupOf(local(2026, 9, 20, 23, 59), first)).toBe(Older)
  })

  it('crosses a year like a month', () => {
    // Friday 1 January 2027.
    const newYear = local(2027, 1, 1, 10, 0)
    expect(dateGroupOf(local(2026, 12, 31, 23, 0), newYear)).toBe(Yesterday)
    expect(dateGroupOf(local(2026, 12, 28, 0, 0), newYear)).toBe(ThisWeek)
    expect(dateGroupOf(local(2026, 12, 27, 23, 59), newYear)).toBe(LastWeek)
    expect(dateGroupOf(local(2026, 12, 20, 23, 59), newYear)).toBe(Older)
  })

  it('counts a time after now as today', () => {
    expect(dateGroupOf(now + 60_000, now)).toBe(Today)
    expect(dateGroupOf(local(2026, 9, 30), now)).toBe(Today)
  })

  it('goes by calendar days in the local time zone, across a daylight-saving change', () => {
    vi.stubEnv('TZ', 'America/Toronto')
    // 8 March 2026 is 23 hours long there: clocks go forward.
    expect(local(2026, 3, 9) - local(2026, 3, 8)).toBe(23 * 3_600_000)
    const monday = local(2026, 3, 9, 0, 30)
    expect(dateGroupOf(local(2026, 3, 8, 0, 0), monday)).toBe(Yesterday)
    // Within 24 hours of midnight, but two calendar days back: last week, not yesterday.
    expect(dateGroupOf(local(2026, 3, 7, 23, 30), monday)).toBe(LastWeek)
    // 1 November 2026 is 25 hours long: clocks go back.
    expect(local(2026, 11, 2) - local(2026, 11, 1)).toBe(25 * 3_600_000)
    const afterFallBack = local(2026, 11, 2, 0, 10)
    expect(dateGroupOf(local(2026, 11, 1, 0, 0), afterFallBack)).toBe(Yesterday)
    expect(dateGroupOf(local(2026, 10, 31, 23, 59), afterFallBack)).toBe(LastWeek)
  })

  it('follows the local time zone, not UTC', () => {
    // 23:30 on Friday in Tokyo is still Friday there, though it's 14:30 UTC.
    vi.stubEnv('TZ', 'Asia/Tokyo')
    const saturday = local(2026, 9, 26, 0, 30)
    expect(dateGroupOf(local(2026, 9, 25, 23, 30), saturday)).toBe(Yesterday)
    expect(dateGroupOf(local(2026, 9, 26, 0, 0), saturday)).toBe(Today)
    vi.stubEnv('TZ', 'America/Los_Angeles')
    expect(dateGroupOf(local(2026, 9, 25, 23, 30), local(2026, 9, 26, 0, 30))).toBe(Yesterday)
  })
})

describe('groupByDate', () => {
  const now = local(2026, 9, 26, 14, 20)
  const item = (name: string, at: EpochMs) => ({ name, at })

  it('puts items in the groups that hold any, newest group first, keeping their order within each', () => {
    const items = [
      item('landing', local(2026, 9, 26, 14, 12)),
      item('old', local(2026, 1, 3)),
      item('changelog', local(2026, 9, 26, 14, 6)),
      item('search', local(2026, 9, 25, 16, 0)),
      item('nav', local(2026, 9, 25, 15, 2)),
      item('ia', local(2026, 9, 2)),
    ]

    const grouped = groupByDate(items, ({ at }) => at, now)

    expect(grouped.map(({ group, items: members }) => [group, members.map(({ name }) => name)])).toEqual([
      [Today, ['landing', 'changelog']],
      [Yesterday, ['search', 'nav']],
      [ThisMonth, ['ia']],
      [Older, ['old']],
    ])
  })

  it('makes a single group of items all on one day, and none of no items', () => {
    const items = Array.from({ length: 5 }, (_, index) => item(String(index), local(2026, 9, 22, index)))
    expect(groupByDate(items, ({ at }) => at, now)).toEqual([{ group: ThisWeek, items }])
    expect(groupByDate([], () => now, now)).toEqual([])
  })

  it('sorts hundreds of items quickly', () => {
    const items = Array.from({ length: 5_000 }, (_, index) => item(String(index), now - index * 3_600_000))
    const started = performance.now()
    const grouped = groupByDate(items, ({ at }) => at, now)
    expect(performance.now() - started).toBeLessThan(250)
    expect(grouped.map(({ group }) => group)).toEqual(DATE_GROUPS)
    expect(grouped.reduce((total, { items: members }) => total + members.length, 0)).toBe(5_000)
  })
})

describe('the groups', () => {
  it('are titled as the design has them, in order', () => {
    expect(DATE_GROUPS.map(dateGroupTitle)).toEqual([
      'Today',
      'Yesterday',
      'This week',
      'Last week',
      'This month',
      'Older',
    ])
    expect(new Set(DATE_GROUPS)).toEqual(new Set(Object.values(ArtifactDateGroup)))
  })

  it('open Today and Yesterday to begin with, and fold the rest, until you open or fold one', () => {
    expect(DATE_GROUPS.filter(opensByDefault)).toEqual([Today, Yesterday])
    const folds = [
      { group: Today, open: false },
      { group: Older, open: true },
    ]
    expect(DATE_GROUPS.filter((group) => isGroupOpen(group, folds))).toEqual([Yesterday, Older])
    expect(DATE_GROUPS.filter((group) => isGroupOpen(group, []))).toEqual([Today, Yesterday])
  })
})
