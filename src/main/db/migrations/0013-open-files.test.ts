import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getOpenFiles } from '../repositories/open-files'
import { MIGRATIONS } from '.'
import { openFilesMigration } from './0013-open-files'

it('is migration 13', () => {
  expect(MIGRATIONS[12]).toBe(openFilesMigration)
})

it('starts every existing task with no files open, dropped with its task, and checks the paths are an array', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 12))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(getOpenFiles(db, 't')).toEqual({ taskId: 't', paths: [], activePath: null })
  const insert = db.prepare("INSERT INTO open_files VALUES ('t', ?, NULL)")
  expect(() => insert.run('{}')).toThrow(/CHECK/)
  insert.run('["README.md"]')
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM open_files').pluck().get()).toBe(0)
  db.close()
})
