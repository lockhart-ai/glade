import type { EpochMs } from '../../shared/domain'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = 7 * DAY

/**
 * How long ago `at` was, as the task list shows it: `now` under a minute, then whole minutes (`4m`), hours (`2h`), days
 * (`3d`) and weeks (`1w`), each rounded down. A time in the future (a clock that moved back) counts as now.
 */
export function formatRelativeTime(at: EpochMs, now: EpochMs = Date.now()): string {
  const elapsed = now - at
  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m`
  if (elapsed < DAY) return `${String(Math.floor(elapsed / HOUR))}h`
  if (elapsed < WEEK) return `${String(Math.floor(elapsed / DAY))}d`
  return `${String(Math.floor(elapsed / WEEK))}w`
}
