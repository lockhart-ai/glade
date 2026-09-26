/**
 * The account the tasks run on, and the warning while it's close to a usage limit (`src/shared/account.ts`), kept in
 * SQLite and broadcast to the windows (`account.changed`) as they change.
 *
 * - **The account** is read from Claude Code as each task's session starts (the SDK's `accountInfo()`,
 *   `docs/sdk-notes.md` §1), parsed here at the boundary, and replaces the one before. A read that fails, or doesn't
 *   parse, keeps the one before.
 * - **The warning** follows the SDK's `rate_limit_event`, which arrives as each turn starts and whenever the limit
 *   changes (subscription logins only). It stands while the SDK says `allowed_warning` at `USAGE_WARNING_THRESHOLD` of
 *   the window or more (or doesn't say how much), as Claude Code's own warning does; anything else clears it: `allowed`,
 *   a warning below the threshold, or `rejected`, when the paused tasks' banner takes over. It also clears when its
 *   window resets, by a timer that a relaunch arms again (one that reset while the app was closed is cleared at once).
 */
import { z } from 'zod'
import { EventType } from '../../shared/bridge'
import {
  accountKind,
  USAGE_WARNING_THRESHOLD,
  type Account,
  type AccountStatus,
  type UsageWarning,
} from '../../shared/account'
import type { EpochMs } from '../../shared/domain'
import type { Database } from 'better-sqlite3'
import { RateLimitStatus, type RateLimitEvent } from '../agent/events'
import { createPauseTimers } from '../agent/pauses'
import type { Emit } from '../bridge/events'
import { getAccount, getUsageWarning, saveAccount, setUsageWarning } from '../db/repositories/account'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/** What the runner tells the account about: what each session reports. */
export interface AccountSink {
  /** Claude Code said what account a session runs on (`accountInfo()`), unparsed. */
  accountRead(raw: unknown): void
  /** The SDK said where the account's usage limit stands. */
  rateLimit(event: RateLimitEvent): void
}

export interface AccountTracker extends AccountSink {
  /** The account and its warning, as they are now. */
  status(): AccountStatus
  /** Clears the warning's timer, e.g. when the app quits. */
  close(): void
}

export interface AccountTrackerOptions {
  readonly db: Database
  readonly emit: Emit
  /** Where reads and warnings are logged: never the email or organization. Nothing by default. */
  readonly log?: Logger
  readonly now?: () => EpochMs
}

/** A field of `accountInfo()`: a string, or left out. Anything else is as good as left out. */
const field = z.string().min(1).optional().catch(undefined)

/** The SDK's `AccountInfo`, every field optional. */
const accountInfoSchema = z.looseObject({
  email: field,
  organization: field,
  subscriptionType: field,
  tokenSource: field,
  apiKeySource: field,
  apiProvider: field,
})

/** The account `raw` describes, read at `readAt`; null when it isn't an object. */
export function parseAccountInfo(raw: unknown, readAt: EpochMs): Account | null {
  const parsed = accountInfoSchema.safeParse(raw)
  if (!parsed.success) return null
  const info = parsed.data
  return {
    email: info.email ?? null,
    organization: info.organization ?? null,
    subscriptionType: info.subscriptionType ?? null,
    tokenSource: info.tokenSource ?? null,
    apiKeySource: info.apiKeySource ?? null,
    apiProvider: info.apiProvider ?? null,
    readAt,
  }
}

/** The warning a rate limit event calls for at `now`, or null for none (see the module comment). */
export function usageWarningFor(event: RateLimitEvent, now: EpochMs): UsageWarning | null {
  if (event.status !== RateLimitStatus.AllowedWarning) return null
  if (event.utilization !== null && event.utilization < USAGE_WARNING_THRESHOLD) return null
  if (event.resetsAt !== null && event.resetsAt <= now) return null
  return { utilization: event.utilization, window: event.window, resetsAt: event.resetsAt }
}

/** The timer's key: there's one warning, app-wide. */
const WARNING_TIMER = 'usage-warning'

export function createAccountTracker({
  db,
  emit,
  log = SILENT_LOGGER,
  now = () => Date.now(),
}: AccountTrackerOptions): AccountTracker {
  const status = (): AccountStatus => ({ account: getAccount(db), usageWarning: getUsageWarning(db) })
  const changed = (): void => {
    emit({ type: EventType.AccountChanged, status: status() })
  }

  const setWarning = (warning: UsageWarning | null): void => {
    timers.disarm(WARNING_TIMER)
    if (warning?.resetsAt != null) timers.arm(WARNING_TIMER, warning.resetsAt)
    setUsageWarning(db, warning)
  }

  // The warning's window reset: it's over, unless a newer warning has taken its place.
  const timers = createPauseTimers(() => {
    const warning = getUsageWarning(db)
    if (warning?.resetsAt == null || warning.resetsAt > now()) return
    log.info('usage warning over: its window reset')
    setUsageWarning(db, null)
    changed()
  }, now)

  // A warning left from before a relaunch: over if its window reset meanwhile, or timed again.
  const left = getUsageWarning(db)
  if (left?.resetsAt != null) {
    if (left.resetsAt <= now()) setUsageWarning(db, null)
    else timers.arm(WARNING_TIMER, left.resetsAt)
  }

  return {
    status,
    accountRead(raw) {
      const account = parseAccountInfo(raw, now())
      if (account === null) {
        log.warn('account info not understood: keeping the last one read')
        return
      }
      log.info('account read', {
        kind: accountKind(account),
        plan: account.subscriptionType,
        tokenSource: account.tokenSource,
        apiKeySource: account.apiKeySource,
        apiProvider: account.apiProvider,
      })
      saveAccount(db, account)
      changed()
    },
    rateLimit(event) {
      const warning = usageWarningFor(event, now())
      if (JSON.stringify(warning) === JSON.stringify(getUsageWarning(db))) return
      log.info(warning === null ? 'usage warning cleared' : 'usage warning', {
        status: event.status,
        utilization: event.utilization,
        window: event.window,
        resetsAt: event.resetsAt,
      })
      setWarning(warning)
      changed()
    },
    close() {
      timers.close()
    },
  }
}
