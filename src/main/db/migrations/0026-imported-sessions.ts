import type { Migration } from '../migrate'

/**
 * Adds what importing Claude Code sessions needs (`docs/control-api.md`, "Importing Claude Code sessions"):
 * `imported_at`, when a task was imported from a Claude Code transcript (null for Glade's own tasks), and a unique index
 * on `session_id` where it's set, so one session belongs to at most one task and importing it twice, even at once,
 * finds the task that has it.
 *
 * No two tasks should share a session, but if two do, the older keeps it and the other forgets it (its next message
 * starts a new session), rather than the app failing to start.
 */
export const importedSessionsMigration: Migration = {
  version: 26,
  name: 'Add imported sessions',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN imported_at INTEGER;

      UPDATE tasks SET session_id = NULL
      WHERE session_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM tasks AS older
        WHERE older.session_id = tasks.session_id
          AND (older.created_at < tasks.created_at OR (older.created_at = tasks.created_at AND older.id < tasks.id))
      );

      CREATE UNIQUE INDEX tasks_session_id ON tasks (session_id) WHERE session_id IS NOT NULL;
    `)
  },
}
