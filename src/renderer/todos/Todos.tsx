import { TodoState, type EpochMs, type Todo, type TodoList } from '../../shared/domain'
import { classNames } from '../components/classNames'
import { ContextMenu, todoMenu, useContextMenu, useMenuCommands, type ContextMenuTargetProps } from '../context-menus'
import { useGladeStore } from '../store/react'
import { formatAgo, formatFullDate } from '../task-header/headerModel'
import { orderTodos, progressBar, progressHeading, todoProgress } from './todosModel'
import styles from './Todos.module.css'

/** What the tab shows while the agent has no list. */
export const NO_TODOS = 'No todos yet.'

/** The line under the heading, from 09-todos.html. */
export const TODOS_EXPLAINER = 'The agent writes this list and checks items off as it works.'

/** How each state reads to a screen reader, ahead of the item's text. */
const STATE_LABELS: Readonly<Record<TodoState, string>> = {
  [TodoState.Todo]: 'To do',
  [TodoState.Doing]: 'Doing',
  [TodoState.Done]: 'Done',
  [TodoState.Waiting]: 'Waiting on you',
}

const STATE_CLASSES: Readonly<Record<TodoState, string | undefined>> = {
  [TodoState.Todo]: styles.todo,
  [TodoState.Doing]: styles.doing,
  [TodoState.Done]: styles.done,
  [TodoState.Waiting]: styles.waiting,
}

/**
 * An item's icon (#308): a filled teal check once it's done, and a hollow ring before it's started (or while it waits
 * on you), so done and not done tell apart at a glance; while it's being worked on, a ring with a dot in it.
 */
function StateIcon({ state }: { readonly state: TodoState }): React.JSX.Element {
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

interface FinishedAtProps {
  readonly at: EpochMs
  readonly now: EpochMs
}

/** When a done item was finished: how long ago, with the exact time on hover. */
function FinishedAt({ at, now }: FinishedAtProps): React.JSX.Element {
  return (
    <time className={styles.finished} dateTime={new Date(at).toISOString()} title={formatFullDate(at)}>
      <span className={styles.hidden}>Finished </span>
      {formatAgo(at, now)}
    </time>
  )
}

interface TodoItemProps {
  readonly todo: Todo
  readonly now: EpochMs
  /** What opens its context menu: a right-click, or ⇧F10 while it has the focus. */
  readonly menuTarget: ContextMenuTargetProps
}

function TodoItem({ todo, now, menuTarget }: TodoItemProps): React.JSX.Element {
  return (
    <li className={classNames(styles.item, STATE_CLASSES[todo.state])} tabIndex={0} {...menuTarget}>
      <span className={styles.icon} aria-hidden="true">
        <StateIcon state={todo.state} />
      </span>
      <div className={styles.body}>
        <span className={styles.hidden}>{`${STATE_LABELS[todo.state]}: `}</span>
        <div className={styles.text}>{todo.text}</div>
        {todo.note !== null && <div className={styles.note}>{todo.note}</div>}
      </div>
      {todo.state === TodoState.Done && todo.completedAt !== null && <FinishedAt at={todo.completedAt} now={now} />}
    </li>
  )
}

export interface TodosProps {
  readonly taskId: string
  /** The task's todo list; null or undefined while the agent has kept none. */
  readonly list: TodoList | null | undefined
  readonly now: EpochMs
}

/**
 * The Todos tab (`docs/design/html/09-todos.html`): how many of the agent's todos are done, with a progress bar and when
 * the agent last changed the list, then each item as todo (a hollow ring, at full strength), doing (blue, with its note),
 * done (a filled teal check, dimmed and struck through, with when it was finished) or waiting on you (purple). The items come grouped by state: active, then done (the most recently
 * finished first), then not started (`orderTodos`). The agent keeps the list; you only read it. An item's context menu
 * copies it, or asks the agent about it.
 */
export function Todos({ taskId, list, now }: TodosProps): React.JSX.Element {
  const menu = useContextMenu<Todo>()
  const { copy } = useMenuCommands()
  const insertIntoInput = useGladeStore((state) => state.insertIntoInput)
  if (list === null || list === undefined || list.items.length === 0) return <p className={styles.empty}>{NO_TODOS}</p>
  const progress = todoProgress(list)
  const bar = progressBar(progress)
  const entries = (todo: Todo) =>
    todoMenu({
      copy: () => {
        copy(todo.text)
      },
      ask: () => {
        insertIntoInput(taskId, askAboutTodo(todo))
      },
    })
  return (
    <div className={styles.todos}>
      <div className={styles.summary}>
        <div className={styles.headingRow}>
          <span className={styles.heading}>{progressHeading(progress)}</span>
          <span className={styles.updated}>{`updated ${formatAgo(list.updatedAt, now)}`}</span>
        </div>
        <div
          className={styles.bar}
          role="progressbar"
          aria-label="Todos done"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.done}
        >
          <div className={styles.barDone} style={{ width: `${String(bar.done)}%` }} />
          <div className={styles.barDoing} style={{ width: `${String(bar.doing)}%` }} />
        </div>
        <div className={styles.explainer}>{TODOS_EXPLAINER}</div>
      </div>
      <ul className={styles.list} aria-label="Todos">
        {orderTodos(list.items).map(({ todo, position }) => (
          <TodoItem key={position} todo={todo} now={now} menuTarget={menu.targetProps(todo)} />
        ))}
      </ul>
      <ContextMenu label="Todo actions" state={menu} entries={entries} />
    </div>
  )
}
