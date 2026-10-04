import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import { ChildFilter, CHILD_KINDS, FilingSource, UNFILED_TODO_ID } from '../../../shared/todoHub'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { todoHubMigration } from './0059-todo-hub'

const folders: string[] = []

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

/** A database as it was before this migration, with a workspace and two tasks that have things in them. */
function existingDatabase(path = ':memory:'): Database {
  const db = openDatabase(path)
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 59),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  const task = db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, session_id)
    VALUES (?, 'w', 'Move the uploads', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, NULL)`,
  )
  task.run('t')
  task.run('other')
  db.prepare(
    `INSERT INTO artifacts (task_id, kind, path, url, title, added_at, updated_at, modified_at, missing)
    VALUES ('t', 'file', 'docs/plan.md', NULL, 'The plan', 1, 1, NULL, 0)`,
  ).run()
  return db
}

const FILING = `INSERT INTO child_filings (task_id, kind, key, todo_id, source, filed_at) VALUES (?, ?, ?, ?, ?, ?)`
const NUMBER = 'INSERT INTO child_ids (task_id, number, kind, key) VALUES (?, ?, ?, ?)'
const PANEL = `INSERT INTO todo_panels (task_id, todo_id, open, filter) VALUES (?, ?, ?, ?)`

it('is migration 59, after every earlier one', () => {
  expect(todoHubMigration.version).toBe(59)
  expect(MIGRATIONS.indexOf(todoHubMigration)).toBe(MIGRATIONS.filter((m) => m.version < 59).length)
})

it('applies to an existing database, leaving what it had as it was and nothing filed', () => {
  const db = existingDatabase()

  migrate(db, MIGRATIONS)

  expect(db.prepare('SELECT COUNT(*) FROM child_ids').pluck().get()).toBe(0)
  expect(db.prepare('SELECT COUNT(*) FROM child_filings').pluck().get()).toBe(0)
  expect(db.prepare('SELECT COUNT(*) FROM todo_panels').pluck().get()).toBe(0)
  expect(db.prepare('SELECT id FROM tasks ORDER BY id').pluck().all()).toEqual(['other', 't'])
  expect(db.prepare("SELECT path FROM artifacts WHERE task_id = 't'").pluck().all()).toEqual(['docs/plan.md'])
  db.close()
})

it('numbers a task’s children from 1, one number per child and one child per number', () => {
  const db = existingDatabase()
  migrate(db, MIGRATIONS)
  const number = db.prepare(NUMBER)

  for (const [index, kind] of CHILD_KINDS.entries()) number.run('t', index + 1, kind, 'same-key')
  // Each task counts for itself.
  number.run('other', 1, 'file', 'same-key')
  expect(db.prepare('SELECT COUNT(*) FROM child_ids').pluck().get()).toBe(CHILD_KINDS.length + 1)

  // A number is one child's, and a child has one number.
  expect(() => number.run('t', 1, 'file', 'docs/plan.md')).toThrow(/UNIQUE/)
  expect(() => number.run('t', 99, 'file', 'same-key')).toThrow(/UNIQUE/)
  expect(() => number.run('t', 0, 'file', 'docs/plan.md')).toThrow(/CHECK/)
  expect(() => number.run('t', 98, 'folder', 'docs')).toThrow(/CHECK/)
  expect(() => number.run('t', 98, 'file', '')).toThrow(/CHECK/)
  expect(() => number.run('nope', 1, 'file', 'docs/plan.md')).toThrow(/FOREIGN KEY/)
  db.close()
})

it('keeps one filing per child of a task, of every kind and source, by the todo’s own id', () => {
  const db = existingDatabase()
  migrate(db, MIGRATIONS)
  const file = db.prepare(FILING)

  for (const kind of CHILD_KINDS) file.run('t', kind, 'same-key', '1', FilingSource.Named, 10)
  for (const [index, source] of Object.values(FilingSource).entries()) {
    file.run('t', 'file', `docs/${String(index)}.md`, '2', source, 10)
  }
  // The same child of another task is another child.
  file.run('other', 'file', 'same-key', '1', FilingSource.Named, 10)
  expect(db.prepare('SELECT COUNT(*) FROM child_filings').pluck().get()).toBe(
    CHILD_KINDS.length + Object.values(FilingSource).length + 1,
  )

  expect(() => file.run('t', 'file', 'same-key', '2', FilingSource.Moved, 20)).toThrow(/UNIQUE/)
  expect(() => file.run('t', 'folder', 'docs', '1', FilingSource.Named, 10)).toThrow(/CHECK/)
  expect(() => file.run('t', 'file', 'docs/plan.md', '1', 'guessed', 10)).toThrow(/CHECK/)
  expect(() => file.run('t', 'file', '', '1', FilingSource.Named, 10)).toThrow(/CHECK/)
  expect(() => file.run('t', 'file', 'docs/plan.md', '', FilingSource.Named, 10)).toThrow(/CHECK/)
  // Nothing is ever filed under the placeholder: that's what having no filing means.
  expect(() => file.run('t', 'file', 'docs/plan.md', UNFILED_TODO_ID, FilingSource.Named, 10)).toThrow(/CHECK/)
  expect(() => file.run('nope', 'file', 'docs/plan.md', '1', FilingSource.Named, 10)).toThrow(/FOREIGN KEY/)
  db.close()
})

it('keeps one panel per todo of a task, the placeholder’s under its reserved id, with any filter', () => {
  const db = existingDatabase()
  migrate(db, MIGRATIONS)
  const panel = db.prepare(PANEL)

  for (const [index, filter] of Object.values(ChildFilter).entries()) panel.run('t', String(index + 1), 1, filter)
  panel.run('t', UNFILED_TODO_ID, 0, ChildFilter.Links)
  panel.run('other', '1', 1, ChildFilter.All)
  expect(db.prepare('SELECT COUNT(*) FROM todo_panels').pluck().get()).toBe(Object.values(ChildFilter).length + 2)

  expect(() => panel.run('t', '1', 0, ChildFilter.All)).toThrow(/UNIQUE/)
  expect(() => panel.run('t', '', 1, ChildFilter.All)).toThrow(/CHECK/)
  expect(() => panel.run('t', '9', 2, ChildFilter.All)).toThrow(/CHECK/)
  expect(() => panel.run('t', '9', 1, 'images')).toThrow(/CHECK/)
  expect(() => panel.run('nope', '1', 1, ChildFilter.All)).toThrow(/FOREIGN KEY/)
  db.close()
})

it('drops a task’s child ids, filings and panels with the task, and no other task’s', () => {
  const db = existingDatabase()
  migrate(db, MIGRATIONS)
  for (const task of ['t', 'other']) {
    db.prepare(NUMBER).run(task, 1, 'file', 'docs/plan.md')
    db.prepare(FILING).run(task, 'file', 'docs/plan.md', '1', FilingSource.Named, 10)
    db.prepare(PANEL).run(task, '1', 1, ChildFilter.Files)
  }

  db.prepare("DELETE FROM tasks WHERE id = 't'").run()

  expect(db.prepare('SELECT task_id FROM child_ids').pluck().all()).toEqual(['other'])
  expect(db.prepare('SELECT task_id FROM child_filings').pluck().all()).toEqual(['other'])
  expect(db.prepare('SELECT task_id FROM todo_panels').pluck().all()).toEqual(['other'])
  db.close()
})

it('applies to a database on disk, and what’s filed after is there when it’s opened again', () => {
  const folder = mkdtempSync(join(tmpdir(), 'glade-todo-hub-'))
  folders.push(folder)
  const path = join(folder, 'glade.db')
  existingDatabase(path).close()

  // The app opens the old database and migrates it, files a child and leaves a panel open, then quits.
  const first = openDatabase(path)
  migrate(first, MIGRATIONS)
  first.prepare(NUMBER).run('t', 7, 'file', 'docs/plan.md')
  first.prepare(FILING).run('t', 'file', 'docs/plan.md', '3', FilingSource.Moved, 42)
  first.prepare(PANEL).run('t', '3', 1, ChildFilter.Files)
  first.close()

  const second = openDatabase(path)
  migrate(second, MIGRATIONS)
  expect(second.prepare('SELECT * FROM child_ids').all()).toEqual([
    { task_id: 't', number: 7, kind: 'file', key: 'docs/plan.md' },
  ])
  expect(second.prepare('SELECT * FROM child_filings').all()).toEqual([
    { task_id: 't', kind: 'file', key: 'docs/plan.md', todo_id: '3', source: 'moved', filed_at: 42 },
  ])
  expect(second.prepare('SELECT * FROM todo_panels').all()).toEqual([
    { task_id: 't', todo_id: '3', open: 1, filter: 'file' },
  ])
  second.close()
})
