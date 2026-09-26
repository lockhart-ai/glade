import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Effort, PermissionMode, TaskState } from '../../../shared/domain'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { listMessages } from '../repositories/messages'
import { searchTasks } from '../repositories/search'
import { getTask, updateTask } from '../repositories/tasks'
import { MIGRATIONS } from '.'
import { SEARCH_TRIGGERS } from './0016-search-index'
import { sdkModelsMigration } from './0032-sdk-models'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-migration-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** What `tasks` is made of, besides its CHECK constraints: its columns, indexes and triggers. */
function tasksShape(db: Database): unknown {
  return {
    columns: db.pragma('table_info(tasks)'),
    foreignKeys: db.pragma('foreign_key_list(tasks)'),
    indexes: db
      .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'tasks' ORDER BY name")
      .all(),
    triggers: db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").pluck().all(),
  }
}

/** A database at migration 31, with a task at each effort there was then, each with a message. */
function databaseBefore(): Database {
  const db = openDatabase(join(dir, 'glade.db'))
  migrate(db, MIGRATIONS.slice(0, 31))
  db.prepare("INSERT INTO workspaces VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)").run()
  for (const effort of ['low', 'medium', 'high', 'max']) {
    db.prepare(
      `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
        created_at, updated_at, done_at, session_id, permission_mode, imported_at, todos_stale)
      VALUES (?, 'w', ?, 'Move them to S3.', 'Copying.', 'done', 'waiting', 1, 0, 'claude-sample-1', ?, 1, 2, 3, ?,
        'ask_before_edits', 4, 1)`,
    ).run(`t-${effort}`, `Move uploads ${effort}`, effort, `session-${effort}`)
    db.prepare(
      "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES (?, ?, 1, 'user', 'Go.', 1, 3)",
    ).run(`m-${effort}`, `t-${effort}`)
    db.prepare("INSERT INTO notifications (task_id, title, body, sent_at) VALUES (?, 'Move uploads', 'Done.', 4)").run(
      `t-${effort}`,
    )
  }
  return db
}

it('is migration 32, and rebuilds the tasks table with foreign keys off', () => {
  expect(MIGRATIONS[31]).toBe(sdkModelsMigration)
  expect(sdkModelsMigration.rebuildsReferencedTable).toBe(true)
})

it('keeps every task at its effort, with what references it, and lets a task take xhigh', () => {
  const db = databaseBefore()

  migrate(db, MIGRATIONS)

  for (const effort of [Effort.Low, Effort.Medium, Effort.High, Effort.Max]) {
    expect(getTask(db, `t-${effort}`)).toMatchObject({
      title: `Move uploads ${effort}`,
      state: TaskState.Done,
      pinned: true,
      model: 'claude-sample-1',
      effort,
      doneAt: 3,
      sessionId: `session-${effort}`,
      permissionMode: PermissionMode.AskBeforeEdits,
      importedAt: 4,
    })
    expect(listMessages(db, `t-${effort}`).map(({ id }) => id)).toEqual([`m-${effort}`])
  }
  expect(updateTask(db, 't-high', { effort: Effort.XHigh }).effort).toBe(Effort.XHigh)
  expect(() => db.prepare("UPDATE tasks SET effort = 'extreme' WHERE id = 't-low'").run()).toThrow(/CHECK/)
  expect(db.pragma('foreign_key_check')).toEqual([])
  db.close()
})

it('keeps the columns, indexes and triggers tasks had, and search still follows it', () => {
  const db = databaseBefore()
  const before = tasksShape(db)

  // Only up to this migration, which keeps the shape: a later one may add a column to tasks. The rest run below.
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version <= 32),
  )

  expect(tasksShape(db)).toEqual(before)
  const triggers = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'trigger'").pluck().all()
  expect(triggers).toEqual(expect.arrayContaining([...SEARCH_TRIGGERS]))
  migrate(db, MIGRATIONS)
  // A title changed, and a message added, after the rebuild are found.
  updateTask(db, 't-low', { title: 'Rotate the keys' })
  db.prepare(
    "INSERT INTO messages (id, task_id, seq, role, body, turn, created_at) VALUES ('m2', 't-max', 2, 'user', 'Check the bucket policy.', 2, 5)",
  ).run()
  expect(searchTasks(db, 'w', 'rotate').map(({ taskId }) => taskId)).toEqual(['t-low'])
  expect(searchTasks(db, 'w', 'bucket').map(({ taskId }) => taskId)).toEqual(['t-max'])
  // A unique session id still is.
  expect(() => db.prepare("UPDATE tasks SET session_id = 'session-low' WHERE id = 't-max'").run()).toThrow(/UNIQUE/)
  // Deleting a task still takes its messages and notifications with it.
  const notifications = (): unknown =>
    db.prepare("SELECT COUNT(*) FROM notifications WHERE task_id = 't-medium'").pluck().get()
  expect(notifications()).toBe(1)
  db.prepare("DELETE FROM tasks WHERE id = 't-medium'").run()
  expect(listMessages(db, 't-medium')).toEqual([])
  expect(notifications()).toBe(0)
  db.close()
})

it('adds an empty list of SDK models, which checks its efforts and ids', () => {
  const db = databaseBefore()
  migrate(db, MIGRATIONS)
  expect(db.prepare('SELECT COUNT(*) FROM sdk_models').pluck().get()).toBe(0)
  const insert = db.prepare(
    "INSERT INTO sdk_models (position, id, resolved_model, name, description, efforts) VALUES (?, ?, NULL, 'Sonnet', '', ?)",
  )
  insert.run(0, 'sonnet', '["low","high"]')
  expect(() => insert.run(1, 'sonnet', '[]')).toThrow(/UNIQUE/)
  expect(() => insert.run(2, 'haiku', '{}')).toThrow(/CHECK/)
  expect(() => insert.run(3, 'opus', 'not json')).toThrow(/CHECK/)
  db.close()
})
