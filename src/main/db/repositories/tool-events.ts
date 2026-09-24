import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  DividerKind,
  ToolCallState,
  ToolEventKind,
  type DividerEvent,
  type EpochMs,
  type NarrationEvent,
  type ToolCallEvent,
  type ToolEvent,
  type ToolEventBase,
  type ToolInput,
} from '../../../shared/domain'
import { Row } from './rows'

/** Where a new tool log entry goes. */
export interface NewToolEventBase {
  readonly taskId: string
  readonly turn: number
}

export interface NewNarration extends NewToolEventBase {
  readonly text: string
}

/** A tool call as its `tool_use` arrives: it starts running, with no output yet. */
export interface NewToolCall extends NewToolEventBase {
  readonly name: string
  readonly input: ToolInput
  readonly toolUseId: string
  readonly parentToolUseId: string | null
}

export interface NewDivider extends NewToolEventBase {
  readonly dividerKind: DividerKind
}

/** A tool call's result, to fill in on the call with the same `toolUseId`. */
export interface ToolCallResult {
  readonly taskId: string
  readonly toolUseId: string
  readonly state: ToolCallState
  readonly output: string
}

/** A `tool_events` row's columns, as named parameters. The ones a variant doesn't use are null. */
interface ToolEventParams {
  readonly id: string
  readonly taskId: string
  readonly kind: ToolEventKind
  readonly turn: number
  readonly createdAt: EpochMs
  readonly text: string | null
  readonly toolName: string | null
  readonly toolInput: string | null
  readonly toolOutput: string | null
  readonly toolState: ToolCallState | null
  readonly toolUseId: string | null
  readonly parentToolUseId: string | null
  readonly dividerKind: DividerKind | null
}

const COLUMNS = `id, task_id, kind, turn, created_at, text, tool_name, tool_input, tool_output, tool_state, tool_use_id,
  parent_tool_use_id, divider_kind`

const KINDS = Object.values(ToolEventKind)
const TOOL_CALL_STATES = Object.values(ToolCallState)
const DIVIDER_KINDS = Object.values(DividerKind)

function toParams(event: ToolEvent): ToolEventParams {
  const base = {
    id: event.id,
    taskId: event.taskId,
    kind: event.kind,
    turn: event.turn,
    createdAt: event.createdAt,
    text: null,
    toolName: null,
    toolInput: null,
    toolOutput: null,
    toolState: null,
    toolUseId: null,
    parentToolUseId: null,
    dividerKind: null,
  }
  switch (event.kind) {
    case ToolEventKind.Narration:
      return { ...base, text: event.text }
    case ToolEventKind.ToolCall:
      return {
        ...base,
        toolName: event.name,
        toolInput: JSON.stringify(event.input),
        toolOutput: event.output,
        toolState: event.state,
        toolUseId: event.toolUseId,
        parentToolUseId: event.parentToolUseId,
      }
    case ToolEventKind.Divider:
      return { ...base, dividerKind: event.dividerKind }
  }
}

function parseBase(row: Row): ToolEventBase {
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    turn: row.integer('turn'),
    createdAt: row.integer('created_at'),
  }
}

function parseToolCall(row: Row): ToolCallEvent {
  return {
    ...parseBase(row),
    kind: ToolEventKind.ToolCall,
    name: row.text('tool_name'),
    input: row.jsonObject('tool_input'),
    output: row.nullableText('tool_output'),
    state: row.oneOf('tool_state', TOOL_CALL_STATES),
    toolUseId: row.text('tool_use_id'),
    parentToolUseId: row.nullableText('parent_tool_use_id'),
  }
}

function parseToolEvent(raw: unknown): ToolEvent {
  const row = new Row('tool_events', raw)
  const kind = row.oneOf('kind', KINDS)
  switch (kind) {
    case ToolEventKind.Narration:
      return { ...parseBase(row), kind, text: row.text('text') }
    case ToolEventKind.ToolCall:
      return parseToolCall(row)
    case ToolEventKind.Divider:
      return { ...parseBase(row), kind, dividerKind: row.oneOf('divider_kind', DIVIDER_KINDS) }
  }
}

/** Appends an entry to the end of its task's tool log. */
function append(db: Database, event: ToolEvent): void {
  db.prepare(
    `INSERT INTO tool_events (seq, ${COLUMNS})
    VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_events WHERE task_id = @taskId), @id, @taskId, @kind, @turn,
      @createdAt, @text, @toolName, @toolInput, @toolOutput, @toolState, @toolUseId, @parentToolUseId, @dividerKind)`,
  ).run(toParams(event))
}

export function appendNarration(db: Database, input: NewNarration, now: EpochMs = Date.now()): NarrationEvent {
  const event: NarrationEvent = {
    kind: ToolEventKind.Narration,
    id: randomUUID(),
    taskId: input.taskId,
    turn: input.turn,
    createdAt: now,
    text: input.text,
  }
  append(db, event)
  return event
}

export function appendToolCall(db: Database, input: NewToolCall, now: EpochMs = Date.now()): ToolCallEvent {
  const event: ToolCallEvent = {
    kind: ToolEventKind.ToolCall,
    id: randomUUID(),
    taskId: input.taskId,
    turn: input.turn,
    createdAt: now,
    name: input.name,
    input: input.input,
    output: null,
    state: ToolCallState.Running,
    toolUseId: input.toolUseId,
    parentToolUseId: input.parentToolUseId,
  }
  append(db, event)
  return event
}

export function appendDivider(db: Database, input: NewDivider, now: EpochMs = Date.now()): DividerEvent {
  const event: DividerEvent = {
    kind: ToolEventKind.Divider,
    id: randomUUID(),
    taskId: input.taskId,
    turn: input.turn,
    createdAt: now,
    dividerKind: input.dividerKind,
  }
  append(db, event)
  return event
}

/** A task's tool log, in the order it was appended. */
export function listToolEvents(db: Database, taskId: string): ToolEvent[] {
  return db.prepare(`SELECT ${COLUMNS} FROM tool_events WHERE task_id = ? ORDER BY seq`).all(taskId).map(parseToolEvent)
}

/** Records a tool call's result, and returns the call updated. Throws if the task has no call with that id. */
export function updateToolCall(db: Database, result: ToolCallResult): ToolCallEvent {
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET tool_state = @state, tool_output = @output
      WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call'
      RETURNING ${COLUMNS}`,
    )
    .get(result)
  if (row === undefined) throw new Error(`No tool call ${result.toolUseId} in task ${result.taskId}`)
  return parseToolCall(new Row('tool_events', row))
}
