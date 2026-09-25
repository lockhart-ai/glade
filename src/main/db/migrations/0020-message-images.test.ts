import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { messageImagesMigration } from './0020-message-images'

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 19))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m', 't', 1, 'user', '', 1, 2)",
  ).run()
  db.prepare("INSERT INTO queued_messages VALUES ('q', 't', 1, '', 3)").run()
  migrate(db, MIGRATIONS)
})

afterEach(() => {
  db.close()
})

interface Owner {
  readonly message?: string
  readonly queued?: string
}

function addImage(id: string, owner: Owner, mediaType = 'image/png'): void {
  db.prepare(
    `INSERT INTO images (id, task_id, message_id, queued_message_id, position, media_type, data, created_at)
    VALUES (?, 't', ?, ?, 0, ?, ?, 4)`,
  ).run(id, owner.message ?? null, owner.queued ?? null, mediaType, Buffer.from([1, 2, 3]))
}

function count(): unknown {
  return db.prepare('SELECT COUNT(*) FROM images').pluck().get()
}

it('is migration 20', () => {
  expect(MIGRATIONS[19]).toBe(messageImagesMigration)
})

it('starts with no images, and keeps their bytes as they were', () => {
  expect(count()).toBe(0)
  addImage('i', { message: 'm' })
  expect(db.prepare("SELECT data FROM images WHERE id = 'i'").pluck().get()).toEqual(Buffer.from([1, 2, 3]))
})

it('gives each image exactly one message, of a type the agent takes', () => {
  expect(() => {
    addImage('none', {})
  }).toThrow(/CHECK/)
  expect(() => {
    addImage('both', { message: 'm', queued: 'q' })
  }).toThrow(/CHECK/)
  expect(() => {
    addImage('tiff', { message: 'm' }, 'image/tiff')
  }).toThrow(/CHECK/)
})

it('drops an image with its queued message or its message', () => {
  addImage('sent', { message: 'm' })
  addImage('queued', { queued: 'q' })
  db.prepare("DELETE FROM queued_messages WHERE id = 'q'").run()
  expect(count()).toBe(1)
  db.prepare("DELETE FROM messages WHERE id = 'm'").run()
  expect(count()).toBe(0)
})

it('drops an image with its task', () => {
  addImage('sent', { message: 'm' })
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(count()).toBe(0)
})
