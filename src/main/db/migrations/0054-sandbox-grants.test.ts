import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { sampleTask, sampleWorkspace } from '../repositories/test-database'
import { MIGRATIONS } from '.'
import { sandboxGrantsMigration } from './0054-sandbox-grants'

it('is migration 54, after every earlier one', () => {
  expect(sandboxGrantsMigration.version).toBe(54)
  expect(MIGRATIONS.indexOf(sandboxGrantsMigration)).toBe(MIGRATIONS.filter((m) => m.version < 54).length)
})

/** Every table's rows, by table, to tell the migration left them alone: all but its own and the migrations' record. */
function everyRow(db: ReturnType<typeof openDatabase>): Record<string, unknown[]> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .pluck()
    .all()
    .filter((name): name is string => typeof name === 'string' && !['sandbox_grants', 'schema_version'].includes(name))
  return Object.fromEntries(tables.map((name) => [name, db.prepare(`SELECT * FROM "${name}"`).all()]))
}

it('runs on an existing database without touching its other tables, and starts with no grants', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 54),
  )
  const t1 = sampleTask(db, sampleWorkspace(db).id)
  db.prepare(
    "INSERT INTO task_permission_rules (task_id, tool_name, rule_content, created_at) VALUES (?, 'Bash', 'npm test *', 3)",
  ).run(t1.id)
  const before = everyRow(db)

  migrate(db, MIGRATIONS)

  expect(everyRow(db)).toEqual(before)
  expect(db.prepare('SELECT COUNT(*) FROM sandbox_grants').pluck().get()).toBe(0)
  db.close()
})

it('checks each grant’s scope, kind and access, keeps one row per folder or domain in a scope, and goes with its owner', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  const task = sampleTask(db, sampleWorkspace(db).id)
  const w1 = task.workspaceId
  const t1 = task.id
  const insert = (
    scope: string,
    workspaceId: string | null,
    taskId: string | null,
    kind: string,
    value: string,
    access: string | null,
  ) =>
    db
      .prepare(
        'INSERT INTO sandbox_grants (scope, workspace_id, task_id, kind, value, access, created_at) VALUES (?, ?, ?, ?, ?, ?, 5)',
      )
      .run(scope, workspaceId, taskId, kind, value, access)

  // The scope names its owner, and only its own.
  expect(() => insert('everywhere', null, null, 'domain', 'acme.dev', null)).toThrow(/CHECK/)
  expect(() => insert('glade', w1, null, 'domain', 'acme.dev', null)).toThrow(/CHECK/)
  expect(() => insert('workspace', null, null, 'domain', 'acme.dev', null)).toThrow(/CHECK/)
  expect(() => insert('workspace', w1, t1, 'domain', 'acme.dev', null)).toThrow(/CHECK/)
  expect(() => insert('task', null, null, 'domain', 'acme.dev', null)).toThrow(/CHECK/)
  expect(() => insert('task', w1, t1, 'domain', 'acme.dev', null)).toThrow(/CHECK/)
  expect(() => insert('task', null, 'nothing', 'domain', 'acme.dev', null)).toThrow(/FOREIGN KEY/)
  // A folder has an access, a domain none.
  expect(() => insert('glade', null, null, 'folder', '/opt/sdk', null)).toThrow(/CHECK/)
  expect(() => insert('glade', null, null, 'folder', '/opt/sdk', 'write')).toThrow(/CHECK/)
  expect(() => insert('glade', null, null, 'domain', 'acme.dev', 'read')).toThrow(/CHECK/)
  expect(() => insert('glade', null, null, 'socket', '/tmp/x', null)).toThrow(/CHECK/)
  expect(() => insert('glade', null, null, 'domain', '', null)).toThrow(/CHECK/)

  insert('glade', null, null, 'folder', '/opt/sdk', 'read')
  insert('workspace', w1, null, 'folder', '/opt/sdk', 'read_write')
  insert('task', null, t1, 'folder', '/opt/sdk', 'read')
  insert('task', null, t1, 'domain', '/opt/sdk', null)
  expect(() => insert('glade', null, null, 'folder', '/opt/sdk', 'read_write')).toThrow(/UNIQUE/)
  expect(() => insert('workspace', w1, null, 'folder', '/opt/sdk', 'read')).toThrow(/UNIQUE/)
  expect(() => insert('task', null, t1, 'domain', '/opt/sdk', null)).toThrow(/UNIQUE/)
  const count = (): unknown => db.prepare('SELECT COUNT(*) FROM sandbox_grants').pluck().get()
  expect(count()).toBe(4)

  db.prepare('DELETE FROM tasks WHERE id = ?').run(t1)
  expect(count()).toBe(2)
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(w1)
  expect(db.prepare('SELECT scope FROM sandbox_grants').pluck().all()).toEqual(['glade'])
  db.close()
})
