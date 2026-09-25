import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listMessages } from '../repositories/messages'
import { MIGRATIONS } from '.'
import { turnSummaryMigration } from './0006-turn-summary'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

it('is migration 6', () => {
  expect(MIGRATIONS[5]).toBe(turnSummaryMigration)
})

it('leaves existing messages without a summary, and refuses negative counts', () => {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 5))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m', 't', 1, 'agent', 'Done.', 1, 5)",
  ).run()

  migrate(db, MIGRATIONS)

  expect(listMessages(db, 't')).toEqual([
    { id: 'm', taskId: 't', role: 'agent', body: 'Done.', turn: 1, createdAt: 5, summary: null, images: [] },
  ])
  expect(() => db.prepare("UPDATE messages SET files_changed = -1 WHERE id = 'm'").run()).toThrow(
    'CHECK constraint failed',
  )
  db.close()
})
