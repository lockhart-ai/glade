import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { agentTokenTotalsMigration } from './0069-agent-token-totals'

it('adds the token totals to tasks, starting every task at zero', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 69),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  expect(agentTokenTotalsMigration.version).toBe(69)
  migrate(db, MIGRATIONS)
  expect(db.prepare('SELECT total_input_tokens, total_output_tokens FROM tasks WHERE id = ?').get('t1')).toEqual({
    total_input_tokens: 0,
    total_output_tokens: 0,
  })
})
