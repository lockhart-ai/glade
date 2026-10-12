import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { retiredTodosMigration } from './0071-retired-todos'

it('adds the closed stranded todos, going with their task and refusing an id-less row', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 71),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  expect(retiredTodosMigration.version).toBe(71)
  migrate(db, MIGRATIONS)
  db.prepare('INSERT INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run('t1', '45', 9_000)
  expect(db.prepare('SELECT todo_id, retired_at FROM retired_todos WHERE task_id = ?').all('t1')).toEqual([
    { todo_id: '45', retired_at: 9_000 },
  ])
  // An id-less todo (a TodoWrite item) can't be closed, and neither can the placeholder.
  expect(() =>
    db.prepare('INSERT INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run('t1', '', 9_000),
  ).toThrow()
  expect(() =>
    db.prepare('INSERT INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run('t1', 'unfiled', 9_000),
  ).toThrow()
  // One row per todo: closing it again changes nothing.
  db.prepare('INSERT OR IGNORE INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run(
    't1',
    '45',
    9_500,
  )
  expect(db.prepare('SELECT retired_at FROM retired_todos WHERE task_id = ? AND todo_id = ?').get('t1', '45')).toEqual({
    retired_at: 9_000,
  })
  // The rows go with their task.
  db.prepare('DELETE FROM tasks WHERE id = ?').run('t1')
  expect(db.prepare('SELECT todo_id FROM retired_todos').all()).toEqual([])
})
