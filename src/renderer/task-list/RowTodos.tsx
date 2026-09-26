import type { TodoSummary } from '../../shared/domain'
import { allTodosDone, todoSummaryLabel } from '../../shared/todoSummary'
import styles from './TaskRow.module.css'

/** The ring's radius, in the 12×12 view box: a 2px stroke inside it. */
const RADIUS = 4.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

export interface RowTodosProps {
  todos: TodoSummary
}

/** How much of the ring the done items fill: its dash, then the gap to the ring's end. */
export function ringDash({ done, total }: TodoSummary): string {
  return `${((CIRCUMFERENCE * done) / total).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`
}

/**
 * A task's todo progress, first on its row's indicators line (`docs/design/html/09-todos.html`): a ring filling with
 * the done items and `3/7`, or a check once every item is done. Its tooltip names the items being worked on now.
 */
export function RowTodos({ todos }: RowTodosProps): React.JSX.Element {
  const done = allTodosDone(todos)
  const label = todoSummaryLabel(todos)
  return (
    <span className={styles.todos} role="img" aria-label={label} title={label} data-done={done}>
      <svg className={styles.todosIcon} width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
        {done ? (
          <>
            <circle className={styles.checkFill} cx="6" cy="6" r="6" />
            <path className={styles.checkMark} d="M3.4 6.2 5.1 7.9 8.6 4.4" />
          </>
        ) : (
          <>
            <circle className={styles.ringTrack} cx="6" cy="6" r={RADIUS} />
            <circle
              className={styles.ringDone}
              cx="6"
              cy="6"
              r={RADIUS}
              strokeDasharray={ringDash(todos)}
              transform="rotate(-90 6 6)"
            />
          </>
        )}
      </svg>
      {`${String(todos.done)}/${String(todos.total)}`}
    </span>
  )
}
