/**
 * The control API's rate limits (`docs/control-api.md`, "Safety"): per caller (each task, and the HTTP endpoint as a
 * whole), so many reads and so many changes in any minute, counted apart. A call over the limit is refused, and told
 * how long until one of its minute's calls ages out.
 */
import { ControlAccess } from './names'

/** How many calls of each access a caller may make in a window. */
export type RateLimits = Readonly<Record<ControlAccess, number>>

/** 600 reads and 120 changes a minute. */
export const CONTROL_RATE_LIMITS: RateLimits = { [ControlAccess.Read]: 600, [ControlAccess.Change]: 120 }

/** The window the limits count over. */
export const RATE_WINDOW_MS = 60_000

/** Whether a call may go ahead, and if not, how long until it may. */
export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number }

export interface RateLimiter {
  /** Counts a call by `caller`, if it's within the limit. */
  take(caller: string, access: ControlAccess): RateDecision
}

export interface RateLimiterOptions {
  readonly limits?: RateLimits
  readonly windowMs?: number
  /** The clock: `Date.now` by default. */
  readonly now?: () => number
}

/** A sliding-window limiter: each caller's calls of each access in the last `windowMs`, oldest first. */
export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const limits = options.limits ?? CONTROL_RATE_LIMITS
  const windowMs = options.windowMs ?? RATE_WINDOW_MS
  const now = options.now ?? Date.now
  const calls = new Map<string, number[]>()
  return {
    take(caller, access) {
      const key = `${access}:${caller}`
      const at = now()
      const recent = (calls.get(key) ?? []).filter((time) => time > at - windowMs)
      const oldest = recent[0]
      if (oldest !== undefined && recent.length >= limits[access]) {
        calls.set(key, recent)
        return { ok: false, retryAfterMs: oldest + windowMs - at }
      }
      recent.push(at)
      calls.set(key, recent)
      return { ok: true }
    },
  }
}
