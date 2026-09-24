import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { taskErrorMigration } from './0008-task-error'

it('is migration 8', () => {
  expect(MIGRATIONS[7]).toBe(taskErrorMigration)
})

it('gives existing tasks no error and no retry', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 7))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'error', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(getTask(db, 't')).toMatchObject({ error: null, retrying: null })
  expect(() => db.prepare("UPDATE tasks SET error = '[1]' WHERE id = 't'").run()).toThrow(/CHECK/)
  expect(() => db.prepare("UPDATE tasks SET retrying = 'nope' WHERE id = 't'").run()).toThrow(/CHECK/)
  db.close()
})
