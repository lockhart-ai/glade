import type { Migration } from '../migrate'

export const agentTokensMigration: Migration = {
  version: 69,
  name: 'Keep the token totals each agent tab shows',
  up(db) {
    // One row per agent of a task: Main's own messages (agent_id '') and each subagent's (its `Agent` call's
    // tool_use id). The runner adds every assistant message's tokens in, so the totals survive a relaunch (#566).
    db.exec(`
      CREATE TABLE agent_token_totals (
        task_id TEXT NOT NULL REFERENCES tasks (id) ON DELETE CASCADE,
        agent_id TEXT NOT NULL,
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        PRIMARY KEY (task_id, agent_id)
      ) STRICT;
    `)
  },
}
