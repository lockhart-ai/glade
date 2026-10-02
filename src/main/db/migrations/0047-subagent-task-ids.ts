import type { Migration } from '../migrate'

/**
 * Remembers the SDK's id for each subagent (#395): its `Agent` (or `Task`) call keeps the task id its `task_started`
 * named (`task_id`, the subagent's `agentId`), so a subagent woken again later, by the agent's `SendMessage` or by the
 * SDK itself, is found by that id and runs again in its own row, after a relaunch too (`docs/sdk-notes.md`, "Subagents
 * woken again"). Only a tool call has one; calls logged before this have none.
 */
export const subagentTaskIdsMigration: Migration = {
  version: 47,
  name: "Keep each subagent's SDK task id",
  up(db) {
    db.exec(`
      ALTER TABLE tool_events ADD COLUMN sdk_task_id TEXT
        CHECK (sdk_task_id IS NULL OR kind = 'tool_call');
    `)
  },
}
