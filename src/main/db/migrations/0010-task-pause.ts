import type { Migration } from '../migrate'

/**
 * Adds the paused activity (`TaskActivity.Paused` in `src/shared/domain.ts`) and each task's pause (`TaskPause`): why
 * its turn is paused and when it resumes, a JSON object, or null when it isn't paused. SQLite can't change the
 * activity's CHECK constraint, so the table is rebuilt: copied into a new one with the new value and column, then
 * swapped in, with foreign keys off (`rebuildsReferencedTable`), since messages, tool events and queued messages
 * reference it. Existing tasks aren't paused.
 */
export const taskPauseMigration: Migration = {
  version: 10,
  name: 'Add the paused activity and the task pause',
  rebuildsReferencedTable: true,
  up(db) {
    db.exec(`
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('active', 'done')),
        pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
        unread INTEGER NOT NULL CHECK (unread IN (0, 1)),
        model TEXT NOT NULL,
        effort TEXT NOT NULL CHECK (effort IN ('low', 'medium', 'high', 'max')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        done_at INTEGER,
        session_id TEXT,
        activity TEXT NOT NULL DEFAULT 'waiting' CHECK (activity IN ('waiting', 'working', 'error', 'paused')),
        status_updated_at INTEGER,
        context_used_tokens INTEGER NOT NULL DEFAULT 0,
        context_window_tokens INTEGER,
        error TEXT CHECK (error IS NULL OR (json_valid(error) AND json_type(error) = 'object')),
        retrying TEXT CHECK (retrying IS NULL OR (json_valid(retrying) AND json_type(retrying) = 'object')),
        pause TEXT CHECK (pause IS NULL OR (json_valid(pause) AND json_type(pause) = 'object')),
        -- A task has a done time exactly when it's done.
        CHECK ((state = 'done') = (done_at IS NOT NULL))
      ) STRICT;

      INSERT INTO tasks_new (id, workspace_id, title, objective, status, state, pinned, unread, model, effort,
        created_at, updated_at, done_at, session_id, activity, status_updated_at, context_used_tokens,
        context_window_tokens, error, retrying)
      SELECT id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at,
        done_at, session_id, activity, status_updated_at, context_used_tokens, context_window_tokens, error, retrying
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
      CREATE INDEX tasks_by_workspace ON tasks (workspace_id, updated_at);
    `)
  },
}
