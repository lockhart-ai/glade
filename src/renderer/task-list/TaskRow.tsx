import { TaskState, type EpochMs, type Task } from '../../shared/domain'
import { TaskIndicator, taskIndicator } from '../../shared/taskIndicator'
import { errorStatusLine } from '../../shared/taskError'
import { classNames } from '../components/classNames'
import { Dot } from '../components'
import { formatRelativeTime } from './relativeTime'
import styles from './TaskRow.module.css'

/** What a task without a title yet is called. */
export const UNTITLED = 'New task'
/** What an active task without a status yet says. */
export const NO_STATUS = 'Waiting for instructions'

export interface TaskRowProps {
  task: Task
  /** The current time, for the relative time. */
  now: EpochMs
  selected: boolean
  onSelect: (taskId: string) => void
}

/** The row's line of status: what stopped the agent, while an error has; otherwise the task's status. */
function statusLine(task: Task): string {
  if (taskIndicator(task) === TaskIndicator.Error) return errorStatusLine(task.error)
  return task.status === '' && task.state === TaskState.Active ? NO_STATUS : task.status
}

/**
 * One task in the list: its state dot, title, relative time, and one line of status ("Error: API overloaded · retry?"
 * while an error has stopped its agent). Unread rows are bold.
 */
export function TaskRow({ task, now, selected, onSelect }: TaskRowProps): React.JSX.Element {
  const status = statusLine(task)
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      className={classNames(
        styles.row,
        selected && styles.selected,
        task.unread && styles.unread,
        task.state === TaskState.Done && styles.done,
      )}
      onClick={() => {
        onSelect(task.id)
      }}
    >
      <span className={styles.line}>
        <Dot state={taskIndicator(task)} />
        <span className={styles.title}>{task.title === '' ? UNTITLED : task.title}</span>
        <span className={styles.time}>
          {formatRelativeTime(task.updatedAt, now)}
          {task.unread && <span className={styles.unreadDot} role="img" aria-label="Unread" />}
        </span>
      </span>
      <span className={styles.status}>{status}</span>
    </button>
  )
}
