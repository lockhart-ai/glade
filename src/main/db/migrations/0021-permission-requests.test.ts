import { expect, it } from 'vitest'
import { PermissionMode } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listPermissionRequests } from '../repositories/permission-requests'
import { getTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { permissionRequestsMigration } from './0021-permission-requests'

it('is migration 21', () => {
  expect(MIGRATIONS[20]).toBe(permissionRequestsMigration)
})

it('keeps every existing task at Allow all with no requests, drops requests with their task, and checks the columns', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 20))
  db.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at) VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)",
  ).run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(getTask(db, 't')).toMatchObject({ permissionMode: PermissionMode.AllowAll, awaitingPermission: false })
  expect(listPermissionRequests(db, 't')).toEqual([])
  expect(() => db.prepare("UPDATE tasks SET permission_mode = 'ask_sometimes' WHERE id = 't'").run()).toThrow(/CHECK/)
  const insert = db.prepare(
    `INSERT INTO permission_requests (id, task_id, turn, tool_use_id, tool_name, input, suggestions, default_to_no,
      suppress_always_allow_rule, state, created_at) VALUES (?, 't', 1, 'toolu_1', 'Bash', ?, ?, 0, 0, ?, 2)`,
  )
  expect(() => insert.run('a', '[]', '[]', 'open')).toThrow(/CHECK/)
  expect(() => insert.run('b', '{}', '{}', 'open')).toThrow(/CHECK/)
  expect(() => insert.run('c', '{}', '[]', 'maybe')).toThrow(/CHECK/)
  insert.run('d', '{"command":"npm test"}', '[]', 'open')
  expect(getTask(db, 't')?.awaitingPermission).toBe(true)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM permission_requests').pluck().get()).toBe(0)
  db.close()
})
