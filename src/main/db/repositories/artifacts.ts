import type { Database } from 'better-sqlite3'
import {
  ArtifactKind,
  type Artifact,
  type ArtifactRef,
  type EpochMs,
  type FileArtifact,
  type LinkArtifact,
} from '../../../shared/domain'
import { Row } from './rows'

/** An artifact to declare: which file of which task, and what to call it. */
export interface NewArtifact {
  readonly taskId: string
  /** Relative to the task's workspace root. */
  readonly path: string
  readonly title: string
}

/** A link artifact to declare (#407): which page, for which task, and what to call it. */
export interface NewLinkArtifact {
  readonly taskId: string
  /** Its normalised address (`checkArtifactUrl`). */
  readonly url: string
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

const COLUMNS = 'task_id, kind, path, url, title, added_at, updated_at, modified_at, missing'

const KINDS = Object.values(ArtifactKind)

function parseArtifact(raw: unknown): Artifact {
  const row = new Row('artifacts', raw)
  const base = {
    taskId: row.text('task_id'),
    title: row.text('title'),
    addedAt: row.integer('added_at'),
    updatedAt: row.integer('updated_at'),
  }
  const kind = row.oneOf('kind', KINDS)
  switch (kind) {
    case ArtifactKind.File:
      return {
        kind,
        ...base,
        path: row.text('path'),
        modifiedAt: row.nullableInteger('modified_at'),
        missing: row.flag('missing'),
      }
    case ArtifactKind.Link:
      return { kind, ...base, url: row.text('url') }
  }
}

/** A row that's a file artifact: `RETURNING` from a statement that only touches files. */
function parseFileArtifact(raw: unknown): FileArtifact {
  return parseArtifact(raw) as FileArtifact
}

/** A row that's a link artifact: `RETURNING` from a statement that only touches links. */
function parseLinkArtifact(raw: unknown): LinkArtifact {
  return parseArtifact(raw) as LinkArtifact
}

/**
 * Declares a file as one of a task's artifacts. A path it already has keeps its place, and what was seen of its file,
 * and takes the new title. Answers with the artifact as it now is.
 */
export function addArtifact(
  db: Database,
  { taskId, path, title }: NewArtifact,
  now: EpochMs = Date.now(),
): FileArtifact {
  const raw: unknown = db
    .prepare(
      `INSERT INTO artifacts (task_id, kind, path, title, added_at, updated_at) VALUES (?, 'file', ?, ?, ?, ?)
      ON CONFLICT (task_id, path) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
      RETURNING ${COLUMNS}`,
    )
    .get(taskId, path, title, now, now)
  return parseFileArtifact(raw)
}

/**
 * Declares a link as one of a task's artifacts (#407). A URL it already has keeps its place and takes the new title.
 * Answers with the artifact as it now is.
 */
export function addLinkArtifact(
  db: Database,
  { taskId, url, title }: NewLinkArtifact,
  now: EpochMs = Date.now(),
): LinkArtifact {
  const raw: unknown = db
    .prepare(
      `INSERT INTO artifacts (task_id, kind, url, title, added_at, updated_at) VALUES (?, 'link', ?, ?, ?, ?)
      ON CONFLICT (task_id, url) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at
      RETURNING ${COLUMNS}`,
    )
    .get(taskId, url, title, now, now)
  return parseLinkArtifact(raw)
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

/** A change to one of a task's artifacts: the file it points to (`newPath`, relative to the root) and its title. */
export interface ArtifactChange {
  readonly taskId: string
  /** Where it points now, relative to the task's workspace root. */
  readonly path: string
  /** Where it's to point, relative to the root: `path` itself to keep it. */
  readonly newPath: string
  readonly title: string
}

/** A change to one of a task's link artifacts: the page it points to (`newUrl`, normalised) and its title. */
export interface LinkArtifactChange {
  readonly taskId: string
  /** Where it points now. */
  readonly url: string
  /** Where it's to point: `url` itself to keep it. */
  readonly newUrl: string
  readonly title: string
}

/** The column, and the value in it, that a ref names its artifact by. */
function refColumn(ref: ArtifactRef): { readonly column: 'path' | 'url'; readonly value: string } {
  switch (ref.kind) {
    case ArtifactKind.File:
      return { column: 'path', value: ref.path }
    case ArtifactKind.Link:
      return { column: 'url', value: ref.url }
  }
}

/** One of a task's artifacts, by its ref (a file's path or a link's URL); undefined when it isn't one. */
export function getArtifact(db: Database, taskId: string, ref: ArtifactRef): Artifact | undefined {
  const { column, value } = refColumn(ref)
  const raw: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE task_id = ? AND ${column} = ?`)
    .get(taskId, value)
  return raw === undefined ? undefined : parseArtifact(raw)
}

/**
 * Points one of a task's artifacts at another file and gives it a title, keeping its place (when it was first
 * declared). What was seen of its file stays until it's looked at again. Answers with the artifact as it now is, or
 * undefined when `path` isn't one; `newPath` must not be another of the task's artifacts.
 */
export function changeArtifact(
  db: Database,
  { taskId, path, newPath, title }: ArtifactChange,
  now: EpochMs = Date.now(),
): FileArtifact | undefined {
  const raw: unknown = db
    .prepare(
      `UPDATE artifacts SET path = ?, title = ?, updated_at = ? WHERE task_id = ? AND path = ? RETURNING ${COLUMNS}`,
    )
    .get(newPath, title, now, taskId, path)
  return raw === undefined ? undefined : parseFileArtifact(raw)
}

/**
 * Points one of a task's link artifacts at another page and gives it a title, keeping its place. Answers with the
 * artifact as it now is, or undefined when `url` isn't one; `newUrl` must not be another of the task's artifacts.
 */
export function changeLinkArtifact(
  db: Database,
  { taskId, url, newUrl, title }: LinkArtifactChange,
  now: EpochMs = Date.now(),
): LinkArtifact | undefined {
  const raw: unknown = db
    .prepare(
      `UPDATE artifacts SET url = ?, title = ?, updated_at = ? WHERE task_id = ? AND url = ? RETURNING ${COLUMNS}`,
    )
    .get(newUrl, title, now, taskId, url)
  return raw === undefined ? undefined : parseLinkArtifact(raw)
}

/** Removes one of a task's artifacts, by its ref (a file stays where it is). Answers whether it was one. */
export function removeArtifact(db: Database, taskId: string, ref: ArtifactRef): boolean {
  const { column, value } = refColumn(ref)
  return db.prepare(`DELETE FROM artifacts WHERE task_id = ? AND ${column} = ?`).run(taskId, value).changes > 0
}

/** A task's artifacts, files and links, in the order they were first declared. */
export function listArtifacts(db: Database, taskId: string): Artifact[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE task_id = ? ORDER BY added_at, rowid`)
    .all(taskId)
    .map(parseArtifact)
}

/** A task's file artifacts, in the order they were first declared. */
export function listFileArtifacts(db: Database, taskId: string): FileArtifact[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM artifacts WHERE task_id = ? AND kind = 'file' ORDER BY added_at, rowid`)
    .all(taskId)
    .map(parseFileArtifact)
}
