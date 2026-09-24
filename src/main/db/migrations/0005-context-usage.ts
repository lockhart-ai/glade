import type { Migration } from '../migrate'

/**
 * Adds how full each task's context is, for the context meter: the tokens used, and the window the SDK reported for the
 * task's model. Existing tasks start at 0 used and with no reported window, which the tasks repository reads as the
 * size its model's id gives (`src/shared/contextWindow.ts`).
 */
export const contextUsageMigration: Migration = {
  version: 5,
  name: 'Add the task context usage',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN context_used_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN context_window_tokens INTEGER;
    `)
  },
}
