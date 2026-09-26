import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { notificationsMigration } from './0031-notifications'

let db: Database

/** A database at the schema before this migration, with a task, migrated to the latest. */
beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 30))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id, permission_mode)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL, 'allow_all')`,
  ).run()
  migrate(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
})

function insert(taskId: string): void {
  db.prepare(
    "INSERT INTO notifications (task_id, title, body, sent_at) VALUES (?, 'Add rate limiting', 'Done.', 5)",
  ).run(taskId)
}

it('is migration 31', () => {
  expect(MIGRATIONS[30]).toBe(notificationsMigration)
})

it('starts with no notifications, numbering each one after the last', () => {
  expect(db.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0)
  insert('t')
  insert('t')
  expect(db.prepare('SELECT seq FROM notifications ORDER BY seq').pluck().all()).toEqual([1, 2])
})

it('keeps a notification with its task, and drops it with its task', () => {
  expect(() => {
    insert('nope')
  }).toThrow(/FOREIGN KEY/)
  insert('t')
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM notifications').pluck().get()).toBe(0)
})
