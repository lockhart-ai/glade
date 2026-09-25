import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  PermissionRequestState,
  type EpochMs,
  type PermissionRequest,
  type PermissionSuggestion,
  type ToolInput,
} from '../../../shared/domain'
import { permissionSuggestionsSchema } from '../../permissions/schema'
import { Row, RowError } from './rows'

/** A tool call to open a permission request for. */
export interface NewPermissionRequest {
  readonly taskId: string
  readonly turn: number
  readonly toolUseId: string
  readonly agentId: string | null
  readonly toolName: string
  readonly input: ToolInput
  readonly title: string | null
  readonly displayName: string | null
  readonly description: string | null
  readonly suggestions: readonly PermissionSuggestion[]
  readonly defaultToNo: boolean
  readonly suppressAlwaysAllowRule: boolean
}

/** How a permission request closes: allowed, denied (with your note, if any), or withdrawn without an answer. */
export type PermissionRequestClosing =
  | { readonly state: PermissionRequestState.Allowed }
  | { readonly state: PermissionRequestState.Denied; readonly note: string | null }
  | { readonly state: PermissionRequestState.Withdrawn }

const TABLE = 'permission_requests'
const COLUMNS = `id, task_id, turn, tool_use_id, agent_id, tool_name, input, title, display_name, description,
  suggestions, default_to_no, suppress_always_allow_rule, state, deny_note, created_at, closed_at`
const STATES = Object.values(PermissionRequestState)

function parsePermissionRequest(raw: unknown): PermissionRequest {
  const row = new Row(TABLE, raw)
  const suggestions = permissionSuggestionsSchema.safeParse(row.json('suggestions'))
  if (!suggestions.success) throw new RowError(TABLE, 'suggestions', z.prettifyError(suggestions.error))
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    turn: row.integer('turn'),
    toolUseId: row.text('tool_use_id'),
    agentId: row.nullableText('agent_id'),
    toolName: row.text('tool_name'),
    input: row.jsonObject('input'),
    title: row.nullableText('title'),
    displayName: row.nullableText('display_name'),
    description: row.nullableText('description'),
    suggestions: suggestions.data,
    defaultToNo: row.flag('default_to_no'),
    suppressAlwaysAllowRule: row.flag('suppress_always_allow_rule'),
    state: row.oneOf('state', STATES),
    denyNote: row.nullableText('deny_note'),
    createdAt: row.integer('created_at'),
    closedAt: row.nullableInteger('closed_at'),
  }
}

/** Opens a permission request for a tool call. */
export function appendPermissionRequest(
  db: Database,
  input: NewPermissionRequest,
  now: EpochMs = Date.now(),
): PermissionRequest {
  const request: PermissionRequest = {
    id: randomUUID(),
    ...input,
    state: PermissionRequestState.Open,
    denyNote: null,
    createdAt: now,
    closedAt: null,
  }
  db.prepare(
    `INSERT INTO ${TABLE} (${COLUMNS})
    VALUES (@id, @taskId, @turn, @toolUseId, @agentId, @toolName, @input, @title, @displayName, @description,
      @suggestions, @defaultToNo, @suppressAlwaysAllowRule, @state, NULL, @createdAt, NULL)`,
  ).run({
    ...request,
    input: JSON.stringify(request.input),
    suggestions: JSON.stringify(request.suggestions),
    defaultToNo: request.defaultToNo ? 1 : 0,
    suppressAlwaysAllowRule: request.suppressAlwaysAllowRule ? 1 : 0,
  })
  return request
}

export function getPermissionRequest(db: Database, id: string): PermissionRequest | undefined {
  const row: unknown = db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE id = ?`).get(id)
  return row === undefined ? undefined : parsePermissionRequest(row)
}

/** A task's permission requests, in the order they were made. */
export function listPermissionRequests(db: Database, taskId: string): PermissionRequest[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? ORDER BY created_at, rowid`)
    .all(taskId)
    .map(parsePermissionRequest)
}

/** A task's open permission requests, oldest first. */
export function listOpenPermissionRequests(db: Database, taskId: string): PermissionRequest[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? AND state = ? ORDER BY created_at, rowid`)
    .all(taskId, PermissionRequestState.Open)
    .map(parsePermissionRequest)
}

/**
 * Closes an open permission request: allowed, denied or withdrawn. Answers with it as it now is, or undefined when
 * there's no such request or it was already closed.
 */
export function closePermissionRequest(
  db: Database,
  id: string,
  closing: PermissionRequestClosing,
  now: EpochMs = Date.now(),
): PermissionRequest | undefined {
  const note = closing.state === PermissionRequestState.Denied ? closing.note : null
  const { changes } = db
    .prepare(`UPDATE ${TABLE} SET state = ?, deny_note = ?, closed_at = ? WHERE id = ? AND state = ?`)
    .run(closing.state, note, now, id, PermissionRequestState.Open)
  return changes === 0 ? undefined : getPermissionRequest(db, id)
}
