/**
 * Writes what the Claude Code process prints to its error output (the SDK's `stderr` option) to the task's log, line by
 * line (`docs/logs.md`): each line cut short, and only so many in a while, so a process that floods it can't flood the
 * log. The lines past the limit are counted, and the count is logged when the next line gets through.
 */
import type { Logger } from '../logging/logger'

/** How much of the process's error output the log takes. */
export interface StderrLimits {
  /** How many lines are logged in each window; the rest are counted. */
  readonly maxLines: number
  /** How long a window lasts, in milliseconds. */
  readonly windowMs: number
  /** How many characters of a line are logged; the rest are counted. */
  readonly maxLineLength: number
}

/** 20 lines every 10 seconds, of up to 1,000 characters each. */
export const STDERR_LIMITS: StderrLimits = { maxLines: 20, windowMs: 10_000, maxLineLength: 1000 }

/** What a line is logged as. */
export const STDERR_LINE = 'agent stderr'
/** Logged once when a window's lines run out. */
export const STDERR_LIMITED = 'agent stderr limited'
/** Logged when lines get through again, with how many weren't logged. */
export const STDERR_DROPPED = 'agent stderr lines dropped'

/** A line cut to `max` characters, saying how many more there were. */
function cut(line: string, max: number): string {
  return line.length <= max ? line : `${line.slice(0, max)}… (${String(line.length - max)} more characters)`
}

/**
 * The SDK's `stderr` callback for a session: logs each non-blank line of each chunk the process writes as a warning on
 * `log` (the task's agent log), within `limits`. A line split across two chunks is logged as two.
 */
export function stderrLogger(
  log: Logger,
  limits: StderrLimits = STDERR_LIMITS,
  now: () => number = Date.now,
): (data: string) => void {
  let windowStart = Number.NEGATIVE_INFINITY
  let logged = 0
  let dropped = 0
  return (data) => {
    for (const raw of data.split(/\r?\n/)) {
      const line = raw.trimEnd()
      if (line.trim() === '') continue
      const time = now()
      if (time - windowStart >= limits.windowMs) {
        if (dropped > 0) log.warn(STDERR_DROPPED, { dropped })
        windowStart = time
        logged = 0
        dropped = 0
      }
      if (logged < limits.maxLines) {
        logged += 1
        log.warn(STDERR_LINE, { line: cut(line, limits.maxLineLength) })
        continue
      }
      if (dropped === 0) log.warn(STDERR_LIMITED, { maxLines: limits.maxLines, windowMs: limits.windowMs })
      dropped += 1
    }
  }
}
