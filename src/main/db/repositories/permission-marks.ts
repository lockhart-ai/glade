import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  PermissionMarkKind,
  type EpochMs,
  type PermissionMark,
  type PermissionMarkOutcome,
} from '../../../shared/domain'
import { permissionMarkOutcomeSchema } from '../../permissions/schema'
import { Row, RowError } from './rows'

/** A mark to record: the call it's on, and what a rule decided of it. */
export interface NewPermissionMark {
  readonly taskId: string
  readonly toolUseId: string
  readonly outcome: PermissionMarkOutcome
}

const TABLE = 'permission_marks'
const COLUMNS = 'task_id, tool_use_id, outcome, created_at'

function parsePermissionMark(raw: unknown): PermissionMark {
  const row = new Row(TABLE, raw)
  const outcome = permissionMarkOutcomeSchema.safeParse(row.json('outcome'))
  if (!outcome.success) throw new RowError(TABLE, 'outcome', z.prettifyError(outcome.error))
  return {
    taskId: row.text('task_id'),
    toolUseId: row.text('tool_use_id'),
    outcome: outcome.data,
    createdAt: row.integer('created_at'),
  }
}

/** A tool call's mark, or undefined when no rule decided anything of it. */
export function getPermissionMark(db: Database, taskId: string, toolUseId: string): PermissionMark | undefined {
  const raw: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? AND tool_use_id = ?`)
    .get(taskId, toolUseId)
  return raw === undefined ? undefined : parsePermissionMark(raw)
}

/**
 * Records what a rule decided of a tool call: one mark per call, a later one replacing an earlier one's outcome (it
 * keeps when it was first marked). Answers with the mark as it now is, or undefined when it already said just that.
 */
export function setPermissionMark(
  db: Database,
  { taskId, toolUseId, outcome }: NewPermissionMark,
  now: EpochMs = Date.now(),
): PermissionMark | undefined {
  const saved = JSON.stringify(outcome)
  const { changes } = db
    .prepare(
      `INSERT INTO ${TABLE} (${COLUMNS}) VALUES (?, ?, ?, ?)
      ON CONFLICT (task_id, tool_use_id) DO UPDATE SET outcome = excluded.outcome WHERE outcome <> excluded.outcome`,
    )
    .run(taskId, toolUseId, saved, now)
  return changes === 0 ? undefined : getPermissionMark(db, taskId, toolUseId)
}

/** A task's marks, in the order their calls were first marked. */
export function listPermissionMarks(db: Database, taskId: string): PermissionMark[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? ORDER BY created_at, rowid`)
    .all(taskId)
    .map(parsePermissionMark)
}

/**
 * The task's latest call the sandbox blocked that doesn't say what of yet: the command an agent's `request_access`
 * names the path of. Undefined when there's none.
 */
export function latestUnnamedBlock(db: Database, taskId: string): PermissionMark | undefined {
  return listPermissionMarks(db, taskId).findLast(
    ({ outcome }) => outcome.kind === PermissionMarkKind.Blocked && outcome.ask === null,
  )
}
