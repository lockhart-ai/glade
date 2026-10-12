/**
 * The Todos tab's list, read from Glade's own `todos` table (#609): rows the `create_todo`, `update_todo` and
 * `list_todos` tools keep (`../agent/glade-tools`), never from Claude Code's own todo tools, which no Glade session
 * is offered any more (`../agent/sdk-backend`'s `DISALLOWED_TOOLS`).
 *
 * A task from before #609 carried its list over once, by replaying its tool log (`./carry-over`), so its ids, text,
 * note, state and finish time read exactly as they did before. Nothing is ever `stranded`: that was a restart's
 * session losing track of a list kept outside Glade's own database, which can't happen once Glade owns it.
 */
import type { Database } from 'better-sqlite3'
import type { Task, TodoList } from '../../shared/domain'
import { sameTodoSummary, summarizeTodos } from '../../shared/todoSummary'
import { getTodoCounter, latestTodoChangeAt, listTodos } from '../db/repositories/glade-todos'
import { getTask, listStaleTodoTaskIds, setTaskTodos } from '../db/repositories/tasks'

/**
 * A task's todo list, read from its own table; null when it has never made one (no counter: `create_todo` hasn't run
 * for it, and the carry-over found nothing in its tool log either). A task that has made and since deleted every
 * todo it ever had also reads null here — the Todos tab shows the same empty state either way (`todos.length === 0`
 * in `TodoHub.tsx`), so the two aren't told apart.
 */
export function todoListFor(db: Database, taskId: string): TodoList | null {
  if (getTodoCounter(db, taskId) === null) return null
  const items = listTodos(db, taskId)
  if (items.length === 0) return null
  return { items, updatedAt: latestTodoChangeAt(db, taskId) ?? Date.now() }
}

/** A task's todo list worked out again (`refreshTodos`). */
export interface RefreshedTodos {
  /** The list, for the Todos tab. */
  readonly list: TodoList | null
  /** The task with its new todo summary, when the summary changed, to tell the windows; null when it didn't. */
  readonly changed: Task | null
}

/**
 * Works a task's todo list out from its own table and keeps its summary on the task, for its row in the task list.
 * Run whenever `create_todo` or `update_todo` changes it, so the row keeps up with the Todos tab.
 */
export function refreshTodos(db: Database, taskId: string): RefreshedTodos {
  const list = todoListFor(db, taskId)
  const todos = summarizeTodos(list)
  const task = getTask(db, taskId)
  if (task === undefined) return { list, changed: null }
  setTaskTodos(db, taskId, todos)
  return { list, changed: sameTodoSummary(task.todos, todos) ? null : { ...task, todos } }
}

/**
 * Works out the todo summaries marked stale: the tasks that kept a todo list before Glade kept summaries (migration
 * 29). Run once main has the database, before the window lists any task. Answers how many it worked out.
 */
export function refreshStaleTodos(db: Database): number {
  return db.transaction(() => {
    const ids = listStaleTodoTaskIds(db)
    for (const id of ids) refreshTodos(db, id)
    return ids.length
  })()
}
