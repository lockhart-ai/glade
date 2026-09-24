import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listQueuedMessages } from '../repositories/queued-messages'
import { MIGRATIONS } from '.'
import { messageQueueMigration } from './0007-message-queue'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 7', () => {
  expect(MIGRATIONS[6]).toBe(messageQueueMigration)
})

it('starts every existing task with an empty queue, dropped with its task', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 6))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'working', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()

  migrate(db, MIGRATIONS)

  expect(listQueuedMessages(db, 't')).toEqual([])
  db.prepare("INSERT INTO queued_messages VALUES ('q', 't', 1, 'Keep the filenames.', 2)").run()
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM queued_messages').pluck().get()).toBe(0)
  db.close()
})
