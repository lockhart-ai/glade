import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { gladeTodosMigration } from './0073-glade-todos'

it("adds Glade's own todos table and its id counter, going with their task", () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 73),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  expect(gladeTodosMigration.version).toBe(73)
  migrate(db, MIGRATIONS)

  db.prepare(
    'INSERT INTO todos (task_id, id, text, note, state, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run('t1', 1, 'Review the date helpers', 'Reading the diff', 'doing', null, 1_000, 1_100)
  expect(db.prepare('SELECT id, text, note, state, completed_at FROM todos WHERE task_id = ?').all('t1')).toEqual([
    { id: 1, text: 'Review the date helpers', note: 'Reading the diff', state: 'doing', completed_at: null },
  ])

  // A blank text or note, an unknown state, or an id that isn't positive is refused.
  const insertTodo = db.prepare(
    'INSERT INTO todos (task_id, id, text, note, state, completed_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  )
  expect(() => insertTodo.run('t1', 2, '', null, 'todo', null, 1_000, 1_000)).toThrow()
  expect(() => insertTodo.run('t1', 3, 'Fix the test', '', 'todo', null, 1_000, 1_000)).toThrow()
  expect(() => insertTodo.run('t1', 4, 'Fix the test', null, 'blocked', null, 1_000, 1_000)).toThrow()
  expect(() => insertTodo.run('t1', 0, 'Fix the test', null, 'todo', null, 1_000, 1_000)).toThrow()
  // Two todos of the same task can't share an id.
  expect(() => insertTodo.run('t1', 1, 'Another one', null, 'todo', null, 1_000, 1_000)).toThrow()

  db.prepare('INSERT INTO todo_counters (task_id, next_id) VALUES (?, ?)').run('t1', 2)
  expect(db.prepare('SELECT next_id FROM todo_counters WHERE task_id = ?').get('t1')).toEqual({ next_id: 2 })
  // A task has one counter row.
  expect(() => db.prepare('INSERT INTO todo_counters (task_id, next_id) VALUES (?, ?)').run('t1', 5)).toThrow()
  // The counter must be positive.
  expect(() => db.prepare('INSERT INTO todo_counters (task_id, next_id) VALUES (?, ?)').run('t1', 0)).toThrow()

  // Both go with their task.
  db.prepare('DELETE FROM tasks WHERE id = ?').run('t1')
  expect(db.prepare('SELECT * FROM todos').all()).toEqual([])
  expect(db.prepare('SELECT * FROM todo_counters').all()).toEqual([])
})
