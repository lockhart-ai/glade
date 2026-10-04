/**
 * A task row's line of status in the task list: what stopped the agent, while an error has; what it waits on you for,
 * while a permission card is open; why its turn is paused and until when, while it's paused; otherwise the task's
 * status. The row shows it through `StatusLine` (`./TaskRow`), which renders again only when the line itself changed.
 */
import { TaskState, type EpochMs, type Task } from '../../shared/domain'
import { sandboxAskPhrase } from '../../shared/sandbox'
import { errorStatusLine } from '../../shared/taskError'
import { TaskIndicator, taskIndicator } from '../../shared/taskIndicator'
import { isPaused, pausedStatusLine } from '../pause/pauseModel'

/** What a row says of a new task that has no status yet. */
export const NO_STATUS = 'Waiting for instructions'

/** What a row's line starts with while the task waits on a permission card. */
export const WAITING_ON_YOU = 'Waiting on you'

/** A row's line of status. */
export interface RowStatus {
  readonly text: string
  /**
   * Whether the task waits on a permission card: the line is then led by the shield, the mark of the sandbox and of
   * permissions (`docs/design/README.md`).
   */
  readonly permission: boolean
}

/** What `rowStatus` reads: the row's task, and the time. */
export interface RowStatusSource {
  readonly task: Task
  readonly now: EpochMs
}

/** Whether the row's line says the task waits on a permission card: an active task with one open, and no error. */
function waitsOnPermission(task: Task): boolean {
  return task.state === TaskState.Active && task.awaitingPermission && taskIndicator(task) !== TaskIndicator.Error
}

function lineOf({ task, now }: RowStatusSource): RowStatus {
  if (taskIndicator(task) === TaskIndicator.Error) return { text: errorStatusLine(task.error), permission: false }
  if (waitsOnPermission(task)) {
    // Status first, as every permission line: "Waiting on you: read ~/code/acme-web", or the status alone for a call
    // that asks nothing of the sandbox.
    const { permissionAsk } = task
    const text = permissionAsk === null ? WAITING_ON_YOU : `${WAITING_ON_YOU}: ${sandboxAskPhrase(permissionAsk)}`
    return { text, permission: true }
  }
  if (isPaused(task)) return { text: pausedStatusLine(task.pause, now), permission: false }
  return { text: task.status === '' && task.state === TaskState.Active ? NO_STATUS : task.status, permission: false }
}

/** A row's line of status, for its task now. `StatusLine` asks once each time it renders. */
export function rowStatus(source: RowStatusSource): RowStatus {
  return lineOf(source)
}

/** Whether a row's line reads the same for two tasks, or two moments: it then needn't render again. */
export function sameRowStatus(before: RowStatusSource, after: RowStatusSource): boolean {
  const [was, is] = [lineOf(before), lineOf(after)]
  return was.text === is.text && was.permission === is.permission
}
