import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { MessageRole, type EpochMs, type Message } from '../../../shared/domain'
import { Row } from './rows'

export interface NewMessage {
  readonly taskId: string
  readonly role: MessageRole
  readonly body: string
  readonly turn: number
}

const MESSAGE_ROLES = Object.values(MessageRole)

function parseMessage(raw: unknown): Message {
  const row = new Row('messages', raw)
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    role: row.oneOf('role', MESSAGE_ROLES),
    body: row.text('body'),
    turn: row.integer('turn'),
    createdAt: row.integer('created_at'),
  }
}

/** Appends a message to the end of its task's chat log. */
export function appendMessage(db: Database, input: NewMessage, now: EpochMs = Date.now()): Message {
  const message: Message = { id: randomUUID(), ...input, createdAt: now }
  db.prepare(
    `INSERT INTO messages (id, task_id, seq, role, body, turn, created_at)
    VALUES (@id, @taskId, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE task_id = @taskId), @role, @body,
      @turn, @createdAt)`,
  ).run(message)
  return message
}

/** A task's chat log, in the order it was appended. */
export function listMessages(db: Database, taskId: string): Message[] {
  return db
    .prepare('SELECT id, task_id, role, body, turn, created_at FROM messages WHERE task_id = ? ORDER BY seq')
    .all(taskId)
    .map(parseMessage)
}
