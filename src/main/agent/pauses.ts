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
 *
 * A usage limit's pause can end before its reset (#519): the banner's Resume now tries every such turn again at once,
 * and a reading of the account's usage that says it can run again (`canRunAgain`) does the same by itself
 * (`../account/usage-resume`, which reads usage again while anything is paused on a limit). Either way a turn still
 * over the limit just pauses again.
 */
import {
  UsageLevel,
  usageLimitKey,
  UsageLimitKind,
  type UsageLimit as AccountLimit,
  type UsageReading,
  type UsageSnapshot,
} from '../../shared/account'
import { AgentErrorKind, PauseReason, type EpochMs, type TaskError, type TaskPause } from '../../shared/domain'

/** How long Glade waits to try a turn over the usage limit again when the SDK didn't say when the limit resets. */
export const USAGE_LIMIT_FALLBACK_MS = 15 * 60_000

/**
 * How often Glade reads the account's usage again while a task is paused on a usage limit (#519): often enough that
 * extra usage turned on elsewhere resumes the tasks within minutes, though Glade's window never got the focus (which
 * reads at once); seldom enough that the one request each read costs Claude Code is nothing beside a turn's. Shorter
 * than `USAGE_LIMIT_FALLBACK_MS`, the blind retry it mostly stands in for.
 */
export const USAGE_RECHECK_MS = 5 * 60_000

/** The least time between two such reads, so a window flickering in and out of focus asks once. */
export const USAGE_RECHECK_MIN_GAP_MS = 10_000

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
    case AgentErrorKind.SafetyRefusal:
    case AgentErrorKind.LoggedOut:
      // A safety refusal stops the task on its own card (Retry tries again), and so does a lost login (Log in, then
      // Retry): nothing to wait out.
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
  /** Which of the account's limits it is; null for a window Glade doesn't know. */
  readonly limit: AccountLimit | null
}

/** The pause for a turn stopped by `details`, at `now`: see the module comment for when it resumes. */
export function pauseFor(reason: PauseReason, details: string, limit: UsageLimit | null, now: EpochMs): TaskPause {
  switch (reason) {
    case PauseReason.UsageLimit: {
      const rejecting = limit?.rejected === true ? limit : null
      const resetsAt = rejecting?.resetsAt ?? null
      const resumesAt = resetsAt !== null && resetsAt > now ? resetsAt : now + USAGE_LIMIT_FALLBACK_MS
      const which = rejecting?.limit ?? null
      return { reason, since: now, resumesAt, checks: 0, details, ...(which === null ? {} : { limit: which }) }
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

/** Why a reading of the account's usage says a turn paused on a usage limit can run again (`canRunAgain`). */
export enum RunAgainReason {
  /** The limit that turned the turn away is no longer at its limit. */
  LimitCleared = 'limit_cleared',
  /** Extra usage is on, with room left: it takes the requests a plan limit turns away. */
  ExtraUsage = 'extra_usage',
}

/** A reading's word that a paused turn can run again. */
export interface RunAgain {
  readonly reason: RunAgainReason
  /**
   * What the reading said that this rests on: the limits it goes by, how much of each is used and when each resets.
   * Glade resumes a paused turn once on it, and again only once a reading says something else, so a reading that's
   * wrong can't have the turn retried over and over.
   */
  readonly evidence: string
}

/** What a reading says of its limit, as `RunAgain.evidence` words it. */
function said({ limit, utilization, resetsAt }: UsageReading): string {
  return `${usageLimitKey(limit)} ${String(utilization)} ${String(resetsAt)}`
}

/**
 * Whether a reading of the account's usage (one answer of Claude Code's usage call) says the turn `pause` holds can run
 * again, before the limit's own reset. It does when:
 * - the limit that turned the turn away is no longer at its limit: the plan's limit the pause names has a reading below
 *   it (a bigger plan, or a limit lifted early). A pause that names no limit, or one the reading doesn't tell of, never
 *   passes this way: Glade doesn't guess which limit it was;
 * - or extra usage is on with room left (`UsageSnapshot.extraUsageAvailable`), whichever limit it was.
 *
 * Null when neither holds, and for a pause that isn't a usage limit's: offline, the network decides.
 */
export function canRunAgain(pause: TaskPause, usage: UsageSnapshot): RunAgain | null {
  if (pause.reason !== PauseReason.UsageLimit) return null
  const reading = (limit: AccountLimit): UsageReading | undefined =>
    usage.readings.find((candidate) => usageLimitKey(candidate.limit) === usageLimitKey(limit))
  // Extra usage that turned a turn away is back only when the reading says it's available, below.
  const plan = pause.limit === undefined || pause.limit.kind === UsageLimitKind.ExtraUsage ? undefined : pause.limit
  const rejected = plan === undefined ? undefined : reading(plan)
  const cleared = rejected !== undefined && rejected.level !== UsageLevel.Limited ? rejected : undefined
  const evidence: string[] = []
  if (cleared !== undefined) evidence.push(said(cleared))
  if (usage.extraUsageAvailable) {
    const extra = reading({ kind: UsageLimitKind.ExtraUsage })
    evidence.push(extra === undefined ? UsageLimitKind.ExtraUsage : said(extra))
  }
  if (evidence.length === 0) return null
  return {
    reason: cleared === undefined ? RunAgainReason.ExtraUsage : RunAgainReason.LimitCleared,
    evidence: evidence.join(', '),
  }
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
