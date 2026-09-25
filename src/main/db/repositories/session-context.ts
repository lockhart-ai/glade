/**
 * What a task's agent session has been given of what Glade tells it (`session_context`, and
 * `../../agent/session-context`): Glade's instructions, and which version of the task's handoff note.
 */
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** What a task's agent session has been given. */
export interface SessionContext {
  /** Whether it has Glade's system prompt append: it started with it, or was sent it. */
  readonly instructions: boolean
  /** The version (`TaskHandoff.addedAt`) of the handoff note it has; null for none. */
  readonly handoffAt: EpochMs | null
}

/** What the task's session has been given, or undefined when nothing's recorded: Glade started it, with its prompt. */
export function getSessionContext(db: Database, taskId: string): SessionContext | undefined {
  const raw: unknown = db.prepare('SELECT instructions, handoff_at FROM session_context WHERE task_id = ?').get(taskId)
  if (raw === undefined) return undefined
  const row = new Row('session_context', raw)
  return { instructions: row.flag('instructions'), handoffAt: row.nullableInteger('handoff_at') }
}

/** Records what the task's session has now been given. */
export function setSessionContext(db: Database, taskId: string, context: SessionContext): void {
  db.prepare(
    `INSERT INTO session_context (task_id, instructions, handoff_at) VALUES (@taskId, @instructions, @handoffAt)
    ON CONFLICT (task_id) DO UPDATE SET instructions = excluded.instructions, handoff_at = excluded.handoff_at`,
  ).run({ taskId, instructions: context.instructions ? 1 : 0, handoffAt: context.handoffAt })
}
