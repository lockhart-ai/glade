import type { Migration } from '../migrate'

/**
 * Remembers the context window the SDK last reported for each model (#416), by every id the model went by in that
 * session: the `modelUsage` key, the model `system/init` named, and the task's own id (an alias like `opus`). Some
 * models run at 1M without a `[1m]` suffix (Opus 5.5 does), and nothing in the SDK's model list says so, so a task that
 * moves to a model, or a new task on one, starts from the window that model was last seen with rather than the 200k
 * the id alone gives (`guessContextWindow`, `docs/sdk-notes.md`, "Usage and context size"). Empty until a session
 * reports one.
 */
export const reportedContextWindowsMigration: Migration = {
  version: 51,
  name: 'Remember the context window the SDK reported for each model',
  up(db) {
    db.exec(`
      CREATE TABLE reported_context_windows (
        model TEXT PRIMARY KEY,
        window_tokens INTEGER NOT NULL CHECK (window_tokens > 0),
        reported_at INTEGER NOT NULL
      ) STRICT;
    `)
  },
}
