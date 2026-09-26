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

/** What looking at an artifact's file found: when it last changed, or that it's gone. */
export type ArtifactFileState = { readonly missing: false; readonly modifiedAt: EpochMs } | { readonly missing: true }

/** What was seen of one of a task's artifacts' files. */
export interface ArtifactFileChange {
  readonly taskId: string
  readonly path: string
  readonly file: ArtifactFileState
}

const COLUMNS = 'task_id, path, title, added_at, updated_at, modified_at, missing'

function parseArtifact(raw: unknown): Artifact {
  const row = new Row('artifacts', raw)
  return {
    taskId: row.text('task_id'),
    path: row.text('path'),
    title: row.text('title'),
    addedAt: row.integer('added_at'),
    updatedAt: row.integer('updated_at'),
    modifiedAt: row.nullableInteger('modified_at'),
    missing: row.flag('missing'),
  }
}

/**
 * Declares a file as one of a task's artifacts. A path it already has keeps its place, and what was seen of its file,
 * and takes the new title. Answers with the artifact as it now is.
 */
export function addArtifact(db: Database, { taskId, path, title }: NewArtifact, now: EpochMs = Date.now()): Artifact {
  const raw: unknown = db
    .prepare(
      `INSERT INTO artifacts (task_id, path, title, added_at, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (task_id, path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
      RETURNING ${COLUMNS}`,
    )
    .get(taskId, path, title, now, now)
  return parseArtifact(raw)
}

/**
 * Records what was seen of an artifact's file: when it last changed, or that it's gone, keeping its last known time.
 * Answers whether that changed anything: false when it's as recorded, or not one of the task's artifacts.
 */
export function setArtifactFile(db: Database, { taskId, path, file }: ArtifactFileChange): boolean {
  const statement = file.missing
    ? db.prepare('UPDATE artifacts SET missing = 1 WHERE task_id = ? AND path = ? AND missing = 0').bind(taskId, path)
    : db
        .prepare(
          `UPDATE artifacts SET modified_at = ?, missing = 0
          WHERE task_id = ? AND path = ? AND (missing = 1 OR modified_at IS NOT ?)`,
        )
        .bind(Math.round(file.modifiedAt), taskId, path, Math.round(file.modifiedAt))
  return statement.run().changes > 0
}

/** Removes one of a task's artifacts (the file stays). Answers whether it was one. */
export function removeArtifact(db: Database, taskId: string, path: string): boolean {
  return db.prepare('DELETE FROM artifacts WHERE task_id = ? AND path = ?').run(taskId, path).changes > 0
}

/** A task's artifacts, in the order they were first declared. */
export function listArtifacts(db: Database, taskId: string): Artifact[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE task_id = ? ORDER BY added_at, rowid`)
    .all(taskId)
    .map(parseArtifact)
}
