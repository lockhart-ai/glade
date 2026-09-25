import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { inputDraftsMigration } from './0028-input-drafts'

let db: Database

/** A database at the schema before this migration: a task with a message and a queued message, each with an image. */
beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 27))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id, permission_mode)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL, 'allow_all')`,
  ).run()
  db.prepare(
    "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m', 't', 1, 'user', '', 1, 2)",
  ).run()
  db.prepare("INSERT INTO queued_messages VALUES ('q', 't', 1, '', 3)").run()
  db.prepare(
    `INSERT INTO images (id, task_id, message_id, queued_message_id, position, media_type, data, created_at)
    VALUES ('sent', 't', 'm', NULL, 0, 'image/png', ?, 4), ('queued', 't', NULL, 'q', 1, 'image/gif', ?, 5)`,
  ).run(Buffer.from([1, 2, 3]), Buffer.from([4, 5]))
  migrate(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
})

interface Owner {
  readonly message?: string
  readonly queued?: string
  readonly draft?: string
}

function addImage(id: string, owner: Owner): void {
  db.prepare(
    `INSERT INTO images (id, task_id, message_id, queued_message_id, draft_task_id, position, media_type, data,
      created_at)
    VALUES (?, 't', ?, ?, ?, 0, 'image/png', ?, 6)`,
  ).run(id, owner.message ?? null, owner.queued ?? null, owner.draft ?? null, Buffer.from([1]))
}

function imageIds(): unknown[] {
  return db.prepare('SELECT id FROM images ORDER BY id').pluck().all()
}

it('is migration 28', () => {
  expect(MIGRATIONS[27]).toBe(inputDraftsMigration)
})

it('keeps every image as it was, bytes, owner and order', () => {
  expect(db.prepare('SELECT * FROM images ORDER BY position').all()).toEqual([
    {
      id: 'sent',
      task_id: 't',
      message_id: 'm',
      queued_message_id: null,
      draft_task_id: null,
      position: 0,
      media_type: 'image/png',
      data: Buffer.from([1, 2, 3]),
      created_at: 4,
    },
    {
      id: 'queued',
      task_id: 't',
      message_id: null,
      queued_message_id: 'q',
      draft_task_id: null,
      position: 1,
      media_type: 'image/gif',
      data: Buffer.from([4, 5]),
      created_at: 5,
    },
  ])
  expect(db.pragma('foreign_key_check')).toEqual([])
})

it('keeps the indexes, and adds one for drafts', () => {
  const indexes = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'images'").pluck()
  expect(indexes.all()).toEqual(
    expect.arrayContaining(['images_message', 'images_queued_message', 'images_draft']) as unknown,
  )
})

it('gives a draft its task, and an image exactly one owner', () => {
  db.prepare("INSERT INTO input_drafts VALUES ('t', 'Half a thought', 7)").run()
  addImage('draft', { draft: 't' })
  expect(imageIds()).toEqual(['draft', 'queued', 'sent'])
  expect(() => {
    db.prepare("INSERT INTO input_drafts VALUES ('t', 'Another', 8)").run()
  }).toThrow(/UNIQUE/)
  expect(() => {
    db.prepare("INSERT INTO input_drafts VALUES ('nope', '', 8)").run()
  }).toThrow(/FOREIGN KEY/)
  expect(() => {
    addImage('none', {})
  }).toThrow(/CHECK/)
  expect(() => {
    addImage('two', { message: 'm', draft: 't' })
  }).toThrow(/CHECK/)
  expect(() => {
    addImage('three', { message: 'm', queued: 'q', draft: 't' })
  }).toThrow(/CHECK/)
})

it('drops a draft’s images with it, and the draft with its task', () => {
  db.prepare("INSERT INTO input_drafts VALUES ('t', '', 7)").run()
  addImage('draft', { draft: 't' })
  db.prepare("DELETE FROM input_drafts WHERE task_id = 't'").run()
  expect(imageIds()).toEqual(['queued', 'sent'])

  db.prepare("INSERT INTO input_drafts VALUES ('t', '', 7)").run()
  addImage('draft', { draft: 't' })
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(db.prepare('SELECT COUNT(*) FROM input_drafts').pluck().get()).toBe(0)
  expect(imageIds()).toEqual([])
})
