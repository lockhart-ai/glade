import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { stoppedWorkNoteMigration } from './0077-stopped-work-note'

function sampleTask(db: Database, id: string): void {
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      `VALUES ('${id}', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)`,
  ).run()
}

it('is migration 77', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 77)).toBe(stoppedWorkNoteMigration)
  expect(MIGRATIONS.at(-1)?.version).toBe(77)
})

it('adds a stopped-work-notes table that starts empty', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  expect(db.prepare('SELECT COUNT(*) FROM stopped_work_notes').pluck().get()).toBe(0)
  db.close()
})

it('keeps one note per task, and deletes it with the task', () => {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  sampleTask(db, 't1')
  sampleTask(db, 't2')
  db.prepare(
    "INSERT INTO stopped_work_notes (task_id, note, updated_at) VALUES ('t1', 'Glade stopped the work.', 1)",
  ).run()
  db.prepare(
    "INSERT INTO stopped_work_notes (task_id, note, updated_at) VALUES ('t2', 'Glade stopped the other work.', 2)",
  ).run()

  db.prepare("DELETE FROM tasks WHERE id = 't1'").run()

  expect(db.prepare('SELECT task_id FROM stopped_work_notes ORDER BY task_id').all()).toEqual([{ task_id: 't2' }])
  db.close()
})
