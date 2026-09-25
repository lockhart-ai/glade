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

/**
 * How far a permission request the app quit on has got (`docs/decisions.md`, "Per-call permission review"): its call is
 * gone, so its decision goes to the agent in a message instead. A request a call waits on has none (null).
 */
export enum RestartDelivery {
  /** The app quit on it: its decision, once you've made it, is still to go to the agent. */
  Pending = 'pending',
  /**
   * Its decision went to the agent. An allowed call the agent makes again with the same input goes ahead once without
   * asking, until the turn it was delivered in ends.
   */
  Delivered = 'delivered',
  /** Nothing is left to do for it. */
  Settled = 'settled',
}

const DELIVERIES = Object.values(RestartDelivery)

/** Every open permission request, in any task, oldest first: at launch, the ones the app quit on. */
export function listAllOpenPermissionRequests(db: Database): PermissionRequest[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE state = ? ORDER BY created_at, rowid`)
    .all(PermissionRequestState.Open)
    .map(parsePermissionRequest)
}

/** How far a request the app quit on has got; null for a request a call waits on, or no such request. */
export function restartDeliveryOf(db: Database, id: string): RestartDelivery | null {
  const raw: unknown = db.prepare(`SELECT restart_delivery FROM ${TABLE} WHERE id = ?`).get(id)
  if (raw === undefined) return null
  const row = new Row(TABLE, raw)
  return row.nullableText('restart_delivery') === null ? null : row.oneOf('restart_delivery', DELIVERIES)
}

/** A task's requests the app quit on that have got as far as `delivery`, in the order they were made. */
export function listRestartRequests(db: Database, taskId: string, delivery: RestartDelivery): PermissionRequest[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE task_id = ? AND restart_delivery = ? ORDER BY created_at, rowid`)
    .all(taskId, delivery)
    .map(parsePermissionRequest)
}

/** The ids of the tasks with a request the app quit on at `delivery`, in the order they were created. */
export function listTasksWithRestartRequests(db: Database, delivery: RestartDelivery): string[] {
  return db
    .prepare(
      `SELECT task_id FROM ${TABLE} JOIN tasks ON tasks.id = task_id WHERE restart_delivery = ?
      GROUP BY task_id ORDER BY MIN(tasks.created_at), task_id`,
    )
    .all(delivery)
    .map((raw) => new Row(TABLE, raw).text('task_id'))
}

/** Records how far the requests have got. */
export function setRestartDelivery(db: Database, ids: readonly string[], delivery: RestartDelivery): void {
  const update = db.prepare(`UPDATE ${TABLE} SET restart_delivery = ? WHERE id = ?`)
  db.transaction(() => {
    for (const id of ids) update.run(delivery, id)
  })()
}
