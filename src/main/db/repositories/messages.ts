import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { DividerKind, MessageRole, type EpochMs, type Message, type TurnSummary } from '../../../shared/domain'
import type { ImageData, ImageRef } from '../../../shared/images'
import { addImages, ImageOwnerKind, imageRefsByOwner } from './images'
import { Row } from './rows'

export interface NewMessage {
  readonly taskId: string
  readonly role: MessageRole
  readonly body: string
  readonly turn: number
  /** The agent's final reply's turn summary; none unless given. */
  readonly summary?: TurnSummary | undefined
  /** The images pasted into your message, in order; none unless given. */
  readonly images?: readonly ImageData[] | undefined
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

function parseMessage(raw: unknown, images: ReadonlyMap<string, ImageRef[]>): Message {
  const row = new Row('messages', raw)
  const id = row.text('id')
  return {
    id,
    taskId: row.text('task_id'),
    role: row.oneOf('role', MESSAGE_ROLES),
    body: row.text('body'),
    turn: row.integer('turn'),
    createdAt: row.integer('created_at'),
    summary: parseSummary(row),
    images: images.get(id) ?? [],
  }
}

/** Appends a message to the end of its task's chat log, with its images. */
export function appendMessage(db: Database, input: NewMessage, now: EpochMs = Date.now()): Message {
  const { summary = null, images = [], ...fields } = input
  const id = randomUUID()
  db.prepare(
    `INSERT INTO messages (${COLUMNS}, seq)
    VALUES (@id, @taskId, @role, @body, @turn, @createdAt, @durationMs, @filesChanged, @linesAdded, @linesRemoved,
      (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE task_id = @taskId))`,
  ).run({
    id,
    ...fields,
    createdAt: now,
    durationMs: summary?.durationMs ?? null,
    filesChanged: summary?.filesChanged ?? null,
    linesAdded: summary?.linesAdded ?? null,
    linesRemoved: summary?.linesRemoved ?? null,
  })
  const refs = addImages(db, { taskId: fields.taskId, owner: { kind: ImageOwnerKind.Message, id }, images }, now)
  return { id, ...fields, createdAt: now, summary, images: refs }
}

/** A task's chat log, in the order it was appended. */
export function listMessages(db: Database, taskId: string): Message[] {
  const images = imageRefsByOwner(db, taskId, ImageOwnerKind.Message)
  return db
    .prepare(`SELECT ${COLUMNS} FROM messages WHERE task_id = ? ORDER BY seq`)
    .all(taskId)
    .map((row) => parseMessage(row, images))
}

/**
 * A task's last turn: its number of turns so far, or 0 before its first. A turn has its number once its first message
 * or its turn divider is saved: a turn the agent started on its own has no message of yours, and none of its own until
 * it replies, so its turn divider in the tool log is what numbers it.
 */
export function lastTurn(db: Database, taskId: string): number {
  const turn: unknown = db
    .prepare(
      `SELECT COALESCE(MAX(turn), 0) FROM (
        SELECT turn FROM messages WHERE task_id = @taskId
        UNION ALL
        SELECT turn FROM tool_events WHERE task_id = @taskId AND kind = 'divider' AND divider_kind = @turnDivider
      )`,
    )
    .pluck()
    .get({ taskId, turnDivider: DividerKind.Turn })
  return typeof turn === 'number' ? turn : 0
}

/**
 * When a task's turn started: its first user message's `createdAt`, or, for a turn the agent started on its own, its
 * turn divider's; null when it has neither.
 */
export function turnStartedAt(db: Database, taskId: string, turn: number): EpochMs | null {
  const startedAt: unknown = db
    .prepare(
      `SELECT COALESCE(
        (SELECT MIN(created_at) FROM messages WHERE task_id = @taskId AND turn = @turn AND role = @user),
        (SELECT MIN(created_at) FROM tool_events
          WHERE task_id = @taskId AND turn = @turn AND kind = 'divider' AND divider_kind = @turnDivider)
      )`,
    )
    .pluck()
    .get({ taskId, turn, user: MessageRole.User, turnDivider: DividerKind.Turn })
  return typeof startedAt === 'number' ? startedAt : null
}

/**
 * The first message you sent the task whose SDK session is `sessionId`, or undefined when no task has that session or
 * it has no message of yours.
 */
export function firstUserMessageOfSession(db: Database, sessionId: string): string | undefined {
  const body: unknown = db
    .prepare(
      `SELECT messages.body FROM messages JOIN tasks ON tasks.id = messages.task_id
      WHERE tasks.session_id = ? AND messages.role = ? ORDER BY messages.seq LIMIT 1`,
    )
    .pluck()
    .get(sessionId, MessageRole.User)
  return typeof body === 'string' ? body : undefined
}
