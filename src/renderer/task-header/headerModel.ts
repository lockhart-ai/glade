import {
  DividerKind,
  TaskActivity,
  TaskState,
  ToolEventKind,
  UNTITLED_TASK_TITLE,
  type EpochMs,
  type Task,
  type ToolEvent,
} from '../../shared/domain'
import { TaskIndicator, taskIndicator } from '../../shared/taskIndicator'
import { clockTime } from '../chat/chatModel'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What the header says in place of each field the agent hasn't set yet, from docs/design/html/01-new-task.html. */
export const EMPTY_TITLE = UNTITLED_TASK_TITLE
export const EMPTY_OBJECTIVE = 'Set by your first message.'
export const EMPTY_STATUS = 'Nothing yet.'

/**
 * How old something made at `at` is, as the header shows it beside the title and on the Now row: `now` under a minute,
 * then `4m`, `1h 49m` (`2h` on the hour) and `3d`, each rounded down. A time in the future (a clock that moved back)
 * counts as now.
 */
export function formatAge(at: EpochMs, now: EpochMs): string {
  const elapsed = now - at
  if (elapsed < MINUTE) return 'now'
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m`
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    const minutes = Math.floor((elapsed % HOUR) / MINUTE)
    return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`
  }
  return `${String(Math.floor(elapsed / DAY))}d`
}

/** How long ago `at` was, in words: `just now` under a minute, then `4m ago`, `1h 49m ago` and `3d ago` (see formatAge). */
export function formatAgo(at: EpochMs, now: EpochMs): string {
  const age = formatAge(at, now)
  return age === 'now' ? 'just now' : `${age} ago`
}

/** A day as the done task's state dot says it, e.g. `Sep 23`. */
export function formatDay(at: EpochMs): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** A full date and time, as the age's tooltip gives it, e.g. `Sep 23, 2026, 10:42 AM`. */
export function formatFullDate(at: EpochMs): string {
  return new Date(at).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** A task is new until the agent sets any of its title, objective or status from the first message. */
export function isNewTask(task: Pick<Task, 'title' | 'objective' | 'status'>): boolean {
  return task.title === '' && task.objective === '' && task.status === ''
}

/** The header offers Mark done on an active task once the agent has set it up from the first message. */
export function offersMarkDone(task: Pick<Task, 'state' | 'title' | 'objective' | 'status'>): boolean {
  return task.state === TaskState.Active && !isNewTask(task)
}

/** Mark done works only while the agent isn't working: stop it first, so a turn never runs on in a done task. */
export function canMarkDone(task: Pick<Task, 'state' | 'activity' | 'title' | 'objective' | 'status'>): boolean {
  return offersMarkDone(task) && task.activity !== TaskActivity.Working
}

/** A task a message reopened, from its tool log's dividers (docs/design/html/06-reopen.html). */
export interface Reopening {
  /** When a message last reopened it. */
  readonly reopenedAt: EpochMs
  /** When it was first marked done, which the marked done divider keeps. */
  readonly firstDoneAt: EpochMs
  /** Whether the turn that reopened it is the latest one. */
  readonly latestTurn: boolean
}

/** How a task was reopened, or null if no message has reopened it. */
export function reopening(toolEvents: readonly ToolEvent[]): Reopening | null {
  let reopened: ToolEvent | undefined
  let firstDone: ToolEvent | undefined
  let latest = 0
  for (const event of toolEvents) {
    latest = Math.max(latest, event.turn)
    if (event.kind !== ToolEventKind.Divider) continue
    if (event.dividerKind === DividerKind.Reopened) reopened = event
    if (event.dividerKind === DividerKind.MarkedDone) firstDone ??= event
  }
  if (reopened === undefined || firstDone === undefined) return null
  return { reopenedAt: reopened.createdAt, firstDoneAt: firstDone.createdAt, latestTurn: reopened.turn === latest }
}

/**
 * What the state dot says, as its tooltip and accessible name: `Active · working`, `Active · waiting on you`,
 * `Active · stopped by an error`, `Done · Sep 23`, `Active · reopened` while the agent works on the message that reopened
 * the task, and `Active · paused` while its turn is paused (docs/design/html/17-usage-limit.html).
 */
export function stateLabel(
  task: Pick<Task, 'state' | 'activity' | 'doneAt' | 'updatedAt'>,
  reopened: Reopening | null = null,
): string {
  switch (taskIndicator(task)) {
    case TaskIndicator.Working:
      if (task.activity === TaskActivity.Paused) return 'Active · paused'
      return reopened?.latestTurn === true ? 'Active · reopened' : 'Active · working'
    case TaskIndicator.Waiting:
      return 'Active · waiting on you'
    case TaskIndicator.Error:
      return 'Active · stopped by an error'
    case TaskIndicator.Done:
      return `Done · ${formatDay(task.doneAt ?? task.updatedAt)}`
  }
}

/**
 * Whether a done task was backfilled done (`create_task` with `startedAt`): it was done the moment it was made, so it
 * has no span of its own, only when it started.
 */
function isBackfilledDone(task: Pick<Task, 'state' | 'createdAt' | 'doneAt' | 'updatedAt'>): boolean {
  return task.state === TaskState.Done && (task.doneAt ?? task.updatedAt) === task.createdAt
}

/**
 * The muted text after the title: an active task's age (`42m`, or `now` just after it's created), the clock times a
 * done task ran between (`10:42 – 11:26`), or the day a past task backfilled done started (`started Mar 12`).
 */
export function age(task: Pick<Task, 'state' | 'createdAt' | 'doneAt' | 'updatedAt'>, now: EpochMs): string {
  if (isBackfilledDone(task)) return `started ${formatDay(task.createdAt)}`
  if (task.state === TaskState.Done) {
    return `${clockTime(task.createdAt)} – ${clockTime(task.doneAt ?? task.updatedAt)}`
  }
  return formatAge(task.createdAt, now)
}

/**
 * The age's tooltip, in full dates: when the task was started (created, while it's still new), when a reopened task
 * was first done and reopened, and when a done task was done (not for one backfilled done, which has only its start).
 */
export function ageTitle(task: Task, reopened: Reopening | null = null): string {
  const parts = [`${isNewTask(task) ? 'Created' : 'Started'} ${formatFullDate(task.createdAt)}`]
  if (reopened !== null) {
    parts.push(`first done ${formatFullDate(reopened.firstDoneAt)}`, `reopened ${formatFullDate(reopened.reopenedAt)}`)
  }
  if (task.state === TaskState.Done && !isBackfilledDone(task)) {
    parts.push(`done ${formatFullDate(task.doneAt ?? task.updatedAt)}`)
  }
  return parts.join(' · ')
}
