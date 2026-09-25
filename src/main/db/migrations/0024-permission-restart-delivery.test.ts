import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { permissionRestartDeliveryMigration } from './0024-permission-restart-delivery'

it('is migration 24', () => {
  expect(MIGRATIONS[23]).toBe(permissionRestartDeliveryMigration)
})

it('leaves existing requests with nothing to deliver, and checks the column', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 23))
  db.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at) VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)",
  ).run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id, permission_mode)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL,
      'ask_before_edits')`,
  ).run()
  db.prepare(
    `INSERT INTO permission_requests (id, task_id, turn, tool_use_id, tool_name, input, suggestions, default_to_no,
      suppress_always_allow_rule, state, created_at, closed_at)
    VALUES ('r', 't', 1, 'toolu_1', 'Bash', '{"command":"npm test"}', '[]', 0, 0, 'open', 2, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  const delivery = db.prepare("SELECT restart_delivery FROM permission_requests WHERE id = 'r'").pluck()
  expect(delivery.get()).toBeNull()
  const set = db.prepare("UPDATE permission_requests SET restart_delivery = ? WHERE id = 'r'")
  for (const value of ['pending', 'delivered', 'settled']) {
    set.run(value)
    expect(delivery.get()).toBe(value)
  }
  expect(() => set.run('nope')).toThrow(/CHECK/)
  db.close()
})
