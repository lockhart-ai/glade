import { expect, it } from 'vitest'
import { TodoState } from '../../../shared/domain'
import { getTodoCounter, listTodos, updateTodo } from '../repositories/glade-todos'
import { openDatabase } from '../database'
import { migrate } from '../migrate'
import { MIGRATIONS } from '.'
import { carryOverTodosMigration } from './0074-carry-over-todos'

/** A finished call of the task's agent, as the tool log keeps it. */
function call(
  db: ReturnType<typeof openDatabase>,
  taskId: string,
  toolUseId: string,
  name: string,
  input: object,
  output: string,
  at: number,
): void {
  db.prepare(
    `INSERT INTO tool_events (seq, id, task_id, kind, turn, created_at, tool_name, tool_input, tool_output,
      finished_at, tool_state, tool_use_id, parent_tool_use_id)
    VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_events WHERE task_id = ?), ?, ?, 'tool_call', 1, ?, ?, ?, ?,
      ?, 'done', ?, NULL)`,
  ).run(taskId, `event-${toolUseId}`, taskId, at, name, JSON.stringify(input), output, at, toolUseId)
}

function task(db: ReturnType<typeof openDatabase>, id: string): void {
  db.prepare(
    `INSERT INTO tasks (id, workspace_id, title, objective, status, state, pinned, unread, model, effort, created_at, updated_at)
    VALUES (?, 'w1', '', '', '', 'active', 0, 0, 'claude-sample-1', 'medium', 1, 1)`,
  ).run(id)
}

it("is migration 74, carrying every task's todos over the same way `carryOverTodos` already does", () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 74),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  task(db, 't1')
  task(db, 't2')
  call(
    db,
    't1',
    'toolu_1',
    'TaskCreate',
    { subject: 'Review the date helpers' },
    'Task #1 created successfully: Review the date helpers',
    1_000,
  )
  call(db, 't1', 'toolu_2', 'TaskUpdate', { taskId: '1', status: 'in_progress' }, 'Updated task #1 status', 1_100)
  call(
    db,
    't1',
    'toolu_3',
    'TaskCreate',
    { subject: 'Fix the UTC date test' },
    'Task #2 created successfully: Fix the UTC date test',
    1_200,
  )
  db.prepare('INSERT INTO retired_todos (task_id, todo_id, retired_at) VALUES (?, ?, ?)').run('t1', '2', 1_300)
  // A task with no todo activity at all still gets its counter seeded.
  expect(carryOverTodosMigration.version).toBe(74)

  migrate(db, MIGRATIONS)

  // t1's oldest todo carries over exactly as it read, and the retired one stays out.
  expect(listTodos(db, 't1')).toEqual([
    { id: '1', text: 'Review the date helpers', note: null, state: TodoState.Doing, completedAt: null },
  ])
  // The oldest todo can still be updated afterwards.
  expect(updateTodo(db, 't1', '1', { state: TodoState.Done })?.state).toBe(TodoState.Done)
  // The retired id is never given again: the counter started past it, not just past what's left.
  expect(getTodoCounter(db, 't1')).toBeGreaterThanOrEqual(3)
  // A task with no todo history still gets a counter, so create_todo starts fresh at 1 for it.
  expect(getTodoCounter(db, 't2')).toBe(1)
  expect(listTodos(db, 't2')).toEqual([])
})

it('changes nothing run a second time (idempotent, as `carryOverTodos` already is)', () => {
  const db = openDatabase(':memory:')
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 74),
  )
  db.prepare("INSERT INTO workspaces VALUES ('w1', 'Acme API', '/code/acme-api', 1, 1)").run()
  task(db, 't1')
  call(
    db,
    't1',
    'toolu_1',
    'TaskCreate',
    { subject: 'Review the date helpers' },
    'Task #1 created successfully: Review the date helpers',
    1_000,
  )

  // Run up to 74 alone: migration 75 drops the retired_todos table this migration reads, and the second run here
  // re-runs `up` by hand, as it did when the table was there.
  migrate(
    db,
    MIGRATIONS.filter(({ version }) => version < 75),
  )
  const before = listTodos(db, 't1')
  const counter = getTodoCounter(db, 't1')

  carryOverTodosMigration.up(db)

  expect(listTodos(db, 't1')).toEqual(before)
  expect(getTodoCounter(db, 't1')).toBe(counter)
})
