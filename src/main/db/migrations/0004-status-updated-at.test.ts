import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { getTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { statusUpdatedAtMigration } from './0004-status-updated-at'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 4', () => {
  expect(MIGRATIONS[3]).toBe(statusUpdatedAtMigration)
})

it('dates existing statuses from their last update, and leaves empty ones unset', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 3))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  const insert = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES (?, 'w', '', '', ?, 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, ?, NULL, NULL)`,
  )
  insert.run('with-status', 'Tests pass.', 500)
  insert.run('without-status', '', 600)

  migrate(db, MIGRATIONS)

  expect(getTask(db, 'with-status')?.statusUpdatedAt).toBe(500)
  expect(getTask(db, 'without-status')?.statusUpdatedAt).toBeNull()
  db.close()
})
