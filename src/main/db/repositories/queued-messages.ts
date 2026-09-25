import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { MessageRole, type EpochMs, type Message, type QueuedMessage } from '../../../shared/domain'
import type { ImageData, ImageRef } from '../../../shared/images'
import { addImages, ImageOwnerKind, imageRefsByOwner, imageRefsOf, moveQueuedImages } from './images'
import { appendMessage } from './messages'
import { Row } from './rows'

export interface NewQueuedMessage {
  readonly taskId: string
  readonly body: string
  /** The images pasted into it, in order; none unless given. */
  readonly images?: readonly ImageData[] | undefined
}

const COLUMNS = 'id, task_id, body, created_at'

function parseQueuedMessage(raw: unknown, images: (id: string) => ImageRef[]): QueuedMessage {
  const row = new Row('queued_messages', raw)
  const id = row.text('id')
  return {
    id,
    taskId: row.text('task_id'),
    body: row.text('body'),
    createdAt: row.integer('created_at'),
    images: images(id),
  }
}

/** Adds a message to the end of its task's queue, with its images. */
export function appendQueuedMessage(db: Database, input: NewQueuedMessage, now: EpochMs = Date.now()): QueuedMessage {
  const { images = [], ...fields } = input
  const id = randomUUID()
  return db.transaction(() => {
    db.prepare(
      `INSERT INTO queued_messages (id, task_id, seq, body, created_at)
      VALUES (@id, @taskId, (SELECT COALESCE(MAX(seq), 0) + 1 FROM queued_messages WHERE task_id = @taskId), @body,
        @createdAt)`,
    ).run({ id, ...fields, createdAt: now })
    const refs = addImages(
      db,
      { taskId: fields.taskId, owner: { kind: ImageOwnerKind.QueuedMessage, id }, images },
      now,
    )
    return { id, ...fields, createdAt: now, images: refs }
  })()
}

/** A task's queue, in the order it will be delivered. */
export function listQueuedMessages(db: Database, taskId: string): QueuedMessage[] {
  const images = imageRefsByOwner(db, taskId, ImageOwnerKind.QueuedMessage)
  return db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE task_id = ? ORDER BY seq`)
    .all(taskId)
    .map((row) => parseQueuedMessage(row, (id) => images.get(id) ?? []))
}

/** A queued message by id, or undefined when it isn't queued (any more). */
export function getQueuedMessage(db: Database, id: string): QueuedMessage | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE id = ?`).get(id)
  return row === undefined
    ? undefined
    : parseQueuedMessage(row, (owner) => imageRefsOf(db, { kind: ImageOwnerKind.QueuedMessage, id: owner }))
}

/** Changes a queued message's text, keeping its place. Undefined when it isn't queued. */
export function updateQueuedMessage(db: Database, id: string, body: string): QueuedMessage | undefined {
  db.prepare('UPDATE queued_messages SET body = ? WHERE id = ?').run(body, id)
  return getQueuedMessage(db, id)
}

/** Removes a message from its queue. False when it wasn't queued. */
export function deleteQueuedMessage(db: Database, id: string): boolean {
  return db.prepare('DELETE FROM queued_messages WHERE id = ?').run(id).changes > 0
}

/**
 * Delivers a task's queue: each queued message, in order, becomes a user message of `turn` in the chat log, with its
 * images, and the queue is emptied. Answers with the messages delivered.
 */
export function takeQueuedMessages(db: Database, taskId: string, turn: number, now: EpochMs = Date.now()): Message[] {
  return db.transaction(() => {
    const messages = listQueuedMessages(db, taskId).map((queued) => {
      const message = appendMessage(db, { taskId, role: MessageRole.User, body: queued.body, turn }, now)
      moveQueuedImages(db, queued.id, message.id)
      return { ...message, images: queued.images }
    })
    db.prepare('DELETE FROM queued_messages WHERE task_id = ?').run(taskId)
    return messages
  })()
}
