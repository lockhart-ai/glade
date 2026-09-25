import type { Migration } from '../migrate'

/**
 * Adds each task's todo progress, for its row in the task list (#246): `todos`, the summary of the todo list its tool
 * log leaves (JSON, `TodoSummary` in `src/shared/domain.ts`; null for no list), so the list can show every task's
 * progress, Done ones included, without reading each one's tool log. Main keeps it in step with the tool log
 * (`src/main/todos`).
 *
 * `todos_stale` marks a task whose summary must be worked out again from its tool log. Working a list out is code, not
 * SQL, so this migration only marks the tasks that have called a todo tool; main works theirs out when it starts
 * (`refreshStaleTodos`) and clears the mark.
 */
export const taskTodosMigration: Migration = {
  version: 29,
  name: 'Add task todo progress',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN todos TEXT CHECK (todos IS NULL OR (json_valid(todos) AND json_type(todos) = 'object'));
      ALTER TABLE tasks ADD COLUMN todos_stale INTEGER NOT NULL DEFAULT 0 CHECK (todos_stale IN (0, 1));

      UPDATE tasks SET todos_stale = 1
      WHERE id IN (
        SELECT task_id FROM tool_events
        WHERE kind = 'tool_call' AND tool_name IN ('TodoWrite', 'TaskCreate', 'TaskUpdate')
      );
    `)
  },
}
