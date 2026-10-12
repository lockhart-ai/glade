import type { Migration } from '../migrate'

/**
 * Adds an agent call's combined token total to its `tool_events` row, for its line on the Agents tab (#592): what the
 * agent it started has spent in all, while it runs. The progress and end of a native subagent's run write it; a
 * foreground run's split (`total_input_tokens` and `total_output_tokens`, #589) is the finer figure once it exists,
 * and the line prefers it. A call nobody has written has it null, which the line reads as nothing to show.
 */
export const agentCallTotalTokensMigration: Migration = {
  version: 71,
  name: 'Add the agent call combined token total',
  up(db) {
    db.exec('ALTER TABLE tool_events ADD COLUMN total_tokens INTEGER')
  },
}
