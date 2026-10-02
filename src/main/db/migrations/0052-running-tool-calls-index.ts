import type { Migration } from '../migrate'

/**
 * Indexes the tool calls that are still running, by task (#430). Every task is now read with whether it has background
 * work running (`Task.backgroundWork`): a subagent's call still running in its tool log. Without the index, reading the
 * task list would walk every task's whole log to find out; with it, only the handful of calls running now.
 */
export const runningToolCallsIndexMigration: Migration = {
  version: 52,
  name: 'Index the tool calls still running, for reading whether a task has background work',
  up(db) {
    db.exec(`
      CREATE INDEX tool_events_running ON tool_events (task_id)
      WHERE kind = 'tool_call' AND tool_state = 'running';
    `)
  },
}
