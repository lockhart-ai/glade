import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { MessageRole, type EpochMs, type Message, type TurnSummary } from '../../../shared/domain'
import { Row } from './rows'

export interface NewMessage {
  readonly taskId: string
  readonly role: MessageRole
  readonly body: string
  readonly turn: number
  /** The agent's final reply's turn summary; none unless given. */
  readonly summary?: TurnSummary | undefined
}

const MESSAGE_ROLES = Object.values(MessageRole)

const COLUMNS = 'id, task_id, role, body, turn, created_at, duration_ms, files_changed, lines_added, lines_removed'

/** A reply's summary, which it has exactly when `files_changed` is set. */
function parseSummary(row: Row): TurnSummary | null {
  const filesChanged = row.nullableInteger('files_changed')
  if (filesChanged === null) return null
  return {
    durationMs: row.nullableInteger('duration_ms'),
    filesChanged,
    linesAdded: row.integer('lines_added'),
    linesRemoved: row.integer('lines_removed'),
  }
}

function parseMessage(raw: unknown): Message {
  const row = new Row('messages', raw)
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    role: row.oneOf('role', MESSAGE_ROLES),
    body: row.text('body'),
    turn: row.integer('turn'),
    createdAt: row.integer('created_at'),
    summary: parseSummary(row),
  }
}

/** Appends a message to the end of its task's chat log. */
export function appendMessage(db: Database, input: NewMessage, now: EpochMs = Date.now()): Message {
  const { summary = null, ...fields } = input
  const message: Message = { id: randomUUID(), ...fields, createdAt: now, summary }
  db.prepare(
    `INSERT INTO messages (${COLUMNS}, seq)
    VALUES (@id, @taskId, @role, @body, @turn, @createdAt, @durationMs, @filesChanged, @linesAdded, @linesRemoved,
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE task_id = @taskId))`,
  ).run({
    id: message.id,
    ...fields,
    createdAt: now,
    durationMs: summary?.durationMs ?? null,
    filesChanged: summary?.filesChanged ?? null,
    linesAdded: summary?.linesAdded ?? null,
    linesRemoved: summary?.linesRemoved ?? null,
  })
  return message
}

/** A task's chat log, in the order it was appended. */
export function listMessages(db: Database, taskId: string): Message[] {
  return db.prepare(`SELECT ${COLUMNS} FROM messages WHERE task_id = ? ORDER BY seq`).all(taskId).map(parseMessage)
}

/** The turn of a task's latest message: its number of turns so far, or 0 before its first message. */
export function lastTurn(db: Database, taskId: string): number {
  const turn: unknown = db.prepare('SELECT COALESCE(MAX(turn), 0) FROM messages WHERE task_id = ?').pluck().get(taskId)
  return typeof turn === 'number' ? turn : 0
}
