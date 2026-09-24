import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listArtifacts } from '../repositories/artifacts'
import { MIGRATIONS } from '.'
import { artifactsMigration } from './0015-artifacts'

it('is migration 15', () => {
  expect(MIGRATIONS[14]).toBe(artifactsMigration)
})

it('starts every existing task with no artifacts, keeps one per path, and drops them with their task', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 14))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listArtifacts(db, 't')).toEqual([])
  const insert = db.prepare("INSERT INTO artifacts VALUES ('t', 'docs/notes.md', 'Notes', 1, 1)")
  insert.run()
  expect(() => insert.run()).toThrow(/UNIQUE/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM artifacts').pluck().get()).toBe(0)
  db.close()
})
