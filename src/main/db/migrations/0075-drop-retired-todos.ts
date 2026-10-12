import type { Migration } from '../migrate'

/**
 * Drops the retired todos (#609): the stranded todos the agent had closed (`close_todo`, #593; migration 72), which
 * only existed because a task's todo list lived outside Glade's own database, where a session restart lost track of
 * it. Todos live in Glade's own `todos` table now (migration 73, the tools since #618), nothing can be stranded, and
 * the tool that closed them is gone — so there is nothing left for the table to hold.
 */
export const dropRetiredTodosMigration: Migration = {
  version: 75,
  name: 'Drop the retired todos',
  up(db) {
    db.exec(`
      DROP TABLE retired_todos;
    `)
  },
}
