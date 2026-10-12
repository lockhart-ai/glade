import { expect, it } from 'vitest'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { dropRetiredTodosMigration } from './0075-drop-retired-todos'

it('is migration 75', () => {
  expect(MIGRATIONS.find((migration) => migration.version === 75)).toBe(dropRetiredTodosMigration)
  expect(MIGRATIONS.at(-1)?.version).toBe(75)
})

it('drops the retired todos, and with them the rows the closing agent had made', () => {
  const db = openDatabase(':memory:')
  // Migration 72 made the table; 73 and 74 leave it alone.
  migrate(
    db,
    MIGRATIONS.filter((migration) => migration.version < 75),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  db.prepare(
    'INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at) ' +
      "VALUES ('t1', 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)",
  ).run()
  db.prepare('INSERT INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run('t1', '45', 9_000)
  db.prepare(
    "INSERT INTO todos (task_id, id, text, state, created_at, updated_at) VALUES ('t1', 1, 'Write the report', 'todo', 1, 1)",
  ).run()

  migrate(db, MIGRATIONS)

  expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'retired_todos'").all()).toEqual([])
  // Glade's own todos, which migration 73 added, keep their rows: only the retired ones go.
  expect(db.prepare('SELECT id, text FROM todos WHERE task_id = ?').all('t1')).toEqual([
    { id: 1, text: 'Write the report' },
  ])
  db.close()
})
