import { expect, it } from 'vitest'
import { FolderAccess, SandboxGrantKind, SandboxGrantScope } from '../../../shared/sandbox'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { addSandboxGrant, listSandboxGrants } from '../repositories/sandbox-grants'
import { MIGRATIONS } from '.'
import { sandboxFileGrantsMigration } from './0057-sandbox-file-grants'

it('is migration 57, after every earlier one', () => {
  expect(sandboxFileGrantsMigration.version).toBe(57)
  expect(MIGRATIONS.indexOf(sandboxFileGrantsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 57).length)
})

it('leaves every existing grant a folder’s, and keeps a single file’s apart from then on', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 57),
  )
  db.prepare(
    `INSERT INTO sandbox_grants (scope, workspace_id, task_id, kind, value, access, created_at)
    VALUES ('glade', NULL, NULL, 'folder', '/Users/me/code/acme-web', 'read', 1),
      ('glade', NULL, NULL, 'domain', 'registry.npmjs.org', NULL, 2)`,
  ).run()

  migrate(db, MIGRATIONS)

  const target = { scope: SandboxGrantScope.Glade } as const
  const folder = { kind: SandboxGrantKind.Folder, path: '/Users/me/code/acme-web', access: FolderAccess.Read } as const
  const domain = { kind: SandboxGrantKind.Domain, domain: 'registry.npmjs.org' } as const
  expect(listSandboxGrants(db, target).map(({ grant }) => grant)).toEqual([folder, domain])

  const file = { ...folder, path: '/Users/me/.gitconfig', file: true } as const
  addSandboxGrant(db, { target, grant: file }, 3)
  expect(listSandboxGrants(db, target).map(({ grant }) => grant)).toEqual([folder, domain, file])

  // Only a folder's row can be a single file's, and only as 0 or 1.
  const flag = db.prepare('UPDATE sandbox_grants SET is_file = ? WHERE kind = ?')
  expect(() => flag.run(1, 'domain')).toThrow(/CHECK/)
  expect(() => flag.run(2, 'folder')).toThrow(/CHECK/)
  db.close()
})
