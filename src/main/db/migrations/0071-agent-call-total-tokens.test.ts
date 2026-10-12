import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { agentCallTotalTokensMigration } from './0071-agent-call-total-tokens'

it('adds the agent call combined token total to tool events, leaving every row without it', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 71),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  db.prepare(
    'INSERT INTO tool_events (seq, id, task_id, kind, turn, created_at, tool_name, tool_input, tool_state, tool_use_id) ' +
      "VALUES (1, 'c1', 't1', 'tool_call', 1, 1, 'Agent', '{}', 'running', 'call-1')",
  ).run()
  expect(agentCallTotalTokensMigration.version).toBe(71)
  migrate(db, MIGRATIONS)
  expect(db.prepare('SELECT total_tokens FROM tool_events WHERE id = ?').get('c1')).toEqual({ total_tokens: null })
})
