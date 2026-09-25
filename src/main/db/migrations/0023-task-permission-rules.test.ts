import { expect, it } from 'vitest'
import { PermissionRequestState } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listPermissionRequests } from '../repositories/permission-requests'
import { listTaskPermissionRules } from '../repositories/task-permission-rules'
import { MIGRATIONS } from '.'
import { taskPermissionRulesMigration } from './0023-task-permission-rules'

it('is migration 23', () => {
  expect(MIGRATIONS[22]).toBe(taskPermissionRulesMigration)
})

it('gives existing tasks no rules and existing requests no granted rule, drops rules with their task, and checks the columns', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 22))
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
    VALUES ('r', 't', 1, 'toolu_1', 'Bash', '{"command":"npm test"}', '[]', 0, 0, 'allowed', 2, 3)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listTaskPermissionRules(db, 't')).toEqual([])
  expect(listPermissionRequests(db, 't')).toEqual([
    expect.objectContaining({ id: 'r', state: PermissionRequestState.Allowed, grantedRule: null }),
  ])
  const insert = db.prepare('INSERT INTO task_permission_rules VALUES (?, ?, ?, 4)')
  expect(() => insert.run('t', '', null)).toThrow(/CHECK/)
  expect(() => insert.run('t', 'Bash', '')).toThrow(/CHECK/)
  expect(() => insert.run('missing', 'Edit', null)).toThrow(/FOREIGN KEY/)
  insert.run('t', 'Edit', null)
  expect(() => insert.run('t', 'Edit', null)).toThrow(/UNIQUE/)
  insert.run('t', 'Bash', 'npm test *')
  expect(() => db.prepare("UPDATE permission_requests SET granted_rule = 'nope'").run()).toThrow(/CHECK/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM task_permission_rules').pluck().get()).toBe(0)
  db.close()
})
