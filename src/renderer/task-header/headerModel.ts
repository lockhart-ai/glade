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
 * How long ago `at` was, as the header says it: `just now` under a minute, then `4m ago`, `1h 49m ago` (`2h ago` on the
 * hour) and `3d ago`, each rounded down. A time in the future (a clock that moved back) counts as just now.
 */
export function formatAgo(at: EpochMs, now: EpochMs): string {
  const elapsed = now - at
  if (elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return `${String(Math.floor(elapsed / MINUTE))}m ago`
  if (elapsed < DAY) {
    const hours = Math.floor(elapsed / HOUR)
    const minutes = Math.floor((elapsed % HOUR) / MINUTE)
    return minutes === 0 ? `${String(hours)}h ago` : `${String(hours)}h ${String(minutes)}m ago`
  }
  return `${String(Math.floor(elapsed / DAY))}d ago`
}

/** A day as the done pill shows it, e.g. `Sep 23`. */
export function formatDay(at: EpochMs): string {
  return new Date(at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
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
 * The status pill's label: `Active · working`, `Active · waiting on you`, `Active · stopped by an error`, `Done · Sep 23`,
 * `Active · reopened` while the agent works on the message that reopened the task, and `Active · paused` while its
 * turn is paused (docs/design/html/17-usage-limit.html).
 */
export function pillLabel(
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
 * The time beside the pill: when a done task ran (`10:42 – 11:26`), or started for one backfilled done (`started Mar 12`), when a reopened task was reopened and first done
 * (`reopened just now · first done Sep 23`), otherwise how long ago an active task was started (`started 42m ago`), or
 * created while it's still new (`created just now`).
 */
export function timing(task: Task, now: EpochMs, reopened: Reopening | null = null): string {
  if (task.state === TaskState.Done) {
    const doneAt = task.doneAt ?? task.updatedAt
    // A past task backfilled done (`create_task` with `startedAt`) has no span of its own: only when it started.
    if (doneAt === task.createdAt) return `started ${formatDay(task.createdAt)}`
    return `${clockTime(task.createdAt)} – ${clockTime(doneAt)}`
  }
  if (reopened !== null) {
    return `reopened ${formatAgo(reopened.reopenedAt, now)} · first done ${formatDay(reopened.firstDoneAt)}`
  }
  return `${isNewTask(task) ? 'created' : 'started'} ${formatAgo(task.createdAt, now)}`
}
