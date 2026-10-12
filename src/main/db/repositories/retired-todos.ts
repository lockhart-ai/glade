import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

// The stranded todos the agent has closed (`close_todo`, #593; migration 71): which of a task's todos Glade leaves out
// of its list everywhere once the agent has closed them. The tool log keeps the todo's history; this table only takes
// it out of what Glade derives (`todoListFor`).

/** A stranded todo the agent closed, and when. */
export interface RetiredTodo {
  readonly taskId: string
  readonly todoId: string
  readonly retiredAt: EpochMs
}

/** The ids of the task's todos the agent has closed. */
export function listRetiredTodoIds(db: Database, taskId: string): ReadonlySet<string> {
  return new Set(
    db
      .prepare('SELECT todo_id FROM retired_todos WHERE task_id = ?')
      .all(taskId)
      .map((raw) => new Row('retired_todos', raw).text('todo_id')),
  )
}

/** Whether the task's todo of this id has been closed. */
export function hasRetiredTodo(db: Database, taskId: string, todoId: string): boolean {
  return db.prepare('SELECT 1 FROM retired_todos WHERE task_id = ? AND todo_id = ?').get(taskId, todoId) !== undefined
}

/** Marks the task's todo of this id closed; closing it again changes nothing. */
export function retireTodo(db: Database, taskId: string, todoId: string, retiredAt: EpochMs): void {
  db.prepare('INSERT OR IGNORE INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run(
    taskId,
    todoId,
    retiredAt,
  )
}
