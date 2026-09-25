import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { importedSessionsMigration } from './0026-imported-sessions'

it('is migration 26', () => {
  expect(MIGRATIONS[25]).toBe(importedSessionsMigration)
})

/** A database at the schema before this migration, with one workspace. */
function before(): Database {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 25))
  db.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at) VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)",
  ).run()
  return db
}

function insertTask(db: Database, id: string, sessionId: string | null, createdAt = 1): void {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id, permission_mode)
    VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', ?, 1, NULL, ?, 'allow_all')`,
  ).run(id, createdAt, sessionId)
}

function sessionOf(db: Database, id: string): unknown {
  return db.prepare('SELECT session_id FROM tasks WHERE id = ?').pluck().get(id)
}

it('leaves existing tasks not imported, and lets one session belong to one task only', () => {
  const db = before()
  insertTask(db, 'a', 'session-1')
  insertTask(db, 'b', null)

  migrate(db, MIGRATIONS)

  expect(db.prepare('SELECT imported_at FROM tasks ORDER BY id').pluck().all()).toEqual([null, null])
  expect(sessionOf(db, 'a')).toBe('session-1')
  // Any number of tasks may have no session yet.
  insertTask(db, 'c', null)
  expect(() => insertTask(db, 'd', 'session-1')).toThrow(/UNIQUE/)
  db.prepare("UPDATE tasks SET imported_at = 5 WHERE id = 'c'").run()
  expect(db.prepare("SELECT imported_at FROM tasks WHERE id = 'c'").pluck().get()).toBe(5)
  db.close()
})

it('keeps a shared session with the oldest task, and clears it from the others', () => {
  const db = before()
  insertTask(db, 'newer', 'shared', 3)
  insertTask(db, 'z-tie', 'shared', 1)
  insertTask(db, 'a-tie', 'shared', 1)
  insertTask(db, 'own', 'own-session', 2)

  migrate(db, MIGRATIONS)

  expect(sessionOf(db, 'a-tie')).toBe('shared')
  expect(sessionOf(db, 'z-tie')).toBeNull()
  expect(sessionOf(db, 'newer')).toBeNull()
  expect(sessionOf(db, 'own')).toBe('own-session')
  db.close()
})
