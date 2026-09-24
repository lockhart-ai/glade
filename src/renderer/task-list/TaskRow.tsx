import { TaskState, UNTITLED_TASK_TITLE, type EpochMs, type Task } from '../../shared/domain'
import type { TextPart } from '../../shared/search'
import { TaskIndicator, taskIndicator } from '../../shared/taskIndicator'
import { errorStatusLine } from '../../shared/taskError'
import { classNames } from '../components/classNames'
import { Dot } from '../components'
import { isPaused, pausedStatusLine } from '../pause/pauseModel'
import { Highlighted, Marked } from '../search/Highlight'
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
  /** A search result's: what to mark in the title (from `highlightPattern`). */
  highlight?: RegExp | null
  /** A search result's: the snippet shown, wrapped, instead of the status line. */
  snippet?: readonly TextPart[] | null
}

/**
 * The row's line of status: what stopped the agent, while an error has; why its turn is paused and until when, while
 * it's paused; otherwise the task's status.
 */
function statusLine(task: Task, now: EpochMs): string {
  if (taskIndicator(task) === TaskIndicator.Error) return errorStatusLine(task.error)
  if (isPaused(task)) return pausedStatusLine(task.pause, now)
  return task.status === '' && task.state === TaskState.Active ? NO_STATUS : task.status
}

/**
 * One task in the list: its state dot, title, relative time, and one line of status ("Error: API overloaded · retry?"
 * while an error has stopped its agent, "Paused: usage limit · resumes 11:42" while it's paused). Unread rows are bold.
 * As a search result, its title has the matches marked, and a snippet around a match can take the status line's place.
 */
export function TaskRow({
  task,
  now,
  selected,
  onSelect,
  highlight = null,
  snippet = null,
}: TaskRowProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-current={selected ? 'true' : undefined}
      className={classNames(
        styles.row,
        selected && styles.selected,
        snippet !== null && styles.result,
        task.unread && styles.unread,
        task.state === TaskState.Done && styles.done,
      )}
      onClick={() => {
        onSelect(task.id)
      }}
    >
      <span className={styles.line}>
        <Dot state={taskIndicator(task)} />
        <span className={styles.title}>
          <Highlighted text={task.title === '' ? UNTITLED : task.title} pattern={highlight} />
        </span>
        <span className={styles.time}>
          {formatRelativeTime(task.updatedAt, now)}
          {task.unread && <span className={styles.unreadDot} role="img" aria-label="Unread" />}
        </span>
      </span>
      {snippet === null ? (
        <span className={styles.status}>{statusLine(task, now)}</span>
      ) : (
        <span className={styles.snippet}>
          <Marked parts={snippet} />
        </span>
      )}
    </button>
  )
}
