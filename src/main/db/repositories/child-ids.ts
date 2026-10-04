import type { Database } from 'better-sqlite3'
import {
  CHILD_KINDS,
  childId,
  childIdNumber,
  type ChildId,
  type ChildRef,
  type IdentifiedChild,
} from '../../../shared/todoHub'
import { Row } from './rows'

// The short ids of a task's children in the todo hub (P16, `src/shared/todoHub.ts`): `c1`, `c2`, … Nothing here ever
// changes or removes a row, which is what keeps an id meaning one child for the life of its task.

/**
 * The short ids of some of a task's children, in the order given, giving each that has none the task's next number.
 * A child named before keeps the id it has, whatever became of it since.
 */
export function assignChildIds(db: Database, taskId: string, children: readonly ChildRef[]): IdentifiedChild[] {
  const assign = db.prepare(
    `INSERT INTO child_ids (task_id, number, kind, key)
    VALUES (@taskId, (SELECT COALESCE(MAX(number), 0) + 1 FROM child_ids WHERE task_id = @taskId), @kind, @key)
    ON CONFLICT (task_id, kind, key) DO NOTHING`,
  )
  const read = db.prepare('SELECT number FROM child_ids WHERE task_id = ? AND kind = ? AND key = ?')
  return db.transaction(() =>
    children.map(({ kind, key }) => {
      assign.run({ taskId, kind, key })
      const number = new Row('child_ids', read.get(taskId, kind, key)).integer('number')
      return { kind, key, id: childId(number) }
    }),
  )()
}

/** The child of a task a short id names; undefined when it names none, or isn't a short id at all. */
export function findChildById(db: Database, taskId: string, id: ChildId): ChildRef | undefined {
  const number = childIdNumber(id)
  if (number === null) return undefined
  const raw: unknown = db
    .prepare('SELECT kind, key FROM child_ids WHERE task_id = ? AND number = ?')
    .get(taskId, number)
  if (raw === undefined) return undefined
  const row = new Row('child_ids', raw)
  return { kind: row.oneOf('kind', CHILD_KINDS), key: row.text('key') }
}
