import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { CHILD_KINDS, type ChildRef } from '../../../shared/todoHub'
import { Row } from './rows'

// The filings a task's agent owes (P16-04, `../../todo-hub/filing`): the children it made itself, with the todo hub on,
// in calls that named no todo, until it files each.

/** Records children of a task as owed a filing. One that's owed already stays as it was. */
export function oweFilings(
  db: Database,
  taskId: string,
  children: readonly ChildRef[],
  now: EpochMs = Date.now(),
): void {
  const owe = db.prepare(
    `INSERT INTO owed_filings (task_id, kind, key, made_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (task_id, kind, key) DO NOTHING`,
  )
  db.transaction(() => {
    for (const { kind, key } of children) owe.run(taskId, kind, key, now)
  })()
}

/** The children of a task its agent still owes a filing for, in the order they were recorded. */
export function listOwedFilings(db: Database, taskId: string): ChildRef[] {
  return db
    .prepare('SELECT kind, key FROM owed_filings WHERE task_id = ? ORDER BY made_at, rowid')
    .all(taskId)
    .map((raw) => {
      const row = new Row('owed_filings', raw)
      return { kind: row.oneOf('kind', CHILD_KINDS), key: row.text('key') }
    })
}

/** Children of a task are owed nothing any more: each was filed, or is gone. */
export function settleOwedFilings(db: Database, taskId: string, children: readonly ChildRef[]): void {
  const settle = db.prepare('DELETE FROM owed_filings WHERE task_id = ? AND kind = ? AND key = ?')
  db.transaction(() => {
    for (const { kind, key } of children) settle.run(taskId, kind, key)
  })()
}
