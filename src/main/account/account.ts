/**
 * The account the tasks run on, and how much of each of its usage limits is used (`src/shared/account.ts`), kept in
 * SQLite and broadcast to the windows (`account.changed`) as they change.
 *
 * - **The account** is read from Claude Code as each task's session starts (the SDK's `accountInfo()`,
 *   `docs/sdk-notes.md` §1), parsed here at the boundary, and replaces the one before. A read that fails, or doesn't
 *   parse, keeps the one before.
 * - **The usage readings**, one per limit, come from two places (`docs/sdk-notes.md`, "Usage limits"):
 *   - Claude Code's usage call (the SDK's experimental `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`),
 *     asked as each session starts and after each turn, and, while a task is paused on a usage limit, when Glade's
 *     window gets the focus and every few minutes (`./usage-resume`). It gives every window with how much is used and
 *     when it resets, so an answer replaces every reading before it. It's parsed loosely: a window it sends malformed
 *     is left out, and an answer that makes no sense, or has no window at all, keeps the readings there are. So does
 *     one saying plan limits don't apply (an API key or a cloud provider), and so does a call that fails. Each answer
 *     that gave readings is handed on (`onUsageRead`), to resume the paused tasks it says can run again.
 *   - The SDK's `rate_limit_event`, which arrives as each turn starts and whenever a limit changes (subscription logins
 *     only). Each names one window; it replaces that window's reading, keeping how much was used when the event
 *     doesn't say. `rejected` is at the limit; a warning is close to it only from `USAGE_WARNING_THRESHOLD`, as Claude
 *     Code's own warning is (or when it doesn't say how much).
 *
 *   The usage call also says what's been spent on extra usage, in money (`ExtraUsageSpend`, #530): kept with extra
 *   usage's reading for the meter to show, and never logged.
 *
 *   A reading goes when its window resets, by a timer that a relaunch arms again (one that reset while the app was
 *   closed goes at once).
 */
import { z } from 'zod'
import { EventType } from '../../shared/bridge'
import {
  accountKind,
  sortUsageReadings,
  usageLevel,
  UsageLevel,
  usageLimitKey,
  UsageLimitKind,
  UsageWindow,
  type Account,
  type AccountStatus,
  type ExtraUsageSpend,
  type UsageLimit,
  type UsageReading,
  type UsageSnapshot,
} from '../../shared/account'
import type { EpochMs } from '../../shared/domain'
import type { Database } from 'better-sqlite3'
import { RateLimitStatus, type RateLimitEvent } from '../agent/events'
import { createPauseTimers } from '../agent/pauses'
import type { Emit } from '../bridge/events'
import {
  deleteResetUsageReadings,
  getAccount,
  listUsageReadings,
  replaceUsageReadings,
  saveAccount,
  saveUsageReading,
} from '../db/repositories/account'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/** What the runner tells the account about: what each session reports. */
export interface AccountSink {
  /** Claude Code said what account a session runs on (`accountInfo()`), unparsed. */
  accountRead(raw: unknown): void
  /** The SDK said where one of the account's usage limits stands. */
  rateLimit(event: RateLimitEvent): void
  /** Claude Code answered the usage call (`AgentSession.usage()`), unparsed. */
  usageRead(raw: unknown): void
}

export interface AccountTracker extends AccountSink {
  /** The account and its usage, as they are now. */
  status(): AccountStatus
  /** Clears the resets' timer, e.g. when the app quits. */
  close(): void
}

export interface AccountTrackerOptions {
  readonly db: Database
  readonly emit: Emit
  /** Where reads and readings are logged: never the email or organization. Nothing by default. */
  readonly log?: Logger
  readonly now?: () => EpochMs
  /**
   * Hears each answer of the usage call that gave readings, once they're saved and broadcast: what resumes the tasks a
   * usage limit paused when the account can run again (`./usage-resume`, #519). Nothing by default.
   */
  readonly onUsageRead?: (usage: UsageSnapshot) => void
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

/** How much of a window the usage call says is used, from 0 to 100. A malformed one is as good as left out. */
const percent = z.number().nonnegative().nullish().catch(null)
/** When the usage call says a window resets, as an ISO 8601 time. A malformed one is as good as left out. */
const isoTime = z.string().nullish().catch(null)
/** One of the usage call's windows. A malformed one is left out. */
const callWindow = z.looseObject({ utilization: percent, resets_at: isoTime }).nullish().catch(null)
/** One of the usage call's per-model weekly windows, which the server names. A malformed one is left out. */
const modelWindow = z
  .looseObject({ display_name: z.string().min(1), utilization: percent, resets_at: isoTime })
  .nullable()
  .catch(null)

/**
 * An amount of extra usage's credits, in the currency's minor units (cents); null when the call says there's none (no
 * monthly cap, say). One it leaves out or sends malformed is undefined: not known.
 */
const credits = z.number().nonnegative().nullable().optional().catch(undefined)

/**
 * The usage call's `extra_usage` (`docs/sdk-notes.md`, "Usage limits"), the parts Glade reads. What it leaves out or
 * sends malformed is undefined, which is never taken for "available" (`extraUsageAvailable`).
 */
const extraUsageSchema = z.looseObject({
  is_enabled: z.boolean().catch(false),
  utilization: percent,
  monthly_limit: credits,
  used_credits: credits,
  /** Why extra usage can't be used though it's on (out of credits, turned off for the seat, …); null when it can. */
  disabled_reason: z.string().nullable().optional().catch(undefined),
  spend_limit_reached: z.boolean().optional().catch(undefined),
  /** The ISO 4217 code of the currency the credits are in (`CAD`): three letters. */
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .optional()
    .catch(undefined),
  /** How many decimal places the currency has, which says what a minor unit is: from 0 (yen) to 4, as ISO 4217's are. */
  decimal_places: z.number().int().min(0).max(4).optional().catch(undefined),
})

type ExtraUsage = z.infer<typeof extraUsageSchema>

/**
 * What's been spent on extra usage and its cap (#530), or null unless the call says all of it: the amount spent, the
 * cap (or outright that there's none), the currency and its decimal places. Anything left out or malformed means no
 * amount, never a guessed one: the cents of one currency read as another's would be a wrong sum of money.
 */
function extraUsageSpend(extra: ExtraUsage): ExtraUsageSpend | null {
  const { used_credits: spent, monthly_limit: cap, currency, decimal_places: decimalPlaces } = extra
  if (spent == null || cap === undefined || currency === undefined || decimalPlaces === undefined) return null
  return { spent, cap, currency: currency.toUpperCase(), decimalPlaces }
}

/** The SDK's `SDKControlGetUsageResponse`, the parts the meter reads, as loosely as makes sense. */
const usageResponse = z.looseObject({
  rate_limits_available: z.boolean(),
  rate_limits: z
    .looseObject({
      five_hour: callWindow,
      seven_day: callWindow,
      seven_day_opus: callWindow,
      seven_day_sonnet: callWindow,
      model_scoped: z.array(modelWindow).optional().catch(undefined),
      extra_usage: extraUsageSchema.nullish().catch(null),
    })
    .nullable(),
})

/** What the usage call's answer says. */
export enum UsageAnswerKind {
  /** Every window it knows of, read. */
  Readings = 'readings',
  /** Plan limits don't apply: an API key, a cloud provider, or a login without the scope to read them. */
  NoPlanLimits = 'no_plan_limits',
  /** Nothing that makes sense: not the shape it should be, or not one window in it. */
  NotUnderstood = 'not_understood',
}

export type UsageAnswer =
  | ({ readonly kind: UsageAnswerKind.Readings } & UsageSnapshot)
  | { readonly kind: UsageAnswerKind.NoPlanLimits | UsageAnswerKind.NotUnderstood }

/**
 * How much of extra usage's monthly cap is spent, as a fraction: what the call says, or, when it gives no percentage
 * (it gives none while nothing has been spent, #519), what's been spent of the cap. Null with no cap to be a fraction
 * of (`monthly_limit` null or 0), and when the call says neither.
 */
function extraUsageUtilization(extra: ExtraUsage): number | null {
  if (extra.utilization != null) return extra.utilization / 100
  const { monthly_limit: cap, used_credits: used } = extra
  if (cap == null || cap === 0 || used == null) return null
  return used / cap
}

/**
 * The reading of extra usage while it's on, or null while it isn't: with no cap, a reading that gives no percentage. It
 * carries whether extra usage is available and what's been spent (`ExtraUsageStatus`).
 */
function extraUsageReading(extra: ExtraUsage | null | undefined, readAt: EpochMs): UsageReading | null {
  if (extra?.is_enabled !== true) return null
  const utilization = extraUsageUtilization(extra)
  return {
    limit: { kind: UsageLimitKind.ExtraUsage },
    utilization,
    resetsAt: null,
    level: usageLevel(utilization),
    readAt,
    extraUsage: { available: extraUsageAvailable(extra), spend: extraUsageSpend(extra) },
  }
}

/**
 * Whether extra usage can take the requests a plan limit turns away (`UsageSnapshot.extraUsageAvailable`): it's on, the
 * call says outright that nothing disables it and its spend limit isn't reached, and it's under its monthly cap. With
 * no percentage to go by, only a cap the call says there's none of (`monthly_limit: null`) counts as room. Anything
 * left out or malformed is not known, and never available.
 */
function extraUsageAvailable(extra: ExtraUsage | null | undefined): boolean {
  if (extra?.is_enabled !== true) return false
  if (extra.spend_limit_reached !== false || extra.disabled_reason !== null) return false
  const utilization = extraUsageUtilization(extra)
  return utilization === null ? extra.monthly_limit === null : utilization < 1
}

/** A reading of `limit` from one of the call's windows, or null for none: it says nothing of how much is used. */
function callReading(
  limit: UsageLimit,
  window: { readonly utilization?: number | null; readonly resets_at?: string | null } | null | undefined,
  readAt: EpochMs,
): UsageReading | null {
  if (window?.utilization == null) return null
  const utilization = window.utilization / 100
  const resetsAt = window.resets_at == null ? NaN : Date.parse(window.resets_at)
  return {
    limit,
    utilization,
    resetsAt: Number.isNaN(resetsAt) ? null : resetsAt,
    level: usageLevel(utilization),
    readAt,
  }
}

/**
 * What the usage call's answer `raw`, read at `readAt`, says (see the module comment). Its percentages become
 * fractions and its reset times epoch milliseconds; a window that has already reset is left out, and so is a second
 * reading of a limit already read (the per-model windows can name a model the fixed ones do). Extra usage is read
 * whenever it's on, whether or not the call gives its percentage (`extraUsageUtilization`).
 */
export function parseUsage(raw: unknown, readAt: EpochMs): UsageAnswer {
  const parsed = usageResponse.safeParse(raw)
  if (!parsed.success) return { kind: UsageAnswerKind.NotUnderstood }
  const { rate_limits_available: available, rate_limits: limits } = parsed.data
  if (!available || limits === null) return { kind: UsageAnswerKind.NoPlanLimits }
  const read = [
    callReading({ kind: UsageLimitKind.Session }, limits.five_hour, readAt),
    callReading({ kind: UsageLimitKind.Weekly }, limits.seven_day, readAt),
    callReading({ kind: UsageLimitKind.WeeklyModel, model: 'Opus' }, limits.seven_day_opus, readAt),
    callReading({ kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' }, limits.seven_day_sonnet, readAt),
    ...(limits.model_scoped ?? []).map((window) =>
      window === null
        ? null
        : callReading({ kind: UsageLimitKind.WeeklyModel, model: window.display_name }, window, readAt),
    ),
    extraUsageReading(limits.extra_usage, readAt),
  ]
  const byKey = new Map<string, UsageReading>()
  for (const reading of read) {
    if (reading === null || (reading.resetsAt !== null && reading.resetsAt <= readAt)) continue
    const key = usageLimitKey(reading.limit)
    if (!byKey.has(key)) byKey.set(key, reading)
  }
  if (byKey.size === 0) return { kind: UsageAnswerKind.NotUnderstood }
  return {
    kind: UsageAnswerKind.Readings,
    readings: sortUsageReadings([...byKey.values()]),
    extraUsageAvailable: extraUsageAvailable(limits.extra_usage),
  }
}

/** The limit a rate limit event's window is, or null for one Glade doesn't know. */
export function limitOfWindow(window: UsageWindow): UsageLimit | null {
  switch (window) {
    case UsageWindow.Session:
      return { kind: UsageLimitKind.Session }
    case UsageWindow.Weekly:
      return { kind: UsageLimitKind.Weekly }
    case UsageWindow.WeeklyOpus:
      return { kind: UsageLimitKind.WeeklyModel, model: 'Opus' }
    case UsageWindow.WeeklySonnet:
      return { kind: UsageLimitKind.WeeklyModel, model: 'Sonnet' }
    case UsageWindow.Overage:
      return { kind: UsageLimitKind.ExtraUsage }
    case UsageWindow.Other:
      return null
  }
}

/** The level an event puts its limit at: requests the SDK still lets through are never at the limit. */
function eventLevel(status: RateLimitStatus, utilization: number | null): UsageLevel {
  switch (status) {
    case RateLimitStatus.Rejected:
      return UsageLevel.Limited
    case RateLimitStatus.AllowedWarning:
      if (utilization === null) return UsageLevel.Warning
      break
    case RateLimitStatus.Allowed:
      break
  }
  return usageLevel(utilization) === UsageLevel.Within ? UsageLevel.Within : UsageLevel.Warning
}

/**
 * The reading a rate limit event makes of its limit at `now`, given the limit's last reading: how much is used is kept
 * from that when the event doesn't say, and so is what the last usage call said of extra usage (`ExtraUsageStatus`:
 * an event tells of no money, so with no call before it the reading has no amount). Null when the event's window is
 * one Glade doesn't know, or has already reset.
 */
export function eventReading(
  event: RateLimitEvent,
  previous: UsageReading | undefined,
  now: EpochMs,
): UsageReading | null {
  const limit = limitOfWindow(event.window)
  if (limit === null || (event.resetsAt !== null && event.resetsAt <= now)) return null
  const utilization = event.utilization ?? previous?.utilization ?? null
  return {
    limit,
    utilization,
    resetsAt: event.resetsAt ?? previous?.resetsAt ?? null,
    level: eventLevel(event.status, utilization),
    readAt: now,
    ...(previous?.extraUsage === undefined ? {} : { extraUsage: previous.extraUsage }),
  }
}

/** The timer's key: there's one, for the soonest reset. */
const RESET_TIMER = 'usage-reset'

export function createAccountTracker({
  db,
  emit,
  log = SILENT_LOGGER,
  now = () => Date.now(),
  onUsageRead,
}: AccountTrackerOptions): AccountTracker {
  const status = (): AccountStatus => ({ account: getAccount(db), usage: listUsageReadings(db) })
  const changed = (): void => {
    emit({ type: EventType.AccountChanged, status: status() })
  }

  /** Times the soonest reset among the readings, if any has one. */
  const timeResets = (): void => {
    timers.disarm(RESET_TIMER)
    const resets = listUsageReadings(db).flatMap(({ resetsAt }) => (resetsAt === null ? [] : [resetsAt]))
    if (resets.length > 0) timers.arm(RESET_TIMER, Math.min(...resets))
  }

  // A window reset: its reading goes, and the next reset is timed.
  const timers = createPauseTimers(() => {
    const dropped = deleteResetUsageReadings(db, now())
    if (dropped > 0) {
      log.info('usage readings over: their windows reset', { count: dropped })
      changed()
    }
    timeResets()
  }, now)

  // Readings left from before a relaunch: gone if their window reset meanwhile, the rest timed again.
  deleteResetUsageReadings(db, now())
  timeResets()

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
      const limit = limitOfWindow(event.window)
      const previous =
        limit === null
          ? undefined
          : listUsageReadings(db).find((reading) => usageLimitKey(reading.limit) === usageLimitKey(limit))
      const reading = eventReading(event, previous, now())
      const fields = {
        status: event.status,
        utilization: event.utilization,
        window: event.window,
        resetsAt: event.resetsAt,
      }
      if (reading === null) {
        log.info('rate limit not read: an unknown window, or one already reset', fields)
        return
      }
      log.info('usage read from a rate limit event', { ...fields, level: reading.level })
      saveUsageReading(db, reading)
      timeResets()
      changed()
    },
    usageRead(raw) {
      const answer = parseUsage(raw, now())
      switch (answer.kind) {
        case UsageAnswerKind.NotUnderstood:
          log.warn('usage call not understood: keeping the readings there are')
          return
        case UsageAnswerKind.NoPlanLimits:
          log.info('usage call: no plan limits apply')
          return
        case UsageAnswerKind.Readings:
          // Each limit, how much is used and its level: never the money spent on extra usage (#530).
          log.info('usage read from the usage call', {
            readings: answer.readings.map(({ limit, utilization, level }) => ({
              limit: usageLimitKey(limit),
              utilization,
              level,
            })),
          })
          replaceUsageReadings(db, answer.readings)
          timeResets()
          changed()
          onUsageRead?.({ readings: answer.readings, extraUsageAvailable: answer.extraUsageAvailable })
          return
      }
    },
    close() {
      timers.close()
    },
  }
}
