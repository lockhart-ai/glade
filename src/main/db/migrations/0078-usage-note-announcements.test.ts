import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { usageNoteAnnouncementsMigration } from './0078-usage-note-announcements'

function sampleTask(db: Database, id: string): void {
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      `VALUES ('${id}', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)`,
  ).run()
}

it('is migration 78', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 78)).toBe(usageNoteAnnouncementsMigration)
})

it('adds a usage-note-announcements table that starts empty', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  expect(db.prepare('SELECT COUNT(*) FROM usage_note_announcements').pluck().get()).toBe(0)
  db.close()
})

it('keeps one row per task, and deletes it with the task', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  sampleTask(db, 't1')
  sampleTask(db, 't2')
  db.prepare(
    "INSERT INTO usage_note_announcements (task_id, session, week, open_router, updated_at) VALUES ('t1', 0.41, NULL, NULL, 1)",
  ).run()
  db.prepare(
    "INSERT INTO usage_note_announcements (task_id, session, week, open_router, updated_at) VALUES ('t2', NULL, 0.7, 12.5, 2)",
  ).run()

  db.prepare("DELETE FROM tasks WHERE id = 't1'").run()

  expect(db.prepare('SELECT task_id FROM usage_note_announcements ORDER BY task_id').all()).toEqual([{ task_id: 't2' }])
  db.close()
})
