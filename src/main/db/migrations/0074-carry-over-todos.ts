import type { Migration } from '../migrate'
import { carryOverTodos } from '../../todos/carry-over'

/**
 * Carries every task's todos over into its own table (#609), the one time, from whatever its tool log holds:
 * `TaskCreate`, `TaskUpdate` and `TodoWrite` calls, Claude Code's own, now that no Glade session is offered them any
 * more. A todo the agent had closed with `close_todo` before this (`retired_todos`, #593) stays out, the same as it
 * read on the Todos tab the day before this ran; nothing calls `close_todo` after it, so the table is never consulted
 * again. Nothing else reads the shared list folder or `retired_todos` here: a task with neither carries over exactly
 * what its tool log alone already showed.
 */
export const carryOverTodosMigration: Migration = {
  version: 74,
  name: "Carry every task's todos into Glade's own table",
  up(db) {
    const taskIds = db.prepare('SELECT id FROM tasks').pluck().all() as string[]
    const retiredIdsOf = db.prepare('SELECT todo_id FROM retired_todos WHERE task_id = ?').pluck()
    for (const taskId of taskIds) {
      const retiredIds = new Set(retiredIdsOf.all(taskId) as string[])
      carryOverTodos(db, taskId, retiredIds)
    }
  },
}
