/**
 * Pausing a task's turn on a usage limit or while the API can't be reached, and the timers that resume it on their own
 * (`docs/design/html/17-usage-limit.html`). The runner (`./runner`) pauses and resumes; this module says when.
 *
 * - **Usage limit.** The turn resumes when the limit resets. The time comes from the SDK's `rate_limit_event`, whose
 *   `resetsAt` (epoch seconds) says when the rejecting limit resets. Without one (an API key login gets no such event,
 *   and the error's own text words the time for people, e.g. "resets 3pm"), Glade tries again after
 *   `USAGE_LIMIT_FALLBACK_MS`; a turn still over the limit then just pauses again, with whatever time it's given.
 * - **Offline.** Claude Code has already retried the request for a while before giving up (`docs/sdk-notes.md`,
 *   "Errors and retries"), so Glade checks whether the network is back (Electron's `net.isOnline()` in the app) after
 *   `OFFLINE_FIRST_CHECK_MS`, then twice as long each time it's still down, up to `OFFLINE_MAX_CHECK_MS`, and resumes
 *   the turn once it is.
 *
 * The time a pause resumes at is saved on the task (`TaskPause.resumesAt`), so a relaunch arms its timer again, and a
 * time that passed while the app was closed resumes the turn at once.
 */
import { AgentErrorKind, PauseReason, type EpochMs, type TaskError, type TaskPause } from '../../shared/domain'

/** How long Glade waits to try a turn over the usage limit again when the SDK didn't say when the limit resets. */
export const USAGE_LIMIT_FALLBACK_MS = 15 * 60_000

/** How long after going offline Glade first checks whether the network is back. */
export const OFFLINE_FIRST_CHECK_MS = 5_000

/** The longest Glade waits between checks for the network. */
export const OFFLINE_MAX_CHECK_MS = 60_000

/** The longest a timer can wait in one go (setTimeout's limit, about 24.8 days); a longer wait is re-armed. */
export const MAX_TIMER_MS = 2 ** 31 - 1

/** Why an error pauses the turn rather than stopping the task on it; null for an error that stops it. */
export function pauseReason(error: Pick<TaskError, 'kind'>): PauseReason | null {
  switch (error.kind) {
    case AgentErrorKind.UsageLimit:
      return PauseReason.UsageLimit
    case AgentErrorKind.Offline:
      return PauseReason.Offline
    case AgentErrorKind.Transient:
    case AgentErrorKind.Permanent:
      return null
  }
}

/** How long to wait before the next check for the network, after `checks` found it still down. */
export function offlineCheckDelay(checks: number): number {
  return Math.min(OFFLINE_MAX_CHECK_MS, OFFLINE_FIRST_CHECK_MS * 2 ** checks)
}

/** What the SDK last said about the account's usage limit. */
export interface UsageLimit {
  /** Whether the limit is rejecting requests. */
  readonly rejected: boolean
  /** When it resets; null when the SDK didn't say. */
  readonly resetsAt: EpochMs | null
}

/** The pause for a turn stopped by `details`, at `now`: see the module comment for when it resumes. */
export function pauseFor(reason: PauseReason, details: string, limit: UsageLimit | null, now: EpochMs): TaskPause {
  switch (reason) {
    case PauseReason.UsageLimit: {
      const resetsAt = limit?.rejected === true ? limit.resetsAt : null
      const resumesAt = resetsAt !== null && resetsAt > now ? resetsAt : now + USAGE_LIMIT_FALLBACK_MS
      return { reason, since: now, resumesAt, checks: 0, details }
    }
    case PauseReason.Offline:
      return { reason, since: now, resumesAt: now + offlineCheckDelay(0), checks: 0, details }
  }
}

/** The pause after another check found the network still down: the next check waits longer. */
export function checkedOffline(pause: TaskPause, now: EpochMs): TaskPause {
  const checks = pause.checks + 1
  return { ...pause, checks, resumesAt: now + offlineCheckDelay(checks) }
}

/** One timer per paused task, calling `onDue` with the task's id when its pause is due. */
export interface PauseTimers {
  /** Arms (or re-arms) the task's timer for `at`; a time already past is due at once. */
  arm(taskId: string, at: EpochMs): void
  /** Clears the task's timer, if it has one. */
  disarm(taskId: string): void
  /** Clears every timer. */
  close(): void
}

export function createPauseTimers(onDue: (taskId: string) => void, now: () => EpochMs = Date.now): PauseTimers {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const disarm = (taskId: string): void => {
    clearTimeout(timers.get(taskId))
    timers.delete(taskId)
  }
  const arm = (taskId: string, at: EpochMs): void => {
    disarm(taskId)
    const wait = Math.max(0, at - now())
    const timer = setTimeout(
      () => {
        timers.delete(taskId)
        // Too far off for one timer: wait the rest.
        if (wait > MAX_TIMER_MS) arm(taskId, at)
        else onDue(taskId)
      },
      Math.min(wait, MAX_TIMER_MS),
    )
    timers.set(taskId, timer)
  }
  return {
    arm,
    disarm,
    close() {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    },
  }
}
