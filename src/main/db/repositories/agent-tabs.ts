import type { Database } from 'better-sqlite3'
import { Row } from './rows'

// Which agent's tab each task's Agents tab was on (P16, #536): a subagent's, by the `tool_use` id of the `Agent` call
// that started it, or Main, the task's own agent, which is where every task starts and is kept as no row at all.

/** The subagent whose tab a task's Agents tab was left on, by its `Agent` call's `tool_use` id; null for Main. */
export function getAgentTab(db: Database, taskId: string): string | null {
  const raw: unknown = db.prepare('SELECT agent_id FROM agent_tabs WHERE task_id = ?').get(taskId)
  return raw === undefined ? null : new Row('agent_tabs', raw).text('agent_id')
}

/** Remembers the agent's tab a task's Agents tab is on: null is Main, which forgets it, since that's where it starts. */
export function setAgentTab(db: Database, taskId: string, agentId: string | null): void {
  if (agentId === null) {
    db.prepare('DELETE FROM agent_tabs WHERE task_id = ?').run(taskId)
    return
  }
  db.prepare(
    `INSERT INTO agent_tabs (task_id, agent_id) VALUES (?, ?)
    ON CONFLICT (task_id) DO UPDATE SET agent_id = excluded.agent_id`,
  ).run(taskId, agentId)
}
