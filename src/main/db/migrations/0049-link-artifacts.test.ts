import { expect, it } from 'vitest'
import { ArtifactFilter, ArtifactKind } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { addLinkArtifact, getArtifactFilter, listArtifacts } from '../repositories/artifacts'
import { MIGRATIONS } from '.'
import { linkArtifactsMigration } from './0049-link-artifacts'

it('is migration 49', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 49)).toBe(linkArtifactsMigration)
})

it('keeps every artifact as a file, in its order and with what was seen of it, and adds links and the filter', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 49),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  // Declared at the same moment, so only their rowids order them: the later one first in the table.
  db.prepare("INSERT INTO artifacts VALUES ('t', 'out/landing.png', 'Landing page', 5, 6, 9, 1)").run()
  db.prepare("INSERT INTO artifacts VALUES ('t', 'docs/notes.md', 'Notes', 5, 5, NULL, 0)").run()

  migrate(db, MIGRATIONS)

  expect(listArtifacts(db, 't')).toEqual([
    {
      kind: ArtifactKind.File,
      taskId: 't',
      path: 'out/landing.png',
      title: 'Landing page',
      addedAt: 5,
      updatedAt: 6,
      modifiedAt: 9,
      missing: true,
    },
    {
      kind: ArtifactKind.File,
      taskId: 't',
      path: 'docs/notes.md',
      title: 'Notes',
      addedAt: 5,
      updatedAt: 5,
      modifiedAt: null,
      missing: false,
    },
  ])
  addLinkArtifact(db, { taskId: 't', url: 'https://github.com/acme/api/pull/412', title: '#412' }, 7)
  expect(listArtifacts(db, 't').map(({ kind }) => kind)).toEqual([
    ArtifactKind.File,
    ArtifactKind.File,
    ArtifactKind.Link,
  ])
  expect(getArtifactFilter(db, 't')).toBe(ArtifactFilter.All)
  db.prepare("INSERT INTO artifact_filters VALUES ('t', 'links')").run()
  expect(getArtifactFilter(db, 't')).toBe(ArtifactFilter.Links)

  // They all go with their task.
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM artifacts').pluck().get()).toBe(0)
  expect(db.prepare('SELECT COUNT(*) FROM artifact_filters').pluck().get()).toBe(0)
  expect(db.pragma('foreign_key_check')).toEqual([])
  db.close()
})
