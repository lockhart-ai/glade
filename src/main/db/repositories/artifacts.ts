import type { Database } from 'better-sqlite3'
import type { Artifact, EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** An artifact to declare: which file of which task, and what to call it. */
export interface NewArtifact {
  readonly taskId: string
  /** Relative to the task's workspace root. */
  readonly path: string
  readonly title: string
}

function parseArtifact(raw: unknown): Artifact {
  const row = new Row('artifacts', raw)
  return {
    taskId: row.text('task_id'),
    path: row.text('path'),
    title: row.text('title'),
    addedAt: row.integer('added_at'),
    updatedAt: row.integer('updated_at'),
  }
}

/**
 * Declares a file as one of a task's artifacts. A path it already has keeps its place and takes the new title. Answers
 * with the artifact as it now is.
 */
export function addArtifact(db: Database, { taskId, path, title }: NewArtifact, now: EpochMs = Date.now()): Artifact {
  const raw: unknown = db
    .prepare(
      `INSERT INTO artifacts (task_id, path, title, added_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id, path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
      RETURNING task_id, path, title, added_at, updated_at`,
    )
    .get(taskId, path, title, now, now)
  return parseArtifact(raw)
}

/** A task's artifacts, in the order they were first declared. */
export function listArtifacts(db: Database, taskId: string): Artifact[] {
  return db
    .prepare(
      `SELECT task_id, path, title, added_at, updated_at FROM artifacts WHERE task_id = ? ORDER BY added_at, rowid`,
    )
    .all(taskId)
    .map(parseArtifact)
}
