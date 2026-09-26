import type { Migration } from '../migrate'

/**
 * Lets a running subagent say what it's doing now, for the Subagents tab: its `Agent` call keeps the latest one-line
 * summary the SDK sent for it (`task_progress.summary`, with `agentProgressSummaries` on; `docs/sdk-notes.md`,
 * "Subagents"), until it finishes. Only a tool call has one.
 */
export const subagentProgressMigration: Migration = {
  version: 31,
  name: "Keep each running subagent's latest progress summary",
  up(db) {
    db.exec(`
      ALTER TABLE tool_events ADD COLUMN progress_summary TEXT
        CHECK (progress_summary IS NULL OR kind = 'tool_call');
    `)
  },
}
