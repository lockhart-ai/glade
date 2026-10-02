import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { browseFoldersMigration } from './0050-browse-folders'

it('is migration 50, after every earlier one', () => {
  expect(browseFoldersMigration.version).toBe(50)
  expect(MIGRATIONS.indexOf(browseFoldersMigration)).toBe(MIGRATIONS.filter((m) => m.version < 50).length)
})

it('starts with no open folders, never the root, one row per folder, and drops them with their task', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 50),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  const count = (): unknown => db.prepare('SELECT COUNT(*) FROM browse_folders').pluck().get()
  expect(count()).toBe(0)
  db.prepare("INSERT INTO browse_folders VALUES ('t', 'api')").run()
  expect(() => db.prepare("INSERT INTO browse_folders VALUES ('t', 'api')").run()).toThrow(/UNIQUE/)
  expect(() => db.prepare("INSERT INTO browse_folders VALUES ('t', '')").run()).toThrow(/CHECK/)
  expect(() => db.prepare("INSERT INTO browse_folders VALUES ('nope', 'docs')").run()).toThrow(/FOREIGN KEY/)
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(count()).toBe(0)
  db.close()
})
