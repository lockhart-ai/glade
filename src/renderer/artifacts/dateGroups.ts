/**
 * The Artifacts tab's date groups (#307): which group a time falls in, seen from now, in the local time zone. Days are
 * calendar days (so a daylight-saving change doesn't move one), and a week starts on Monday.
 */
import { ArtifactDateGroup, type ArtifactGroupFold, type EpochMs } from '../../shared/domain'

/** Every group, in the order the tab shows them: newest first. */
export const DATE_GROUPS: readonly ArtifactDateGroup[] = [
  ArtifactDateGroup.Today,
  ArtifactDateGroup.Yesterday,
  ArtifactDateGroup.ThisWeek,
  ArtifactDateGroup.LastWeek,
  ArtifactDateGroup.ThisMonth,
  ArtifactDateGroup.Older,
]

/** A group's header, as the design has it (shown in capitals). */
export function dateGroupTitle(group: ArtifactDateGroup): string {
  switch (group) {
    case ArtifactDateGroup.Today:
      return 'Today'
    case ArtifactDateGroup.Yesterday:
      return 'Yesterday'
    case ArtifactDateGroup.ThisWeek:
      return 'This week'
    case ArtifactDateGroup.LastWeek:
      return 'Last week'
    case ArtifactDateGroup.ThisMonth:
      return 'This month'
    case ArtifactDateGroup.Older:
      return 'Older'
  }
}

/** The start of the local day `days` days after `day`'s (before it, when negative). */
function dayStart(day: Date, days: number): EpochMs {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate() + days).getTime()
}

/**
 * The group `at` falls in, seen from `now`: the first of today, yesterday, earlier this week, last week, earlier this
 * month and older that holds it. A time after now (a clock that moved back) is today.
 */
export function dateGroupOf(at: EpochMs, now: EpochMs): ArtifactDateGroup {
  const today = new Date(now)
  // Days since Monday: `getDay()` counts from Sunday.
  const intoWeek = (today.getDay() + 6) % 7
  if (at >= dayStart(today, 0)) return ArtifactDateGroup.Today
  if (at >= dayStart(today, -1)) return ArtifactDateGroup.Yesterday
  if (at >= dayStart(today, -intoWeek)) return ArtifactDateGroup.ThisWeek
  if (at >= dayStart(today, -intoWeek - 7)) return ArtifactDateGroup.LastWeek
  if (at >= new Date(today.getFullYear(), today.getMonth(), 1).getTime()) return ArtifactDateGroup.ThisMonth
  return ArtifactDateGroup.Older
}

/** Whether a group starts open: Today and Yesterday do, the older ones start folded. */
export function opensByDefault(group: ArtifactDateGroup): boolean {
  return group === ArtifactDateGroup.Today || group === ArtifactDateGroup.Yesterday
}

/** Whether a group shows open: as you last left it, or as it starts. */
export function isGroupOpen(group: ArtifactDateGroup, folds: readonly ArtifactGroupFold[]): boolean {
  return folds.find((fold) => fold.group === group)?.open ?? opensByDefault(group)
}

/** Items in their date groups: only the groups that hold any, newest group first, each keeping the items' order. */
export interface DateGrouped<T> {
  readonly group: ArtifactDateGroup
  readonly items: readonly T[]
}

/** Sorts items into their date groups by `at` (the time each is dated by), seen from `now`. */
export function groupByDate<T>(items: readonly T[], at: (item: T) => EpochMs, now: EpochMs): DateGrouped<T>[] {
  const byGroup = new Map<ArtifactDateGroup, T[]>()
  for (const item of items) {
    const group = dateGroupOf(at(item), now)
    const members = byGroup.get(group)
    if (members === undefined) byGroup.set(group, [item])
    else members.push(item)
  }
  return DATE_GROUPS.flatMap((group) => {
    const members = byGroup.get(group)
    return members === undefined ? [] : [{ group, items: members }]
  })
}
