import { expect, it } from 'vitest'
import { ArtifactDateGroup } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listArtifactGroups, setArtifactGroupOpen } from '../repositories/artifact-groups'
import { listArtifacts } from '../repositories/artifacts'
import { MIGRATIONS } from '.'
import { artifactGroupsMigration } from './0041-artifact-groups'

it('is migration 41', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 41)).toBe(artifactGroupsMigration)
})

it('leaves existing artifacts unlooked at, starts each task’s groups as they start, and drops them with it', () => {
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

  migrate(db, MIGRATIONS)

  // Its artifacts haven't been looked at since: no time yet, and not missing.
  expect(listArtifacts(db, 't')).toEqual([
    { taskId: 't', path: 'docs/notes.md', title: 'Notes', addedAt: 5, updatedAt: 6, modifiedAt: null, missing: false },
  ])
  expect(() => db.prepare("UPDATE artifacts SET missing = 2 WHERE task_id = 't'").run()).toThrow(/CHECK/)
  expect(listArtifactGroups(db, 't')).toEqual([])
  setArtifactGroupOpen(db, { taskId: 't', group: ArtifactDateGroup.ThisWeek, open: true })
  expect(() => db.prepare("INSERT INTO artifact_groups VALUES ('t', 'this_week', 0)").run()).toThrow(/UNIQUE/)
  expect(() => db.prepare("INSERT INTO artifact_groups VALUES ('t', 'older', 2)").run()).toThrow(/CHECK/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM artifact_groups').pluck().get()).toBe(0)
  db.close()
})
