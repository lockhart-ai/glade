/**
 * What Glade tells an agent about usage (#688): every prompt a turn starts with ends with a short line on where
 * usage stands, and a working agent is told, mid-turn, when usage crosses a threshold. Pure, so the wording is
 * tested apart from the runner that sends it and the settings that shape it.
 */
import { UsageLimitKind, type UsageReading } from './account'
import type { EpochMs } from './domain'
import type { Settings } from './settings'

/** The parts of the settings the mid-turn notes read. */
export type UsageNoteSettings = Pick<Settings, 'usageNoteStepPercent' | 'usageNoteStepDollars'>

/** What the usage readings and the OpenRouter key say now, as the line and the notes read them. */
export interface UsageNoteCurrent {
  /** How much of the plan's session window is used, as a fraction; null when nothing says. */
  readonly session: number | null
  /** How much of the plan's weekly window is used, as a fraction; null when nothing says. */
  readonly week: number | null
  /** When the session window resets; null when unknown. */
  readonly sessionResetsAt: EpochMs | null
  /** When the weekly window resets; null when unknown. */
  readonly weekResetsAt: EpochMs | null
  /** The OpenRouter key's spend, all time, in dollars; null when unknown. */
  readonly spend: number | null
}

/** The last usage a task was told of, mid-turn, kept in SQLite so a relaunch doesn't repeat a note. */
export interface UsageAnnounced {
  readonly session: number | null
  readonly week: number | null
  readonly spend: number | null
}

/** What a task that has never been told anything mid-turn has been told: nothing. */
export const NOTHING_ANNOUNCED: UsageAnnounced = { session: null, week: null, spend: null }

/** The result of checking what a working task hasn't been told yet. */
export interface UsageNoteResult {
  /** The note, or null when no threshold has been crossed since its last note. */
  readonly note: string | null
  /** What it has now been told, to keep with the task. */
  readonly announced: UsageAnnounced
}

/**
 * The session's and the week's standing readings at `now` (a window that has reset has none), and the key's spend,
 * as the line and the notes read them.
 */
export function usageNoteCurrent(
  readings: readonly UsageReading[],
  spend: number | null,
  now: EpochMs,
): UsageNoteCurrent {
  const standing = (kind: UsageLimitKind): UsageReading | undefined =>
    readings.find((reading) => reading.limit.kind === kind && (reading.resetsAt === null || reading.resetsAt > now))
  const session = standing(UsageLimitKind.Session)
  const week = standing(UsageLimitKind.Weekly)
  return {
    session: session?.utilization ?? null,
    week: week?.utilization ?? null,
    sessionResetsAt: session?.resetsAt ?? null,
    weekResetsAt: week?.resetsAt ?? null,
    spend,
  }
}

const UTC_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})
const UTC_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })

/** A time's UTC day, as `toISOString` names it: `2026-10-23`. */
const utcDay = (at: EpochMs): string => new Date(at).toISOString().slice(0, 10)

/** When a window resets, as the notes say it: `08:30 UTC` today, `Oct 23 06:00 UTC` on another day. */
export function usageResetsUtc(at: EpochMs, now: EpochMs): string {
  const clock = `${UTC_CLOCK.format(at)} UTC`
  return utcDay(at) === utcDay(now) ? clock : `${UTC_DAY.format(at)} ${clock}`
}

/**
 * OpenRouter spend, as the notes say it: `$12.35`, or, under a cent, with the decimals that show it
 * (`$0.000081`), as the meter's all-time row does.
 */
export function spendMoney(total: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: total >= 0.01 ? 2 : 0,
    maximumFractionDigits: total >= 0.01 ? 2 : 6,
  }).format(total)
}

/**
 * One window's part of the line or a note: `session 41% (resets 08:30 UTC)`. Null when nothing says how much is
 * used.
 */
function windowPart(name: string, utilization: number | null, resetsAt: EpochMs | null, now: EpochMs): string | null {
  if (utilization === null) return null
  const resets = resetsAt === null ? '' : ` (resets ${usageResetsUtc(resetsAt, now)})`
  return `${name} ${String(Math.floor(utilization * 100))}%${resets}`
}

/**
 * The usage line a turn's prompt ends with, or null when nothing says how much is used (no readings yet, or a
 * plan the limits don't apply to). The OpenRouter spend comes when the task runs on OpenRouter.
 */
export function usageLine(current: UsageNoteCurrent, onOpenRouter: boolean, now: EpochMs): string | null {
  const parts = [
    windowPart('session', current.session, current.sessionResetsAt, now),
    windowPart('week', current.week, current.weekResetsAt, now),
    ...(onOpenRouter && current.spend !== null ? [`OpenRouter spend ${spendMoney(current.spend)}`] : []),
  ].filter((part): part is string => part !== null)
  return parts.length === 0 ? null : `Usage: ${parts.join(', ')}.`
}

/**
 * What a working task is told now, mid-turn, the readings saying `current`: each threshold it hasn't been told of
 * since its last note. `announced` is what it was told before; a task never told anything (its row isn't there
 * yet) starts quiet, since its prompts' usage line already said where things stand. A window that has reset (its
 * reading went down) starts over quietly. The steps come from the settings: null sends no note.
 */
export function usageNote(
  current: UsageNoteCurrent,
  announced: UsageAnnounced | undefined,
  settings: UsageNoteSettings,
  now: EpochMs,
): UsageNoteResult {
  const told = announced ?? NOTHING_ANNOUNCED
  const parts: string[] = []
  const resets = (at: EpochMs | null): string => (at === null ? '' : ` (resets ${usageResetsUtc(at, now)})`)
  const stepPercent = settings.usageNoteStepPercent
  if (stepPercent !== null && current.session !== null && told.session !== null) {
    const stepOf = (fraction: number): number => Math.floor((fraction * 100) / stepPercent)
    // A window that has reset reads lower than what it was told, and its thresholds start over without a note.
    if (current.session >= told.session && stepOf(current.session) > stepOf(told.session)) {
      parts.push(`the session is now at ${String(Math.floor(current.session * 100))}%${resets(current.sessionResetsAt)}`)
    }
  }
  if (stepPercent !== null && current.week !== null && told.week !== null) {
    const stepOf = (fraction: number): number => Math.floor((fraction * 100) / stepPercent)
    if (current.week >= told.week && stepOf(current.week) > stepOf(told.week)) {
      parts.push(`the week is now at ${String(Math.floor(current.week * 100))}%${resets(current.weekResetsAt)}`)
    }
  }
  const stepDollars = settings.usageNoteStepDollars
  if (stepDollars !== null && current.spend !== null && told.spend !== null) {
    const stepOf = (dollars: number): number => Math.floor(dollars / stepDollars)
    if (stepOf(current.spend) > stepOf(told.spend)) {
      parts.push(`OpenRouter spend is now ${spendMoney(current.spend)}`)
    }
  }
  return {
    note: parts.length === 0 ? null : `Usage: ${parts.join(', ')}.`,
    announced: {
      session: current.session ?? told.session,
      week: current.week ?? told.week,
      spend: current.spend ?? told.spend,
    },
  }
}
