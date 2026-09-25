import type { Migration } from '../migrate'

/**
 * Adds what backfilling past tasks through the control API needs (`docs/control-api.md`, "Backfilling past tasks"): one
 * row per task that has either of them.
 *
 * - `external_id`: the caller's own id for the task (e.g. the notes folder it came from), unique across tasks, so a
 *   backfill run again finds the task it made rather than making another.
 * - `handoff`: the task's handoff note, Markdown, at most 32 KB of UTF-8, and `handoff_at`, when it was last set. Its
 *   agent gets it in its system prompt, and the chat shows it on the Backfilled card.
 *
 * The rows go with their task.
 */
export const taskBackfillsMigration: Migration = {
  version: 26,
  name: 'Add task backfills',
  up(db) {
    db.exec(`
      CREATE TABLE task_backfills (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        external_id TEXT UNIQUE,
        handoff TEXT CHECK (handoff IS NULL OR length(CAST(handoff AS BLOB)) <= 32768),
        handoff_at INTEGER,
        CHECK ((handoff IS NULL) = (handoff_at IS NULL))
      ) STRICT;
    `)
  },
}
