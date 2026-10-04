import type { Database } from 'better-sqlite3'
import { ChildFilter, type TodoPanel } from '../../../shared/todoHub'
import { Row } from './rows'

// What each todo's panel remembers in the todo hub (P16, `src/shared/todoHub.ts`): whether it's open, and its filter.

const FILTERS = Object.values(ChildFilter)

/**
 * The filters a panel could be left on until #535 took subagents and watchers out of the hub. The table's `filter`
 * check still allows them, and a row left on one stays as it is until its panel is next opened, closed or filtered:
 * it's read as All (`parseTodoPanel`), and nothing writes one.
 */
const RETIRED_FILTERS: readonly string[] = ['subagent', 'watcher']

function parseTodoPanel(raw: unknown): TodoPanel {
  const row = new Row('todo_panels', raw)
  return {
    taskId: row.text('task_id'),
    todoId: row.text('todo_id'),
    open: row.flag('open'),
    filter: RETIRED_FILTERS.includes(row.text('filter')) ? ChildFilter.All : row.oneOf('filter', FILTERS),
  }
}

/**
 * Remembers how you left a todo's panel. One that's closed and showing all is how every panel starts, so it's
 * forgotten instead.
 */
export function setTodoPanel(db: Database, { taskId, todoId, open, filter }: TodoPanel): void {
  if (!open && filter === ChildFilter.All) {
    db.prepare('DELETE FROM todo_panels WHERE task_id = ? AND todo_id = ?').run(taskId, todoId)
    return
  }
  db.prepare(
    `INSERT INTO todo_panels (task_id, todo_id, open, filter) VALUES (?, ?, ?, ?)
    ON CONFLICT (task_id, todo_id) DO UPDATE SET open = excluded.open, filter = excluded.filter`,
  ).run(taskId, todoId, open ? 1 : 0, filter)
}

/** The panels of a task's todos you changed from how they start, by todo id. A todo without one is closed, showing all. */
export function listTodoPanels(db: Database, taskId: string): TodoPanel[] {
  return db
    .prepare('SELECT task_id, todo_id, open, filter FROM todo_panels WHERE task_id = ? ORDER BY todo_id')
    .all(taskId)
    .map(parseTodoPanel)
}
