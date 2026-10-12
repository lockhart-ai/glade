/**
 * Glade's own todos (#609): the `todos` table, one row per todo, and `todo_counters`, the next id `create_todo` gives
 * a task's next one. A task's ids only ever go up (`allocateTodoId`, `seedTodoCounterAtLeast`), so a deleted todo's
 * number is never given to another.
 *
 * A plain store: it keeps whatever `text`, `note` and `state` it's given, with no rule of its own about when a note
 * shows (that's `../../todos/carry-over`'s and the tools' business, not this one's).
 */
import type { Database } from 'better-sqlite3'
import { TodoState, type EpochMs, type Todo } from '../../../shared/domain'
import { Row } from './rows'

const STATES: readonly TodoState[] = Object.values(TodoState)

function parseTodo(raw: unknown): Todo {
  const row = new Row('todos', raw)
  return {
    id: String(row.integer('id')),
    text: row.text('text'),
    note: row.nullableText('note'),
    state: row.oneOf('state', STATES),
    completedAt: row.nullableInteger('completed_at'),
  }
}

/** A todo as it's written, by its own id (never given by the table itself: see `allocateTodoId`). */
export interface NewTodo {
  readonly id: string
  readonly text: string
  readonly note: string | null
  readonly state: TodoState
  readonly completedAt: EpochMs | null
}

/** A task's todos, lowest id first — which is also the order they were created in, since an id is never reused. */
export function listTodos(db: Database, taskId: string): Todo[] {
  return db
    .prepare('SELECT id, text, note, state, completed_at FROM todos WHERE task_id = ? ORDER BY id')
    .all(taskId)
    .map(parseTodo)
}

/** One of a task's todos by id; undefined when it has none of that id. */
export function getTodo(db: Database, taskId: string, id: string): Todo | undefined {
  const raw = db
    .prepare('SELECT id, text, note, state, completed_at FROM todos WHERE task_id = ? AND id = ?')
    .get(taskId, Number(id))
  return raw === undefined ? undefined : parseTodo(raw)
}

/**
 * Writes some of a task's todos directly, by their own id: a row of the same id is replaced whole. For the
 * carry-over (`../../todos/carry-over`) and tests; `create_todo` and `update_todo` go through `allocateTodoId` and
 * `updateTodo` instead, which keep `created_at` as it was.
 */
export function putTodos(db: Database, taskId: string, todos: readonly NewTodo[], now: EpochMs = Date.now()): void {
  const upsert = db.prepare(`
    INSERT INTO todos (task_id, id, text, note, state, completed_at, created_at, updated_at)
    VALUES (@taskId, @id, @text, @note, @state, @completedAt, @now, @now)
    ON CONFLICT (task_id, id) DO UPDATE SET
      text = excluded.text, note = excluded.note, state = excluded.state, completed_at = excluded.completed_at,
      updated_at = excluded.updated_at
  `)
  db.transaction(() => {
    for (const { id, text, note, state, completedAt } of todos) {
      upsert.run({ taskId, id: Number(id), text, note, state, completedAt, now })
    }
  })()
}

/** Changes one of a task's todos; undefined, with nothing written, when it has none of that id. */
export function updateTodo(
  db: Database,
  taskId: string,
  id: string,
  patch: { text?: string; note?: string | null; state?: TodoState },
  now: EpochMs = Date.now(),
): Todo | undefined {
  const before = getTodo(db, taskId, id)
  if (before === undefined) return undefined
  const state = patch.state ?? before.state
  const completedAt = state === TodoState.Done ? (before.state === TodoState.Done ? before.completedAt : now) : null
  db.prepare(
    'UPDATE todos SET text = @text, note = @note, state = @state, completed_at = @completedAt, updated_at = @now ' +
      'WHERE task_id = @taskId AND id = @id',
  ).run({
    taskId,
    id: Number(id),
    text: patch.text ?? before.text,
    note: patch.note === undefined ? before.note : patch.note,
    state,
    completedAt,
    now,
  })
  return {
    ...before,
    text: patch.text ?? before.text,
    note: patch.note === undefined ? before.note : patch.note,
    state,
    completedAt,
  }
}

/** Removes one of a task's todos; whether it had one. */
export function deleteTodo(db: Database, taskId: string, id: string): boolean {
  return db.prepare('DELETE FROM todos WHERE task_id = ? AND id = ?').run(taskId, Number(id)).changes > 0
}

/** The next id `create_todo` would give the task; null while it's never made or carried one over. */
export function getTodoCounter(db: Database, taskId: string): number | null {
  const row = db.prepare('SELECT next_id FROM todo_counters WHERE task_id = ?').get(taskId)
  return row === undefined ? null : new Row('todo_counters', row).integer('next_id')
}

/**
 * Raises the task's counter to at least `next`, leaving it alone if it already stands there or higher: seeding never
 * takes an id back once given. Creates the row if the task has none yet.
 */
export function seedTodoCounterAtLeast(db: Database, taskId: string, next: number): void {
  db.prepare(
    `INSERT INTO todo_counters (task_id, next_id) VALUES (?, ?)
    ON CONFLICT (task_id) DO UPDATE SET next_id = MAX(next_id, excluded.next_id)`,
  ).run(taskId, next)
}

/**
 * Gives the task its next todo id, raising its counter past it, and seeding the counter at 1 first if it's never had
 * one. Never reused: the counter only ever goes up (`seedTodoCounterAtLeast`), whatever happens to the todo it names.
 */
export function allocateTodoId(db: Database, taskId: string): string {
  return db.transaction(() => {
    const next = getTodoCounter(db, taskId) ?? 1
    seedTodoCounterAtLeast(db, taskId, next + 1)
    return String(next)
  })()
}
