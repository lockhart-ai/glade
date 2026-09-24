import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import type { EpochMs, QueuedMessage } from '../../../shared/domain'
import { Row } from './rows'

export interface NewQueuedMessage {
  readonly taskId: string
  readonly body: string
}

const COLUMNS = 'id, task_id, body, created_at'

function parseQueuedMessage(raw: unknown): QueuedMessage {
  const row = new Row('queued_messages', raw)
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    body: row.text('body'),
    createdAt: row.integer('created_at'),
  }
}

/** Adds a message to the end of its task's queue. */
export function appendQueuedMessage(db: Database, input: NewQueuedMessage, now: EpochMs = Date.now()): QueuedMessage {
  const message: QueuedMessage = { id: randomUUID(), ...input, createdAt: now }
  db.prepare(
    `INSERT INTO queued_messages (id, task_id, seq, body, created_at)
    VALUES (@id, @taskId, (SELECT COALESCE(MAX(seq), 0) + 1 FROM queued_messages WHERE task_id = @taskId), @body,
      @createdAt)`,
  ).run(message)
  return message
}

/** A task's queue, in the order it will be delivered. */
export function listQueuedMessages(db: Database, taskId: string): QueuedMessage[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE task_id = ? ORDER BY seq`)
    .all(taskId)
    .map(parseQueuedMessage)
}

/** A queued message by id, or undefined when it isn't queued (any more). */
export function getQueuedMessage(db: Database, id: string): QueuedMessage | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM queued_messages WHERE id = ?`).get(id)
  return row === undefined ? undefined : parseQueuedMessage(row)
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

/** Empties a task's queue, answering with what it held, in order: the messages to deliver. */
export function takeQueuedMessages(db: Database, taskId: string): QueuedMessage[] {
  return db.transaction(() => {
    const queued = listQueuedMessages(db, taskId)
    db.prepare('DELETE FROM queued_messages WHERE task_id = ?').run(taskId)
    return queued
  })()
}
