import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import { z } from 'zod'
import {
  PermissionRequestState,
  type EpochMs,
  type PermissionRequest,
  type PermissionRule,
  type PermissionSuggestion,
  type ToolInput,
} from '../../../shared/domain'
import { permissionRuleSchema, permissionSuggestionsSchema } from '../../permissions/schema'
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

/**
 * How a permission request closes: allowed (with the rule it was allowed for the task with, if it was), denied (with
 * your note, if any), or withdrawn without an answer.
 */
export type PermissionRequestClosing =
  | { readonly state: PermissionRequestState.Allowed; readonly grantedRule?: PermissionRule }
  | { readonly state: PermissionRequestState.Denied; readonly note: string | null }
  | { readonly state: PermissionRequestState.Withdrawn }

const TABLE = 'permission_requests'
const COLUMNS = `id, task_id, turn, tool_use_id, agent_id, tool_name, input, title, display_name, description,
  suggestions, default_to_no, suppress_always_allow_rule, state, deny_note, granted_rule, created_at, closed_at`
const STATES = Object.values(PermissionRequestState)

function parsePermissionRequest(raw: unknown): PermissionRequest {
  const row = new Row(TABLE, raw)
  const suggestions = permissionSuggestionsSchema.safeParse(row.json('suggestions'))
  if (!suggestions.success) throw new RowError(TABLE, 'suggestions', z.prettifyError(suggestions.error))
  return {
    ...parsedRow(row),
    suggestions: suggestions.data,
    grantedRule: grantedRule(row),
  }
}

/** The rule a request was allowed for the task with, or null. */
function grantedRule(row: Row): PermissionRule | null {
  if (row.nullableText('granted_rule') === null) return null
  const rule = permissionRuleSchema.safeParse(row.json('granted_rule'))
  if (!rule.success) throw new RowError(TABLE, 'granted_rule', z.prettifyError(rule.error))
  return rule.data
}

/** A request's columns but its JSON ones. */
function parsedRow(row: Row): Omit<PermissionRequest, 'suggestions' | 'grantedRule'> {
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
    grantedRule: null,
    createdAt: now,
    closedAt: null,
  }
  db.prepare(
    `INSERT INTO ${TABLE} (${COLUMNS})
    VALUES (@id, @taskId, @turn, @toolUseId, @agentId, @toolName, @input, @title, @displayName, @description,
      @suggestions, @defaultToNo, @suppressAlwaysAllowRule, @state, NULL, NULL, @createdAt, NULL)`,
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
  const rule = closing.state === PermissionRequestState.Allowed ? (closing.grantedRule ?? null) : null
  const { changes } = db
    .prepare(`UPDATE ${TABLE} SET state = ?, deny_note = ?, granted_rule = ?, closed_at = ? WHERE id = ? AND state = ?`)
    .run(closing.state, note, rule === null ? null : JSON.stringify(rule), now, id, PermissionRequestState.Open)
  return changes === 0 ? undefined : getPermissionRequest(db, id)
}
