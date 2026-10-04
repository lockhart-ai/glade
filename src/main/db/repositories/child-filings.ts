import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { CHILD_KINDS, FilingSource, type ChildRef, type Filing, type NewFiling } from '../../../shared/todoHub'
import { Row } from './rows'

// The todo hub's filings (P16, `src/shared/todoHub.ts`): which todo each of a task's children is under.

const SOURCES = Object.values(FilingSource)

function parseFiling(raw: unknown): Filing {
  const row = new Row('child_filings', raw)
  return {
    taskId: row.text('task_id'),
    kind: row.oneOf('kind', CHILD_KINDS),
    key: row.text('key'),
    todoId: row.text('todo_id'),
    source: row.oneOf('source', SOURCES),
    filedAt: row.integer('filed_at'),
  }
}

/**
 * Files children of a task under todos, all of them or none: a child that already has a filing gets this one in its
 * place. Answers with the filings as they now are, in the order given.
 */
export function putFilings(
  db: Database,
  taskId: string,
  filings: readonly NewFiling[],
  now: EpochMs = Date.now(),
): Filing[] {
  const upsert = db.prepare(
    `INSERT INTO child_filings (task_id, kind, key, todo_id, source, filed_at)
    VALUES (@taskId, @kind, @key, @todoId, @source, @filedAt)
    ON CONFLICT (task_id, kind, key)
    DO UPDATE SET todo_id = excluded.todo_id, source = excluded.source, filed_at = excluded.filed_at`,
  )
  return db.transaction(() =>
    filings.map(({ kind, key, todoId, source }) => {
      const filing: Filing = { taskId, kind, key, todoId, source, filedAt: now }
      upsert.run(filing)
      return filing
    }),
  )()
}

/** A task's filings, oldest first. None when nothing of it has been filed. */
export function listFilings(db: Database, taskId: string): Filing[] {
  return db
    .prepare(
      `SELECT task_id, kind, key, todo_id, source, filed_at FROM child_filings
      WHERE task_id = ? ORDER BY filed_at, kind, key`,
    )
    .all(taskId)
    .map(parseFiling)
}

/** Takes away the filings of some of a task's children. Answers with the children that had one. */
export function removeFilings(db: Database, taskId: string, children: readonly ChildRef[]): ChildRef[] {
  const remove = db.prepare('DELETE FROM child_filings WHERE task_id = ? AND kind = ? AND key = ?')
  return db.transaction(() =>
    children
      .filter(({ kind, key }) => remove.run(taskId, kind, key).changes > 0)
      .map(({ kind, key }) => ({ kind, key })),
  )()
}
