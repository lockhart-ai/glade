import { TaskState, UNTITLED_TASK_TITLE, type EpochMs, type Task } from '../../shared/domain'
import { taskIndicator } from '../../shared/taskIndicator'
import { classNames } from '../components/classNames'
import { Dot } from '../components'
import { formatRelativeTime } from './relativeTime'
import styles from './TaskRow.module.css'

/** What a task without a title yet is called. */
export const UNTITLED = UNTITLED_TASK_TITLE
/** What an active task without a status yet says. */
export const NO_STATUS = 'Waiting for instructions'

export interface TaskRowProps {
  task: Task
  /** The current time, for the relative time. */
  now: EpochMs
  selected: boolean
  onSelect: (taskId: string) => void
}

/** One task in the list: its state dot, title, relative time, and one line of status. Unread rows are bold. */
export function TaskRow({ task, now, selected, onSelect }: TaskRowProps): React.JSX.Element {
  const status = task.status === '' && task.state === TaskState.Active ? NO_STATUS : task.status
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
