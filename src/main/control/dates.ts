/**
 * The dates the control API takes (`docs/control-api.md`, "Dates"): `create_task`'s `startedAt`, `updatedAt` and
 * `statusUpdatedAt`, and `update_task`'s `updatedAt` and `statusUpdatedAt`. Every one is read here, the same way.
 *
 * - A date and time with its offset (`2026-09-25T09:00:00+01:00`) or `Z` is that instant, exactly.
 * - A date alone (`2026-09-25`) is that day where Glade runs: local noon, so it never slips a day in either direction
 *   whatever the time zone, or now when it's today and noon is still to come, so today is never refused as a time to
 *   come.
 * - A date and time without an offset is refused, as it doesn't say which instant it is.
 */
import { z } from 'zod'
import type { EpochMs } from '../../shared/domain'
import { ControlError, ControlErrorCode } from './errors'

/** What a date the API refuses as no date must be instead. */
export const ISO_INSTANT_MESSAGE =
  'must be an ISO 8601 date (2026-09-25) or a date and time with its offset (2026-09-25T09:00:00+01:00, or Z)'

/** A date the API takes, as its schema checks it: an ISO 8601 date, or a date and time with its offset. */
export function isoInstant(description: string): z.ZodType<string> {
  return z.union([z.iso.datetime({ offset: true }), z.iso.date()], { error: ISO_INSTANT_MESSAGE }).describe(description)
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** The hour of the day a date alone stands for, local time. */
const LOCAL_NOON = 12

/**
 * The instant an ISO 8601 value (as `isoInstant` checks it) stands for, as of `now`: `field` names it when it's in the
 * future, or no date at all (`invalid_input`, e.g. `startedAt: 2026-09-26 is in the future`).
 */
export function instantOf(iso: string, field: string, now: EpochMs): EpochMs {
  const at = parseInstant(iso, now)
  if (Number.isNaN(at)) throw new ControlError(ControlErrorCode.InvalidInput, `${field}: ${ISO_INSTANT_MESSAGE}`)
  if (at > now) throw new ControlError(ControlErrorCode.InvalidInput, `${field}: ${iso} is in the future`)
  return at
}

/**
 * The instant an ISO 8601 value stands for, as of `now` (see the file's comment), or NaN when it isn't one. A date
 * alone is local noon that day, or `now` when that's today and before noon.
 */
export function parseInstant(iso: string, now: EpochMs): EpochMs {
  const day = DATE_ONLY.exec(iso)
  if (day === null) return Date.parse(iso)
  const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])]
  const noon = new Date(0)
  // setFullYear, not the Date constructor, which reads the years 0 to 99 as 1900 to 1999.
  noon.setFullYear(year, month, date)
  noon.setHours(LOCAL_NOON, 0, 0, 0)
  // A day that isn't one (February 30th) rolls over into the next month: it's no date.
  if (noon.getFullYear() !== year || noon.getMonth() !== month || noon.getDate() !== date) return Number.NaN
  const today = new Date(now)
  const isToday = today.getFullYear() === year && today.getMonth() === month && today.getDate() === date
  return isToday ? Math.min(noon.getTime(), now) : noon.getTime()
}
