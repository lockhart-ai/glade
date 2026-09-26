/**
 * What a task's agent session has been given of what Glade tells it (`session_context`, and
 * `../../agent/session-context`): Glade's instructions, the ones added to them since, and which version of the task's
 * handoff note.
 */
import type { Database } from 'better-sqlite3'
import type { EpochMs } from '../../../shared/domain'
import { Row } from './rows'

/** What a task's agent session has been given. */
export interface SessionContext {
  /** Whether it has Glade's system prompt append: it started with it, or was sent it. */
  readonly instructions: boolean
  /**
   * How many of the instructions Glade added to its prompt later (`INSTRUCTION_UPDATES`, oldest first) it has: it
   * started with them, or was sent them.
   */
  readonly instructionUpdates: number
  /** The version (`TaskHandoff.addedAt`) of the handoff note it has; null for none. */
  readonly handoffAt: EpochMs | null
}

/** What the task's session has been given, or undefined when nothing's recorded: Glade started it, with its prompt. */
export function getSessionContext(db: Database, taskId: string): SessionContext | undefined {
  const raw: unknown = db
    .prepare('SELECT instructions, instruction_updates, handoff_at FROM session_context WHERE task_id = ?')
    .get(taskId)
  if (raw === undefined) return undefined
  const row = new Row('session_context', raw)
  return {
    instructions: row.flag('instructions'),
    instructionUpdates: row.integer('instruction_updates'),
    handoffAt: row.nullableInteger('handoff_at'),
  }
}

/** Records what the task's session has now been given. */
export function setSessionContext(db: Database, taskId: string, context: SessionContext): void {
  db.prepare(
    `INSERT INTO session_context (task_id, instructions, instruction_updates, handoff_at)
    VALUES (@taskId, @instructions, @instructionUpdates, @handoffAt)
    ON CONFLICT (task_id) DO UPDATE SET instructions = excluded.instructions,
      instruction_updates = excluded.instruction_updates, handoff_at = excluded.handoff_at`,
  ).run({
    taskId,
    instructions: context.instructions ? 1 : 0,
    instructionUpdates: context.instructionUpdates,
    handoffAt: context.handoffAt,
  })
}
