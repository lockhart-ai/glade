// The files attached to messages (migration 46, #396): each belongs to one message in the chat log, one waiting in the
// queue or a task's input draft, in the order it was attached — exactly as pasted blocks are kept (`./pasted-blocks`).
// Only the copy's name, path, size and kind are kept here; the copy itself is in the workspace
// (`../../attachments/attachments.ts`).
import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { AttachedFileKind, type AttachedFile } from '../../../shared/attachedFiles'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** What an attached file can belong to. */
export enum AttachedFileOwnerKind {
  Message = 'message',
  QueuedMessage = 'queued_message',
  /** A task's input draft, by the task's id. */
  Draft = 'draft',
}

/** The message, queued message or draft an attached file belongs to. */
export interface AttachedFileOwner {
  readonly kind: AttachedFileOwnerKind
  readonly id: string
}

/** Files to store with a message, in the order they were attached. */
export interface NewAttachedFiles {
  readonly taskId: string
  readonly owner: AttachedFileOwner
  readonly files: readonly AttachedFile[]
}

const KINDS = Object.values(AttachedFileKind)

const COLUMNS = 'name, path, size, kind'

/** The column that names an owner of its kind. */
function ownerColumn(kind: AttachedFileOwnerKind): string {
  switch (kind) {
    case AttachedFileOwnerKind.Message:
      return 'message_id'
    case AttachedFileOwnerKind.QueuedMessage:
      return 'queued_message_id'
    case AttachedFileOwnerKind.Draft:
      return 'draft_task_id'
  }
}

function parseFile(raw: unknown): AttachedFile {
  const row = new Row('attached_files', raw)
  return { name: row.text('name'), path: row.text('path'), size: row.integer('size'), kind: row.oneOf('kind', KINDS) }
}

/** Stores a message's attached files, in order, answering with them (as they're kept: `AttachedFile`, unchanged). */
export function addAttachedFiles(db: Database, input: NewAttachedFiles, now: EpochMs = Date.now()): AttachedFile[] {
  const insert = db.prepare(
    `INSERT INTO attached_files (id, task_id, ${ownerColumn(input.owner.kind)}, position, ${COLUMNS}, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  return input.files.map((file, position) => {
    insert.run(randomUUID(), input.taskId, input.owner.id, position, file.name, file.path, file.size, file.kind, now)
    return file
  })
}

/** A message's attached files, in order. */
export function attachedFilesOf(db: Database, owner: AttachedFileOwner): AttachedFile[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM attached_files WHERE ${ownerColumn(owner.kind)} = ? ORDER BY position`)
    .all(owner.id)
    .map(parseFile)
}

/** The attached files of every message of a task of one kind, by owner id, each in order. */
export function attachedFilesByOwner(
  db: Database,
  taskId: string,
  kind: AttachedFileOwnerKind,
): Map<string, AttachedFile[]> {
  const column = ownerColumn(kind)
  const byOwner = new Map<string, AttachedFile[]>()
  const rows = db
    .prepare(
      `SELECT ${COLUMNS}, ${column} AS owner FROM attached_files WHERE task_id = ? AND ${column} IS NOT NULL
      ORDER BY position`,
    )
    .all(taskId)
  for (const raw of rows) {
    const owner = new Row('attached_files', raw).text('owner')
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), parseFile(raw)])
  }
  return byOwner
}

/** Moves a queued message's attached files to the message it was delivered as, keeping their order. */
export function moveQueuedAttachedFiles(db: Database, queuedMessageId: string, messageId: string): void {
  db.prepare('UPDATE attached_files SET message_id = ?, queued_message_id = NULL WHERE queued_message_id = ?').run(
    messageId,
    queuedMessageId,
  )
}

/** Whether a task's message, sent or queued, has the file at `path` attached: then its copy has to stay. */
export function isAttachedFileSent(db: Database, taskId: string, path: string): boolean {
  return (
    db
      .prepare('SELECT 1 FROM attached_files WHERE task_id = ? AND path = ? AND draft_task_id IS NULL LIMIT 1')
      .get(taskId, path) !== undefined
  )
}
