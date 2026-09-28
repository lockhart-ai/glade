import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { pastedBlocksMigration } from './0044-pasted-blocks'

let db: Database

beforeEach(() => {
  db = openDatabase(':memory:')
  migrate(db, MIGRATIONS)
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES ('t', 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  ).run()
  db.prepare(
    "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m', 't', 1, 'user', 'hi', 1, 2)",
  ).run()
  db.prepare("INSERT INTO queued_messages VALUES ('q', 't', 1, '', 3)").run()
  db.prepare("INSERT INTO input_drafts (task_id, text, updated_at) VALUES ('t', '', 4)").run()
})

afterEach(() => {
  db.close()
})

interface Owner {
  readonly message?: string
  readonly queued?: string
  readonly draft?: string
}

function addBlock(id: string, owner: Owner, text = 'pasted', tagId = 'abc123'): void {
  db.prepare(
    `INSERT INTO pasted_blocks (id, task_id, message_id, queued_message_id, draft_task_id, position, tag_id, text,
      created_at)
    VALUES (?, 't', ?, ?, ?, 0, ?, ?, 5)`,
  ).run(id, owner.message ?? null, owner.queued ?? null, owner.draft ?? null, tagId, text)
}

function count(): unknown {
  return db.prepare('SELECT COUNT(*) FROM pasted_blocks').pluck().get()
}

function messageSearchBody(): unknown {
  return db.prepare("SELECT body FROM search_documents WHERE message_id = 'm' AND field = 'message'").pluck().get()
}

it('is migration 44, after every earlier one', () => {
  expect(pastedBlocksMigration.version).toBe(44)
  expect(MIGRATIONS.indexOf(pastedBlocksMigration)).toBe(MIGRATIONS.filter((m) => m.version < 44).length)
})

it('starts with no blocks, and keeps their text as it was', () => {
  expect(count()).toBe(0)
  addBlock('b', { message: 'm' }, 'the pasted text')
  expect(db.prepare("SELECT text, tag_id FROM pasted_blocks WHERE id = 'b'").get()).toEqual({
    text: 'the pasted text',
    tag_id: 'abc123',
  })
})

it('gives each block exactly one owner: a message, a queued message or a draft', () => {
  expect(() => {
    addBlock('none', {})
  }).toThrow(/CHECK/)
  expect(() => {
    addBlock('both', { message: 'm', queued: 'q' })
  }).toThrow(/CHECK/)
  addBlock('drafted', { draft: 't' })
  expect(count()).toBe(1)
})

it('drops a block with its queued message, its message or its draft', () => {
  addBlock('sent', { message: 'm' })
  addBlock('queued', { queued: 'q' })
  addBlock('drafted', { draft: 't' })
  db.prepare("DELETE FROM queued_messages WHERE id = 'q'").run()
  expect(count()).toBe(2)
  db.prepare("DELETE FROM input_drafts WHERE task_id = 't'").run()
  expect(count()).toBe(1)
  db.prepare("DELETE FROM messages WHERE id = 'm'").run()
  expect(count()).toBe(0)
})

it('drops a block with its task', () => {
  addBlock('sent', { message: 'm' })
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(count()).toBe(0)
})

it("appends a message-owned block's text to its message's search document, so a search matches inside it", () => {
  expect(messageSearchBody()).toBe('hi')
  addBlock('b1', { message: 'm' }, 'first pasted block')
  expect(messageSearchBody()).toBe(`hi\nfirst pasted block`)
  addBlock('b2', { message: 'm' }, 'second pasted block')
  expect(messageSearchBody()).toBe(`hi\nfirst pasted block\nsecond pasted block`)
  expect(
    db
      .prepare(
        "SELECT rowid FROM search_fts WHERE search_fts MATCH 'second' AND rowid IN (SELECT id FROM search_documents WHERE message_id = 'm')",
      )
      .all(),
  ).toHaveLength(1)
})

it("doesn't touch search for a block owned by a queued message or a draft, which aren't indexed", () => {
  addBlock('queued', { queued: 'q' })
  addBlock('drafted', { draft: 't' })
  expect(db.prepare('SELECT COUNT(*) FROM search_documents').pluck().get()).toBe(4) // title, objective, status, message
})
