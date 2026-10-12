import type { Migration } from '../migrate'

/**
 * Adds the tables Glade's own todos live in (#609): `todos`, one row per todo, and `todo_counters`, the next id
 * `create_todo` gives a task, which only ever goes up, so a deleted todo's number is never given to another. Nothing
 * reads or writes either table yet — the agent still keeps its list with Claude Code's own `TaskCreate` and
 * `TaskUpdate`, which the tool log derives it from (`../../todos/todos`) — so this migration only adds the shape; a
 * later one carries every task's list into it.
 *
 * `id` is the `N` of what was `Task #N`: a plain integer, scoped to the task, assigned once and never reused even
 * once its row is gone, which is what `todo_counters.next_id` guarantees. `state` and `note` are Glade's own words
 * for where a todo stands and the line under it (`src/shared/domain.ts`'s `TodoState` and `Todo.note`), not Claude
 * Code's `status`/`activeForm`: a tool's input may still use its own words, but what's stored here doesn't.
 */
export const gladeTodosMigration: Migration = {
  version: 73,
  name: "Add Glade's own todos table and id counter",
  up(db) {
    db.exec(`
      CREATE TABLE todos (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        id INTEGER NOT NULL CHECK (id > 0),
        text TEXT NOT NULL CHECK (text <> ''),
        note TEXT CHECK (note <> ''),
        state TEXT NOT NULL CHECK (state IN ('todo', 'doing', 'done', 'waiting')),
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, id)
      ) STRICT;

      CREATE TABLE todo_counters (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        next_id INTEGER NOT NULL CHECK (next_id > 0)
      ) STRICT;
    `)
  },
}
