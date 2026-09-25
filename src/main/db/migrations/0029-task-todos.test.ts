import type { Database } from 'better-sqlite3'
import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { taskTodosMigration } from './0029-task-todos'

it('is migration 29', () => {
  expect(MIGRATIONS[28]).toBe(taskTodosMigration)
})

/** A database at the schema before this migration, with one workspace. */
function before(): Database {
  const db = openDatabase(':memory:')
  migrate(db, MIGRATIONS.slice(0, 28))
  db.prepare(
    "INSERT INTO workspaces (id, name, root_path, created_at, last_opened_at) VALUES ('w', 'Acme API', '/code/acme-api', 1, 1)",
  ).run()
  return db
}

function insertTask(db: Database, id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, activity, pinned, unread, model, effort,
      created_at, updated_at, done_at, permission_mode)
    VALUES (?, 'w', '', '', '', 'active', 'waiting', 0, 0, 'claude-sample-1', 'high', 1, 1, NULL, 'allow_all')`,
  ).run(id)
}

let seq = 0

function insertCall(db: Database, taskId: string, name: string): void {
  seq += 1
  db.prepare(
    `INSERT INTO tool_events (id, task_id, seq, kind, turn, created_at, tool_name, tool_input, tool_output, tool_state,
      tool_use_id)
    VALUES (?, ?, ?, 'tool_call', 1, 1, ?, '{}', 'ok', 'done', ?)`,
  ).run(`e${String(seq)}`, taskId, seq, name, `toolu_${String(seq)}`)
}

it('marks the tasks that called a todo tool, whose summaries main works out, and starts every task with none', () => {
  const db = before()
  for (const id of ['write', 'create', 'update', 'other', 'none']) insertTask(db, id)
  insertCall(db, 'write', 'TodoWrite')
  insertCall(db, 'create', 'TaskCreate')
  insertCall(db, 'update', 'Bash')
  insertCall(db, 'update', 'TaskUpdate')
  insertCall(db, 'other', 'Bash')

  migrate(db, MIGRATIONS)

  expect(db.prepare('SELECT id FROM tasks WHERE todos_stale = 1 ORDER BY id').pluck().all()).toEqual([
    'create',
    'update',
    'write',
  ])
  expect(db.prepare('SELECT DISTINCT todos FROM tasks').pluck().all()).toEqual([null])
  db.close()
})

it('holds a JSON object or nothing, and a 0/1 stale mark', () => {
  const db = before()
  insertTask(db, 'a')
  migrate(db, MIGRATIONS)

  const set = (todos: string | null, stale = 0) => {
    db.prepare("UPDATE tasks SET todos = ?, todos_stale = ? WHERE id = 'a'").run(todos, stale)
  }
  set('{"done":1,"total":2,"doing":[]}')
  expect(() => {
    set('[1, 2]')
  }).toThrow(/CHECK/)
  expect(() => {
    set('not json')
  }).toThrow(/CHECK/)
  expect(() => {
    set(null, 2)
  }).toThrow(/CHECK/)
  db.close()
})
