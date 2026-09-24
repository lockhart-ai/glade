import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { TaskActivity } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { taskActivityMigration } from './0003-task-activity'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 3', () => {
  expect(MIGRATIONS[2]).toBe(taskActivityMigration)
})

it('gives existing tasks the waiting activity, and checks the column', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 2))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at,
      updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(getTask(db, 't')?.activity).toBe(TaskActivity.Waiting)
  expect(() => db.prepare("UPDATE tasks SET activity = 'sleeping'").run()).toThrow('CHECK constraint failed')
  db.close()
})
