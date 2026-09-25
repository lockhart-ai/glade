/**
 * What a backfill keeps of a task (`task_backfills`): the caller's own id for it, and its handoff note. A task has a row
 * only once it has either.
 */
import type { Database } from 'better-sqlite3'
import type { EpochMs, TaskHandoff } from '../../../shared/domain'
import { Row } from './rows'

/** A task's handoff note, or undefined when it has none. */
export function getHandoff(db: Database, taskId: string): TaskHandoff | undefined {
  const raw: unknown = db
    .prepare('SELECT handoff, handoff_at FROM task_backfills WHERE task_id = ? AND handoff IS NOT NULL')
    .get(taskId)
  if (raw === undefined) return undefined
  const row = new Row('task_backfills', raw)
  return { taskId, body: row.text('handoff'), addedAt: row.integer('handoff_at') }
}

/**
 * Sets a task's handoff note (`body`, Markdown), stamped `now`, or clears it (`body` null). Answers with the note as it
 * now is, or undefined once cleared. Throws when the note is over `MAX_HANDOFF_BYTES`, which the schema checks too.
 */
export function setHandoff(
  db: Database,
  taskId: string,
  body: string | null,
  now: EpochMs = Date.now(),
): TaskHandoff | undefined {
  db.prepare(
    `INSERT INTO task_backfills (task_id, handoff, handoff_at) VALUES (@taskId, @body, @at)
    ON CONFLICT (task_id) DO UPDATE SET handoff = excluded.handoff, handoff_at = excluded.handoff_at`,
  ).run({ taskId, body, at: body === null ? null : now })
  return body === null ? undefined : { taskId, body, addedAt: now }
}

/** The caller's own id for a task (`create_task`'s `externalId`), or null when it was given none. */
export function getExternalId(db: Database, taskId: string): string | null {
  const id: unknown = db.prepare('SELECT external_id FROM task_backfills WHERE task_id = ?').pluck().get(taskId)
  return typeof id === 'string' ? id : null
}

/**
 * Gives a task the caller's own id for it. Throws a `SQLITE_CONSTRAINT_UNIQUE` error when another task has that id.
 */
export function setExternalId(db: Database, taskId: string, externalId: string): void {
  db.prepare(
    `INSERT INTO task_backfills (task_id, external_id) VALUES (?, ?)
    ON CONFLICT (task_id) DO UPDATE SET external_id = excluded.external_id`,
  ).run(taskId, externalId)
}

/** The id of the task with the caller's own id `externalId`, or undefined when there's none. */
export function findTaskByExternalId(db: Database, externalId: string): string | undefined {
  const id: unknown = db.prepare('SELECT task_id FROM task_backfills WHERE external_id = ?').pluck().get(externalId)
  return typeof id === 'string' ? id : undefined
}
