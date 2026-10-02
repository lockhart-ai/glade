import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { attachedFilesMigration } from './0046-attached-files'

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

function addFile(id: string, owner: Owner, name = 'sales.csv'): void {
  db.prepare(
    `INSERT INTO attached_files (id, task_id, message_id, queued_message_id, draft_task_id, position, name, path, size,
      kind, created_at)
    VALUES (?, 't', ?, ?, ?, 0, ?, ?, 48, 'text', 5)`,
  ).run(id, owner.message ?? null, owner.queued ?? null, owner.draft ?? null, name, `.glade/attachments/t/${name}`)
}

function count(): unknown {
  return db.prepare('SELECT COUNT(*) FROM attached_files').pluck().get()
}

it('is migration 46, after every earlier one', () => {
  expect(attachedFilesMigration.version).toBe(46)
  expect(MIGRATIONS.indexOf(attachedFilesMigration)).toBe(MIGRATIONS.filter((m) => m.version < 46).length)
})

it('starts with no files, and keeps each one’s name, path, size and kind', () => {
  expect(count()).toBe(0)
  addFile('f', { message: 'm' }, 'sales (2).csv')
  expect(db.prepare("SELECT name, path, size, kind FROM attached_files WHERE id = 'f'").get()).toEqual({
    name: 'sales (2).csv',
    path: '.glade/attachments/t/sales (2).csv',
    size: 48,
    kind: 'text',
  })
})

it('gives each file exactly one owner: a message, a queued message or a draft', () => {
  expect(() => {
    addFile('none', {})
  }).toThrow(/CHECK/)
  expect(() => {
    addFile('both', { message: 'm', draft: 't' })
  }).toThrow(/CHECK/)
  addFile('drafted', { draft: 't' })
  expect(count()).toBe(1)
})

it('drops a file with its queued message, its message or its draft', () => {
  addFile('sent', { message: 'm' })
  addFile('queued', { queued: 'q' })
  addFile('drafted', { draft: 't' })
  db.prepare("DELETE FROM queued_messages WHERE id = 'q'").run()
  expect(count()).toBe(2)
  db.prepare("DELETE FROM input_drafts WHERE task_id = 't'").run()
  expect(count()).toBe(1)
  db.prepare("DELETE FROM messages WHERE id = 'm'").run()
  expect(count()).toBe(0)
})

it('drops a file with its task', () => {
  addFile('sent', { message: 'm' })
  db.prepare("DELETE FROM tasks WHERE id = 't'").run()
  expect(count()).toBe(0)
})
