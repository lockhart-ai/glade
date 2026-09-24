import type { Migration } from '../migrate'

/**
 * Adds each agent reply's turn summary (`TurnSummary` in `src/shared/domain.ts`): how long the turn ran, and the files
 * and lines its edits changed. A reply has a summary exactly when `files_changed` is set; the duration can be missing
 * on its own, when the SDK didn't report one. Existing messages have none, so the chat shows no summary for them.
 */
export const turnSummaryMigration: Migration = {
  version: 6,
  name: 'Add the turn summary to agent replies',
  up(db) {
    db.exec(`
      ALTER TABLE messages ADD COLUMN duration_ms INTEGER CHECK (duration_ms >= 0);
      ALTER TABLE messages ADD COLUMN files_changed INTEGER CHECK (files_changed >= 0);
      ALTER TABLE messages ADD COLUMN lines_added INTEGER CHECK (lines_added >= 0);
      ALTER TABLE messages ADD COLUMN lines_removed INTEGER CHECK (lines_removed >= 0);
    `)
  },
}
