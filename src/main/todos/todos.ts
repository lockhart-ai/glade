/**
 * The Todos tab's list, read from Glade's own `todos` table (#609): rows the `create_todo`, `update_todo` and
 * `list_todos` tools keep (`../agent/glade-tools`), never from Claude Code's own todo tools, which no Glade session
 * is offered any more (`../agent/sdk-backend`'s `DISALLOWED_TOOLS`).
 *
 * A task from before #609 carried its list over once, by replaying its tool log (`./carry-over`), so its ids, text,
 * note, state and finish time read exactly as they did before. Nothing is ever `stranded`: that was a restart's
 * session losing track of a list kept outside Glade's own database, which can't happen once Glade owns it.
 *
 * `strandedIds` and `liveTodos` stay here, unused by this file's own `todoListFor` any more, for #593's stranded
 * machinery (`close_todo`, the Stranded group, `../openrouter/task-list`), which a later PR removes along with them.
 */
import type { Database } from 'better-sqlite3'
import type { Task, Todo, TodoList } from '../../shared/domain'
import { sameTodoSummary, summarizeTodos } from '../../shared/todoSummary'
import { liveTodoIds } from '../openrouter/task-list'
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

/**
 * The highest todo id Glade has ever given a task, as a number; null while it's given none. Its counter only ever
 * goes up (`allocateTodoId`), so this is exact even once an id's todo is deleted.
 */
export function highestTodoId(db: Database, taskId: string): number | null {
  const next = getTodoCounter(db, taskId)
  return next === null || next <= 1 ? null : next - 1
}

/** The ids of a list its shared list folder doesn't hold, and so are stranded (#593, for `liveTodos` alone). */
export function strandedIds(todos: readonly Todo[], live: ReadonlySet<string> | null): ReadonlySet<string> {
  const ids = new Set<string>()
  if (live !== null) for (const { id } of todos) if (id !== null && !live.has(id)) ids.add(id)
  return ids
}

/**
 * `todoListFor`, with every numbered todo the task's shared list folder doesn't hold marked stranded (#593): unused
 * by this file any more (nothing calls it; see the module comment), kept for the stranded machinery that still
 * imports it until a later PR removes it.
 */
export function liveTodos(db: Database, taskId: string, dataDir: string | undefined): TodoList | null {
  const list = todoListFor(db, taskId)
  if (list === null || dataDir === undefined) return list
  const live = liveTodoIds(dataDir, taskId)
  if (live === null) return list
  const stranded = strandedIds(list.items, live)
  if (stranded.size === 0) return list
  return {
    ...list,
    items: list.items.map((todo) => (todo.id !== null && stranded.has(todo.id) ? { ...todo, stranded: true } : todo)),
  }
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
