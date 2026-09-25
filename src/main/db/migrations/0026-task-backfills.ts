import type { Migration } from '../migrate'

/**
 * Adds what backfilling past tasks through the control API needs (`docs/control-api.md`, "Backfilling past tasks").
 *
 * `task_backfills`, one row per task that has either of these:
 *
 * - `external_id`: the caller's own id for the task (e.g. the notes folder it came from), unique across tasks, so a
 *   backfill run again finds the task it made rather than making another.
 * - `handoff`: the task's handoff note, Markdown, at most 32 KB of UTF-8, and `handoff_at`, when it was last set, which
 *   is its version. The chat shows it on the Backfilled card, and its agent is given it.
 *
 * `session_context`, what the task's agent session has been given of what Glade tells it (`../../agent/session-context`):
 * `instructions`, whether it has Glade's system prompt append, and `handoff_at`, the version of the handoff note it
 * has (null for none). Claude Code keeps a session's system prompt when it resumes it, so what a session started
 * without, or what changed since it started, goes to it once, ahead of the next message. A task with no row has what
 * its session started with: Glade started it.
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

      CREATE TABLE session_context (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        instructions INTEGER NOT NULL CHECK (instructions IN (0, 1)),
        handoff_at INTEGER
      ) STRICT;
    `)
  },
}
