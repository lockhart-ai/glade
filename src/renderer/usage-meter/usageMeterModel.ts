/**
 * What the usage meter at the foot of the sidebar says (`docs/design/html/32-usage-meter.html`): the most-used limit in
 * its row ("Session 38% · resets 15:40"), or extra usage and the money spent on it while the account runs on that
 * ("Extra usage CA$12.34 · spent", #530), and every limit in its popover. Pure, so the wording is tested apart from the
 * row and the popover.
 */
import {
  accountKind,
  AccountKind,
  UsageLevel,
  UsageLimitKind,
  type Account,
  type ExtraUsageSpend,
  type UsageLimit,
  type UsageReading,
} from '../../shared/account'
import type { EpochMs } from '../../shared/domain'
import { resumeTime } from '../pause/pauseModel'

/** What the meter's row shows. */
export enum UsageMeterKind {
  /** Nothing: plan limits don't apply to an API key or a cloud provider. */
  Hidden = 'hidden',
  /** An empty ring, "Usage · within limits": nothing read yet says how much is used. */
  Unknown = 'unknown',
  /** A blue ring: the most-used limit, below the warning threshold. */
  Normal = 'normal',
  /** A purple ring: the most-used limit is close. */
  Warning = 'warning',
  /** The question card's highlight: a limit ran out, "Session limit · Resets at 15:40". */
  Limited = 'limited',
  /**
   * A plan limit ran out and extra usage is taking the requests: "Extra usage CA$12.34 · spent" (#530). Not a failure,
   * so it's in the ring's blue, and purple only close to its monthly cap.
   */
  ExtraUsage = 'extra_usage',
}

/** The meter's row. */
export type UsageMeterState =
  | { readonly kind: UsageMeterKind.Hidden }
  | { readonly kind: UsageMeterKind.Unknown }
  | {
      readonly kind: UsageMeterKind.Normal | UsageMeterKind.Warning | UsageMeterKind.Limited | UsageMeterKind.ExtraUsage
      /** The limit it shows. */
      readonly reading: UsageReading
    }

/** The readings still standing at `now`: a window that has reset has none. */
export function currentReadings(readings: readonly UsageReading[], now: EpochMs): UsageReading[] {
  return readings.filter((reading) => reading.resetsAt === null || reading.resetsAt > now)
}

/** How a level ranks for the row: the closer to the limit, the higher. */
const LEVEL_RANK: Readonly<Record<UsageLevel, number>> = {
  [UsageLevel.Within]: 0,
  [UsageLevel.Warning]: 1,
  [UsageLevel.Limited]: 2,
}

/** Whether a plan limit (any but extra usage) is spent: at its limit, or all of it used. */
function spent(reading: UsageReading): boolean {
  if (reading.limit.kind === UsageLimitKind.ExtraUsage) return false
  return reading.level === UsageLevel.Limited || (reading.utilization ?? 0) >= 1
}

/**
 * Extra usage's reading while the account is running on it (#530): a plan limit is spent, and the last usage call said
 * extra usage can take the requests it turns away (`ExtraUsageStatus.available`), which nothing has since said is at
 * its own limit. Undefined otherwise.
 */
function runningOnExtraUsage(standing: readonly UsageReading[]): UsageReading | undefined {
  if (!standing.some(spent)) return undefined
  return standing.find(
    (reading) =>
      reading.limit.kind === UsageLimitKind.ExtraUsage &&
      reading.level !== UsageLevel.Limited &&
      reading.extraUsage?.available === true,
  )
}

/**
 * The row for `account` and its `readings` at `now`. While the account is running on extra usage it shows that, with
 * the money spent (`runningOnExtraUsage`). Otherwise it shows the limit closest to running out: one that has (the one
 * that resets last, when all of them will have), else the most used, else "within limits" while nothing says how much
 * is used. An account plan limits don't apply to hides it.
 */
export function usageMeterState(
  account: Account | null,
  readings: readonly UsageReading[],
  now: EpochMs,
): UsageMeterState {
  if (account !== null) {
    const kind = accountKind(account)
    if (kind === AccountKind.ApiKey || kind === AccountKind.CloudProvider) return { kind: UsageMeterKind.Hidden }
  }
  const standing = currentReadings(readings, now)
  const extra = runningOnExtraUsage(standing)
  if (extra !== undefined) return { kind: UsageMeterKind.ExtraUsage, reading: extra }
  const limited = standing.filter((reading) => reading.level === UsageLevel.Limited)
  if (limited.length > 0) {
    const last = limited.reduce((a, b) => ((b.resetsAt ?? 0) > (a.resetsAt ?? 0) ? b : a))
    return { kind: UsageMeterKind.Limited, reading: last }
  }
  const told = standing.filter((reading) => reading.utilization !== null || reading.level !== UsageLevel.Within)
  if (told.length === 0) return { kind: UsageMeterKind.Unknown }
  const most = told.reduce((a, b) =>
    LEVEL_RANK[b.level] > LEVEL_RANK[a.level] || (b.level === a.level && (b.utilization ?? 0) > (a.utilization ?? 0))
      ? b
      : a,
  )
  return { kind: most.level === UsageLevel.Warning ? UsageMeterKind.Warning : UsageMeterKind.Normal, reading: most }
}

/** A limit's name in the meter: `Session`, `This week`, `This week · Opus`, `Extra usage`. */
export function usageLimitLabel(limit: UsageLimit): string {
  switch (limit.kind) {
    case UsageLimitKind.Session:
      return 'Session'
    case UsageLimitKind.Weekly:
      return 'This week'
    case UsageLimitKind.WeeklyModel:
      return `This week · ${limit.model}`
    case UsageLimitKind.ExtraUsage:
      return 'Extra usage'
  }
}

/** A limit's name once it has run out: `Session limit`, `Weekly limit`, `Weekly Opus limit`, `Extra usage limit`. */
export function usageLimitReachedLabel(limit: UsageLimit): string {
  switch (limit.kind) {
    case UsageLimitKind.Session:
      return 'Session limit'
    case UsageLimitKind.Weekly:
      return 'Weekly limit'
    case UsageLimitKind.WeeklyModel:
      return `Weekly ${limit.model} limit`
    case UsageLimitKind.ExtraUsage:
      return 'Extra usage limit'
  }
}

/**
 * How much of a limit is used, as the meter says it: a whole percentage, rounded down as Claude Code does (`38%`).
 * Without one, where it stands: `within limits`, `near limit`, `limit reached`.
 */
export function usagePercent(reading: UsageReading): string {
  if (reading.utilization !== null) return `${String(Math.floor(reading.utilization * 100))}%`
  switch (reading.level) {
    case UsageLevel.Within:
      return 'within limits'
    case UsageLevel.Warning:
      return 'near limit'
    case UsageLevel.Limited:
      return 'limit reached'
  }
}

/** How much of the ring or bar a reading fills, from 0 to 1: all of it at the limit, whatever it said. */
export function usageFraction(reading: UsageReading): number {
  if (reading.level === UsageLevel.Limited) return 1
  return Math.min(1, reading.utilization ?? 0)
}

/**
 * The locale money is written in, as the rest of Glade's dates and numbers are: `en-US` names every currency but the
 * US dollar (`CA$12.34`, `¥1,234`), whatever the Mac's own locale, so the amount never reads as another dollar's.
 */
const MONEY_LOCALE = 'en-US'

/** Writes an amount given in a currency's minor units, or null for a currency `Intl` won't format. */
type MoneyFormat = ((minor: number) => string) | null

/** The formats made so far, by currency and decimal places: the meter writes the same one or two again each minute. */
const moneyFormats = new Map<string, MoneyFormat>()

function makeMoneyFormat({ currency, decimalPlaces }: ExtraUsageSpend): MoneyFormat {
  try {
    const format = new Intl.NumberFormat(MONEY_LOCALE, {
      style: 'currency',
      currency,
      minimumFractionDigits: decimalPlaces,
      maximumFractionDigits: decimalPlaces,
    })
    const unit = 10 ** decimalPlaces
    return (minor) => format.format(minor / unit)
  } catch {
    return null
  }
}

function moneyFormat(spend: ExtraUsageSpend): MoneyFormat {
  const key = `${spend.currency}:${String(spend.decimalPlaces)}`
  let format = moneyFormats.get(key)
  if (format === undefined) {
    format = makeMoneyFormat(spend)
    moneyFormats.set(key, format)
  }
  return format
}

/** The money spent on extra usage, as the meter says it. */
export interface UsageSpendWords {
  /** What's been spent: `CA$12.34`. */
  readonly amount: string
  /** What it's set against: `of CA$50.00` with a monthly cap, `spent` with none. */
  readonly rest: string
}

/**
 * The money a reading of extra usage tells of (#530): `CA$12.34` · `spent`, or with a monthly cap `CA$12.34` ·
 * `of CA$50.00`. Null for a reading with no amount (every other limit's, and extra usage's when the usage call didn't
 * say), and for a currency code `Intl` rejects: the meter then says what it did before, a percentage or where it stands.
 */
export function usageSpend(reading: UsageReading): UsageSpendWords | null {
  const spend = reading.extraUsage?.spend
  if (spend == null) return null
  const money = moneyFormat(spend)
  if (money === null) return null
  return { amount: money(spend.spent), rest: spend.cap === null ? 'spent' : `of ${money(spend.cap)}` }
}

/**
 * How much of a limit's bar or ring is drawn, from 0 to 1 (`usageFraction`), or null for none at all: extra usage that
 * shows an amount spent with no monthly cap has nothing to be a fraction of (#530), so its row has no bar and its ring
 * no arc, rather than an empty one that would read as 0%.
 */
export function usageBar(reading: UsageReading): number | null {
  const uncapped = reading.extraUsage?.spend?.cap === null
  const told = reading.utilization !== null || reading.level === UsageLevel.Limited
  return uncapped && !told && usageSpend(reading) !== null ? null : usageFraction(reading)
}

/** When a limit resets, as the row and the popover say it: `resets 15:40`, `resets Oct 1 09:00`; null if unknown. */
export function usageResets(reading: UsageReading, now: EpochMs): string | null {
  return reading.resetsAt === null ? null : `resets ${resumeTime(reading.resetsAt, now)}`
}

/** When a limit that ran out resets, as the row says it: `Resets at 15:40`; null if unknown. */
export function usageResetsAt(reading: UsageReading, now: EpochMs): string | null {
  return reading.resetsAt === null ? null : `Resets at ${resumeTime(reading.resetsAt, now)}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * How long ago the newest reading was taken, as the popover's foot says it: `updated just now`, `updated 2 min ago`,
 * `updated 3 h ago`, `updated 2 d ago`. Null with no readings.
 */
export function usageUpdated(readings: readonly UsageReading[], now: EpochMs): string | null {
  if (readings.length === 0) return null
  const elapsed = now - Math.max(...readings.map((reading) => reading.readAt))
  if (elapsed < MINUTE) return 'updated just now'
  if (elapsed < HOUR) return `updated ${String(Math.floor(elapsed / MINUTE))} min ago`
  if (elapsed < DAY) return `updated ${String(Math.floor(elapsed / HOUR))} h ago`
  return `updated ${String(Math.floor(elapsed / DAY))} d ago`
}
