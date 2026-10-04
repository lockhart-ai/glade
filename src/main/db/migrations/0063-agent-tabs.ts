import type { Migration } from '../migrate'

/**
 * Remembers which agent's tab each task's Agents tab was on (P16, #536): the right panel's Agents tab has a tab for
 * every agent in the task, and a task comes back on the one you left it on, across tasks and relaunches.
 *
 * - `agent_tabs`: one row per task you left on a subagent's tab. `agent_id` is the `tool_use` id of the `Agent` call
 *   that started the subagent. A task without one is on Main, the task's own agent, where every task starts, so
 *   picking Main forgets the row. A row naming a subagent that's no longer in the task's log falls back to Main in the
 *   window.
 *
 * Nothing reads or writes it while the hidden `todoHubEnabled` setting is off. It goes with its task.
 */
export const agentTabsMigration: Migration = {
  version: 63,
  name: 'Remember which agent’s tab each task’s Agents tab was on',
  up(db) {
    db.exec(`
      CREATE TABLE agent_tabs (
        task_id TEXT PRIMARY KEY REFERENCES tasks (id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL CHECK (agent_id <> '')
      ) STRICT;
    `)
  },
}
