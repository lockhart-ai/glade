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
 * The kind a watcher's rows have in the hub's tables (`child_ids`, `child_filings`, `owed_filings`). Watchers were
 * children until #535 took them out of the hub; the tables' `kind` checks still allow the word, and rows written
 * before then stay where they are. Nothing reads one as a child: every read leaves them out, and nothing writes one.
 * A watcher's short id still counts towards a task's next number, so it's never given to another child.
 */
export const WATCHER_KIND = 'watcher'

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

/**
 * The child of a task a short id names; undefined when it names none, isn't a short id at all, or was a watcher's
 * (`isWatcherId`).
 */
export function findChildById(db: Database, taskId: string, id: ChildId): ChildRef | undefined {
  const number = childIdNumber(id)
  if (number === null) return undefined
  const raw: unknown = db
    .prepare('SELECT kind, key FROM child_ids WHERE task_id = ? AND number = ? AND kind <> ?')
    .get(taskId, number, WATCHER_KIND)
  if (raw === undefined) return undefined
  const row = new Row('child_ids', raw)
  return { kind: row.oneOf('kind', CHILD_KINDS), key: row.text('key') }
}

/**
 * Whether a short id is one a watcher of the task was given, back when watchers had ids (before #535): what tells the
 * agent that names one that watchers aren't filed, where any other id that names no child was never one.
 */
export function isWatcherId(db: Database, taskId: string, id: ChildId): boolean {
  const number = childIdNumber(id)
  if (number === null) return false
  const found: unknown = db
    .prepare('SELECT 1 FROM child_ids WHERE task_id = ? AND number = ? AND kind = ?')
    .get(taskId, number, WATCHER_KIND)
  return found !== undefined
}
