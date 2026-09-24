import { DividerKind, TaskState, ToolEventKind, type EpochMs, type Task, type ToolEvent } from '../../shared/domain'
import { TaskIndicator, taskIndicator } from '../../shared/taskIndicator'
import { clockTime } from '../chat/chatModel'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** What the header says in place of each field the agent hasn't set yet, from docs/design/html/01-new-task.html. */
export const EMPTY_TITLE = 'New task'
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
 * and `Active · reopened` while the agent works on the message that reopened the task.
 */
export function pillLabel(
  task: Pick<Task, 'state' | 'activity' | 'doneAt' | 'updatedAt'>,
  reopened: Reopening | null = null,
): string {
  switch (taskIndicator(task)) {
    case TaskIndicator.Working:
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
 * The time beside the pill: when a done task ran (`10:42 – 11:26`), when a reopened task was reopened and first done
 * (`reopened just now · first done Sep 23`), otherwise how long ago an active task was started (`started 42m ago`), or
 * created while it's still new (`created just now`).
 */
export function timing(task: Task, now: EpochMs, reopened: Reopening | null = null): string {
  if (task.state === TaskState.Done) {
    return `${clockTime(task.createdAt)} – ${clockTime(task.doneAt ?? task.updatedAt)}`
  }
  if (reopened !== null) {
    return `reopened ${formatAgo(reopened.reopenedAt, now)} · first done ${formatDay(reopened.firstDoneAt)}`
  }
  return `${isNewTask(task) ? 'created' : 'started'} ${formatAgo(task.createdAt, now)}`
}
