/**
 * What the menu bar popover shows (`docs/design/html/29-menu-bar.html`), worked out from what's in flight
 * (`MenuBarSnapshot`, from main) and the time: its sections in order, each left out while it has no rows.
 */
import type { EpochMs, TodoSummary } from '../../shared/domain'
import {
  NEEDS_YOU_REASON_LABELS,
  NeedsYouReason,
  type MenuBarSnapshot,
  type NeedsYouItem,
  type SentNotification,
  type WorkingItem,
} from '../../shared/menuBar'
import { TaskIndicator } from '../../shared/taskIndicator'
import { formatAgo } from '../task-header/headerModel'
import { pausedStatusLine } from '../pause/pauseModel'
import { formatElapsed } from '../subagents/subagentsModel'

/** What a working task with no status yet says. */
export const WORKING_STATUS = 'Working'

/** What the popover says when nothing's in flight. */
export const NOTHING_IN_FLIGHT = 'Nothing in flight'

/** The popover's sections, in the order it lists them. */
export enum MenuBarSectionKind {
  NeedsYou = 'needs_you',
  Working = 'working',
  Recent = 'recent',
}

/** Each section's heading. */
export const SECTION_TITLES: Readonly<Record<MenuBarSectionKind, string>> = {
  [MenuBarSectionKind.NeedsYou]: 'Needs you',
  [MenuBarSectionKind.Working]: 'Working',
  [MenuBarSectionKind.Recent]: 'Recent',
}

/** A task that needs you: its dot, title, workspace and why. */
export interface NeedsYouRow {
  readonly taskId: string
  readonly title: string
  readonly workspaceName: string
  readonly reason: string
  /** Its dot: pink for an error, purple for anything else waiting on you. */
  readonly indicator: TaskIndicator
}

/** A task whose agent is working: its title, status line, todo progress and how long its turn has run. */
export interface WorkingRow {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly todos: TodoSummary | null
  /** How much of its todo list is done, from 0 to 1, for the bar under it; null with no list. */
  readonly progress: number | null
  /** How long its turn has run ("12m 40s"); null when when it started isn't known. */
  readonly elapsed: string | null
}

/** A notification Glade sent: what it said, and how long ago. */
export interface RecentRow {
  readonly key: number
  readonly taskId: string
  readonly title: string
  readonly body: string
  readonly age: string
}

export type MenuBarSection =
  | { readonly kind: MenuBarSectionKind.NeedsYou; readonly rows: readonly NeedsYouRow[] }
  | { readonly kind: MenuBarSectionKind.Working; readonly rows: readonly WorkingRow[] }
  | { readonly kind: MenuBarSectionKind.Recent; readonly rows: readonly RecentRow[] }

function needsYouRow({ taskId, title, workspaceName, reason }: NeedsYouItem): NeedsYouRow {
  const indicator = reason === NeedsYouReason.Error ? TaskIndicator.Error : TaskIndicator.Waiting
  return { taskId, title, workspaceName, reason: NEEDS_YOU_REASON_LABELS[reason], indicator }
}

/** A working task's line: why it's paused while it is, else its status, else just that it's working. */
function statusLine({ status, pause }: WorkingItem, now: EpochMs): string {
  if (pause !== null) return pausedStatusLine(pause, now)
  return status === '' ? WORKING_STATUS : status
}

function workingRow(item: WorkingItem, now: EpochMs): WorkingRow {
  const { taskId, title, todos, startedAt } = item
  return {
    taskId,
    title,
    status: statusLine(item, now),
    todos,
    progress: todos === null ? null : todos.done / todos.total,
    elapsed: startedAt === null ? null : formatElapsed(Math.max(0, now - startedAt)),
  }
}

function recentRow({ seq, taskId, title, body, sentAt }: SentNotification, now: EpochMs): RecentRow {
  return { key: seq, taskId, title, body, age: formatAgo(sentAt, now) }
}

/** The popover's sections at `now`, in order, leaving out each one with nothing in it. None when nothing's in flight. */
export function menuBarSections(snapshot: MenuBarSnapshot, now: EpochMs): MenuBarSection[] {
  const sections: MenuBarSection[] = [
    { kind: MenuBarSectionKind.NeedsYou, rows: snapshot.needsYou.map(needsYouRow) },
    { kind: MenuBarSectionKind.Working, rows: snapshot.working.map((item) => workingRow(item, now)) },
    { kind: MenuBarSectionKind.Recent, rows: snapshot.recent.map((sent) => recentRow(sent, now)) },
  ]
  return sections.filter((section) => section.rows.length > 0)
}
