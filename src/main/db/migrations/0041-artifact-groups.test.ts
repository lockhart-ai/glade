import { expect, it } from 'vitest'
import { ArtifactKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listArtifacts } from '../repositories/artifacts'
import { MIGRATIONS } from '.'
import { artifactGroupsMigration } from './0041-artifact-groups'

it('is migration 41', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 41)).toBe(artifactGroupsMigration)
})

it('leaves existing artifacts unlooked at, and keeps one fold per date group of a task', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 41),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare("INSERT INTO artifacts VALUES ('t', 'docs/notes.md', 'Notes', 5, 6)").run()

  // Up to this migration: its table is dropped again once the Artifacts tab is gone (0064).
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 41),
  )
  expect(db.prepare('SELECT COUNT(*) FROM artifact_groups').pluck().get()).toBe(0)
  db.prepare("INSERT INTO artifact_groups VALUES ('t', 'this_week', 1)").run()
  expect(() => db.prepare("INSERT INTO artifact_groups VALUES ('t', 'this_week', 0)").run()).toThrow(/UNIQUE/)
  expect(() => db.prepare("INSERT INTO artifact_groups VALUES ('t', 'older', 2)").run()).toThrow(/CHECK/)

  migrate(db, MIGRATIONS)

  // Its artifacts haven't been looked at since: no time yet, and not missing.
  expect(listArtifacts(db, 't')).toEqual([
    {
      kind: ArtifactKind.File,
      taskId: 't',
      path: 'docs/notes.md',
      title: 'Notes',
      addedAt: 5,
      updatedAt: 6,
      modifiedAt: null,
      missing: false,
    },
  ])
  expect(() => db.prepare("UPDATE artifacts SET missing = 2 WHERE task_id = 't'").run()).toThrow(/CHECK/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM artifacts').pluck().get()).toBe(0)
  db.close()
})
