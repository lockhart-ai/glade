/**
 * How the app words the account's usage warning, the quiet note in the banner's spot while a usage limit is close
 * (`docs/design/html/17-usage-limit.html`): "You've used 85% of your session limit · resets 11:42". The limits are
 * named as Claude Code names them.
 */
import { UsageWindow, type UsageWarning } from '../../shared/account'
import type { EpochMs } from '../../shared/domain'
import { resumeTime } from './pauseModel'

/** A limit's name, by its window. */
export function usageLimitName(window: UsageWindow): string {
  switch (window) {
    case UsageWindow.Session:
      return 'session limit'
    case UsageWindow.Weekly:
      return 'weekly limit'
    case UsageWindow.WeeklyOpus:
      return 'weekly Opus limit'
    case UsageWindow.WeeklySonnet:
      return 'weekly Sonnet limit'
    case UsageWindow.Other:
      return 'usage limit'
  }
}

/** The note's words: the lead, stronger, then when the window resets, if the SDK said. */
export interface UsageNoteText {
  readonly lead: string
  /** ` · resets 11:42`, or null when the SDK didn't say when. */
  readonly resets: string | null
}

/** The note for a warning at `now`. How much is used is rounded down, as Claude Code does. */
export function usageNoteText(warning: UsageWarning, now: EpochMs): UsageNoteText {
  const limit = usageLimitName(warning.window)
  const lead =
    warning.utilization === null
      ? `You’re close to your ${limit}`
      : `You’ve used ${String(Math.floor(warning.utilization * 100))}% of your ${limit}`
  return { lead, resets: warning.resetsAt === null ? null : ` · resets ${resumeTime(warning.resetsAt, now)}` }
}
