// What the Todos tab's cards share (`./TodoHub`): the tab's empty state, each state's icon and name, and what Ask agent
// about this writes.
import { TodoState, type Todo } from '../../shared/domain'
import styles from './Todos.module.css'

/** What the tab shows while the agent has no list. */
export const NO_TODOS = 'No todos yet.'

/** The tab's empty state: the line, centred, for a task with no todos and nothing made. */
export function NoTodos(): React.JSX.Element {
  return <p className={styles.empty}>{NO_TODOS}</p>
}

/** How each state reads to a screen reader, ahead of the item's text. */
export const STATE_LABELS: Readonly<Record<TodoState, string>> = {
  [TodoState.Todo]: 'To do',
  [TodoState.Doing]: 'Doing',
  [TodoState.Done]: 'Done',
  [TodoState.Waiting]: 'Waiting on you',
}

/**
 * An item's icon (#308): a filled teal check once it's done, and a hollow ring before it's started (or while it waits
 * on you), so done and not done tell apart at a glance; while it's being worked on, a ring with a dot in it.
 */
export function StateIcon({ state }: { readonly state: TodoState }): React.JSX.Element {
  switch (state) {
    case TodoState.Doing:
      return (
        <span className={styles.doingRing}>
          <span className={styles.doingDot} />
        </span>
      )
    case TodoState.Done:
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" fill="currentColor" />
          <path
            className={styles.check}
            d="m7.5 12.3 3.2 3.2 6.3-6.8"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case TodoState.Todo:
    case TodoState.Waiting:
      return (
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="12" cy="12" r="8" />
        </svg>
      )
  }
}

/** What Ask agent about this puts in the message field, for you to finish with your question. */
export function askAboutTodo(todo: Todo): string {
  return `About the todo “${todo.text}”: `
}
