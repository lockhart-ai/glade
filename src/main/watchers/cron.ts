/**
 * When a `CronCreate` job is next due: the next minute its 5-field cron expression matches, in local time, as Claude
 * Code reads it ("M H DoM Mon DoW", `docs/sdk-notes.md` §11). Each field is `*`, a number, a range (`1-5`), a step
 * (`*\/10`, `0-30/5`) or a list of those (`1,15,30`); a day of the week is 0–7, both 0 and 7 being Sunday. As in cron,
 * when both the day of the month and the day of the week are restricted, a day matching either matches.
 */
import type { EpochMs } from '../../shared/domain'

/** One field's allowed values, and whether it was `*` (for the day-of-month/day-of-week rule). */
interface Field {
  readonly values: ReadonlySet<number>
  readonly any: boolean
}

interface Schedule {
  readonly minutes: Field
  readonly hours: Field
  readonly days: Field
  readonly months: Field
  readonly weekdays: Field
}

/** How far ahead a match is looked for before giving up: a schedule that never matches (Feb 30th) has no next time. */
const HORIZON_DAYS = 366 * 5

function parseField(text: string, min: number, max: number): Field | null {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (match === null) return null
    const [, whole, from, to, step] = match
    const start = whole === '*' ? min : Number(from)
    const end = whole === '*' ? max : to === undefined ? (step === undefined ? start : max) : Number(to)
    const by = step === undefined ? 1 : Number(step)
    if (start < min || end > max || start > end || by < 1) return null
    for (let value = start; value <= end; value += by) values.add(value)
  }
  return { values, any: text === '*' }
}

function parseSchedule(expression: string): Schedule | null {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = parts
  const minutes = parseField(minute, 0, 59)
  const hours = parseField(hour, 0, 23)
  const days = parseField(day, 1, 31)
  const months = parseField(month, 1, 12)
  const weekdays = parseField(weekday, 0, 7)
  if (minutes === null || hours === null || days === null || months === null || weekdays === null) return null
  // Sunday is 0 and 7 alike.
  const sundays = weekdays.values.has(7) ? new Set([...weekdays.values, 0]) : weekdays.values
  return { minutes, hours, days, months, weekdays: { values: sundays, any: weekdays.any } }
}

function dayMatches(schedule: Schedule, date: Date): boolean {
  const { days, weekdays } = schedule
  const byDay = days.values.has(date.getDate())
  const byWeekday = weekdays.values.has(date.getDay())
  if (!days.any && !weekdays.any) return byDay || byWeekday
  return byDay && byWeekday
}

/**
 * The first time after `after` (to the minute, local time) that `expression` matches; null for an expression that
 * isn't a valid 5-field cron, or one that never matches.
 */
export function nextCronTime(expression: string, after: EpochMs): EpochMs | null {
  const schedule = parseSchedule(expression)
  if (schedule === null) return null
  const date = new Date(after)
  date.setSeconds(0, 0)
  date.setMinutes(date.getMinutes() + 1)
  const limit = after + HORIZON_DAYS * 24 * 60 * 60 * 1000
  while (date.getTime() <= limit) {
    if (!schedule.months.values.has(date.getMonth() + 1)) {
      date.setMonth(date.getMonth() + 1, 1)
      date.setHours(0, 0)
    } else if (!dayMatches(schedule, date)) {
      date.setDate(date.getDate() + 1)
      date.setHours(0, 0)
    } else if (!schedule.hours.values.has(date.getHours())) {
      date.setHours(date.getHours() + 1, 0)
    } else if (!schedule.minutes.values.has(date.getMinutes())) {
      date.setMinutes(date.getMinutes() + 1)
    } else {
      return date.getTime()
    }
  }
  return null
}
