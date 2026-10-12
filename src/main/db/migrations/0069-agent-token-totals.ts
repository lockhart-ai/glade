import type { Migration } from '../migrate'

/**
 * Adds Main's running token totals to each task, for its line on the Agents tab (#587): what its turns have spent in
 * total, in and out, subagents left out. Existing tasks start at 0, which the line reads as nothing to show.
 */
export const agentTokenTotalsMigration: Migration = {
  version: 69,
  name: 'Add the task token totals',
  up(db) {
    db.exec(`
      ALTER TABLE tasks ADD COLUMN total_input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE tasks ADD COLUMN total_output_tokens INTEGER NOT NULL DEFAULT 0;
    `)
  },
}
