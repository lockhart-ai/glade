import type { Migration } from '../migrate'

/**
 * Adds an agent call's running token totals to its `tool_events` row, for its line on the Agents tab (#589): what the
 * agent it started has spent in total, in and out. The dispatched child that a `dispatch` call starts is the only
 * writer so far; a call nobody has written has them null, which the line reads as nothing to show.
 */
export const agentCallTokenTotalsMigration: Migration = {
  version: 70,
  name: 'Add the agent call token totals',
  up(db) {
    db.exec(`
      ALTER TABLE tool_events ADD COLUMN total_input_tokens INTEGER;
      ALTER TABLE tool_events ADD COLUMN total_output_tokens INTEGER;
    `)
  },
}
