import type { Migration } from '../migrate'

/**
 * Adds an agent call's context size to its `tool_events` row, for its line on the Agents tab (#592): how full the
 * conversation of the agent it started was at its latest request, as the SDK reports it — not what it has spent. The
 * progress and end of a native subagent's run write it, and so does its foreground result, whose figure is exact; a
 * dispatched child's split (`total_input_tokens` and `total_output_tokens`, #589) is a real total, and the line
 * prefers it. A call nobody has written has it null, which the line reads as nothing to show.
 */
export const agentCallContextTokensMigration: Migration = {
  version: 71,
  name: 'Add the agent call context size',
  up(db) {
    db.exec('ALTER TABLE tool_events ADD COLUMN context_tokens INTEGER')
  },
}
