import type { Migration } from '../migrate'

/**
 * Adds the stranded todos the agent has closed (`close_todo`, #593): which of a task's todos Glade is to leave out of
 * its list everywhere — the Todos tab, its summaries, `list_children` and the "Your todos:" line — once the agent has
 * recreated what was still live and closed the old one. The tool log keeps the todo's history; this table only takes it
 * out of what Glade derives. The todo's id is Claude Code's own (`Task #N`), as `child_filings` names todos by.
 */
export const retiredTodosMigration: Migration = {
  version: 71,
  name: 'Add the todos the agent closed',
  up(db) {
    db.exec(`
      CREATE TABLE retired_todos (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        todo_id TEXT NOT NULL CHECK (todo_id <> '' AND todo_id <> 'unfiled'),
        retired_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, todo_id)
      ) STRICT;
    `)
  },
}
