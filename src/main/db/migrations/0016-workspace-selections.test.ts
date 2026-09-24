import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getWorkspaceSelection } from '../repositories/workspace-selections'
import { MIGRATIONS } from '.'
import { workspaceSelectionsMigration } from './0016-workspace-selections'

it('is migration 16', () => {
  expect(MIGRATIONS[15]).toBe(workspaceSelectionsMigration)
})

it('starts every workspace with no selection, keeps one per workspace, and drops it with its task or workspace', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 15))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  )
  insertTask.run('t')
  insertTask.run('u')

  migrate(db, MIGRATIONS)

  expect(getWorkspaceSelection(db, 'w')).toBeUndefined()
  const insert = db.prepare("INSERT INTO workspace_selections VALUES ('w', ?)")
  insert.run('t')
  expect(() => insert.run('u')).toThrow(/UNIQUE/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM workspace_selections').pluck().get()).toBe(0)
  insert.run('u')
  db.prepare("DELETE FROM workspaces WHERE id = 'w'").run()
  expect(db.prepare('SELECT COUNT(*) FROM workspace_selections').pluck().get()).toBe(0)
  db.close()
})
