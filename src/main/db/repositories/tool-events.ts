import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  CompactionTrigger,
  DividerKind,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
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
  /** The `Agent` call whose subagent wrote it; the agent's own note when not given. */
  readonly parentToolUseId?: string | null | undefined
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

/** A compaction as it starts (running, with no token counts yet) or as it's reported done. */
export interface NewCompaction extends NewToolEventBase {
  readonly trigger: CompactionTrigger
  readonly state: ToolCallState
  readonly preTokens: number | null
  readonly postTokens: number | null
  readonly windowTokens: number
}

/** How a compaction finished, to fill in on the compaction with the same `id`. */
export interface CompactionOutcome {
  readonly id: string
  readonly state: ToolCallState
  readonly preTokens: number | null
  readonly postTokens: number | null
}

/** A tool call's result, to fill in on the call with the same `toolUseId`. */
export interface ToolCallResult {
  readonly taskId: string
  readonly toolUseId: string
  readonly state: ToolCallState
  /** Null only when a call that never got a result changes state. */
  readonly output: string | null
}

/** A tool call as `toolCallsIn` finds it: its `tool_use` id and output. */
interface ToolCallOutput {
  readonly toolUseId: string
  readonly output: string | null
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
  readonly finishedAt: EpochMs | null
  readonly toolState: ToolCallState | null
  readonly toolUseId: string | null
  readonly parentToolUseId: string | null
  readonly dividerKind: DividerKind | null
  readonly compactTrigger: CompactionTrigger | null
  readonly preTokens: number | null
  readonly postTokens: number | null
  readonly windowTokens: number | null
}

const COLUMNS = `id, task_id, kind, turn, created_at, text, tool_name, tool_input, tool_output, finished_at, tool_state,
  tool_use_id, parent_tool_use_id, divider_kind, compact_trigger, pre_tokens, post_tokens, window_tokens`

const KINDS = Object.values(ToolEventKind)
const TOOL_CALL_STATES = Object.values(ToolCallState)
const DIVIDER_KINDS = Object.values(DividerKind)
const COMPACTION_TRIGGERS = Object.values(CompactionTrigger)

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
    finishedAt: null,
    toolState: null,
    toolUseId: null,
    parentToolUseId: null,
    dividerKind: null,
    compactTrigger: null,
    preTokens: null,
    postTokens: null,
    windowTokens: null,
  }
  switch (event.kind) {
    case ToolEventKind.Narration:
      return { ...base, text: event.text, parentToolUseId: event.parentToolUseId }
    case ToolEventKind.ToolCall:
      return {
        ...base,
        toolName: event.name,
        toolInput: JSON.stringify(event.input),
        toolOutput: event.output,
        finishedAt: event.finishedAt,
        toolState: event.state,
        toolUseId: event.toolUseId,
        parentToolUseId: event.parentToolUseId,
      }
    case ToolEventKind.Divider:
      return { ...base, dividerKind: event.dividerKind }
    case ToolEventKind.Compaction:
      return {
        ...base,
        toolState: event.state,
        compactTrigger: event.trigger,
        preTokens: event.preTokens,
        postTokens: event.postTokens,
        windowTokens: event.windowTokens,
      }
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
    finishedAt: row.nullableInteger('finished_at'),
    toolUseId: row.text('tool_use_id'),
    parentToolUseId: row.nullableText('parent_tool_use_id'),
  }
}

function parseCompaction(row: Row): CompactionEvent {
  return {
    ...parseBase(row),
    kind: ToolEventKind.Compaction,
    trigger: row.oneOf('compact_trigger', COMPACTION_TRIGGERS),
    state: row.oneOf('tool_state', TOOL_CALL_STATES),
    preTokens: row.nullableInteger('pre_tokens'),
    postTokens: row.nullableInteger('post_tokens'),
    windowTokens: row.integer('window_tokens'),
  }
}

function parseToolEvent(raw: unknown): ToolEvent {
  const row = new Row('tool_events', raw)
  const kind = row.oneOf('kind', KINDS)
  switch (kind) {
    case ToolEventKind.Narration:
      return {
        ...parseBase(row),
        kind,
        text: row.text('text'),
        parentToolUseId: row.nullableText('parent_tool_use_id'),
      }
    case ToolEventKind.ToolCall:
      return parseToolCall(row)
    case ToolEventKind.Divider:
      return { ...parseBase(row), kind, dividerKind: row.oneOf('divider_kind', DIVIDER_KINDS) }
    case ToolEventKind.Compaction:
      return parseCompaction(row)
  }
}

/** Appends an entry to the end of its task's tool log. */
function append(db: Database, event: ToolEvent): void {
  db.prepare(
    `INSERT INTO tool_events (seq, ${COLUMNS})
    VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_events WHERE task_id = @taskId), @id, @taskId, @kind, @turn,
      @createdAt, @text, @toolName, @toolInput, @toolOutput, @finishedAt, @toolState, @toolUseId, @parentToolUseId, @dividerKind,
      @compactTrigger, @preTokens, @postTokens, @windowTokens)`,
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
    parentToolUseId: input.parentToolUseId ?? null,
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
    finishedAt: null,
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

export function appendCompaction(db: Database, input: NewCompaction, now: EpochMs = Date.now()): CompactionEvent {
  const event: CompactionEvent = {
    kind: ToolEventKind.Compaction,
    id: randomUUID(),
    taskId: input.taskId,
    turn: input.turn,
    createdAt: now,
    trigger: input.trigger,
    state: input.state,
    preTokens: input.preTokens,
    postTokens: input.postTokens,
    windowTokens: input.windowTokens,
  }
  append(db, event)
  return event
}

/** Records how a compaction finished, and returns it updated. Throws if there's no compaction with that id. */
export function updateCompaction(db: Database, outcome: CompactionOutcome): CompactionEvent {
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET tool_state = @state, pre_tokens = @preTokens, post_tokens = @postTokens
      WHERE id = @id AND kind = 'compaction'
      RETURNING ${COLUMNS}`,
    )
    .get(outcome)
  if (row === undefined) throw new Error(`No compaction ${outcome.id}`)
  return parseCompaction(new Row('tool_events', row))
}

/**
 * Records every compaction of a task that is still running as an error, e.g. one the app died in, and returns them
 * updated, in log order.
 */
export function failRunningCompactions(db: Database, taskId: string): CompactionEvent[] {
  const running = db
    .prepare(`SELECT id FROM tool_events WHERE task_id = ? AND kind = 'compaction' AND tool_state = ? ORDER BY seq`)
    .all(taskId, ToolCallState.Running)
    .map((raw) => new Row('tool_events', raw).text('id'))
  return running.map((id) =>
    updateCompaction(db, { id, state: ToolCallState.Error, preTokens: null, postTokens: null }),
  )
}

/** A task's tool log, in the order it was appended. */
export function listToolEvents(db: Database, taskId: string): ToolEvent[] {
  return db.prepare(`SELECT ${COLUMNS} FROM tool_events WHERE task_id = ? ORDER BY seq`).all(taskId).map(parseToolEvent)
}

/**
 * Records a tool call's result, arrived at `now`, and returns the call updated. A call that has already finished (a
 * paused one, later interrupted) keeps the time it first did. Throws if the task has no call with that id.
 */
export function updateToolCall(db: Database, result: ToolCallResult, now: EpochMs = Date.now()): ToolCallEvent {
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET tool_state = @state, tool_output = @output,
        finished_at = COALESCE(finished_at, @finishedAt)
      WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call'
      RETURNING ${COLUMNS}`,
    )
    .get({ ...result, finishedAt: now })
  if (row === undefined) throw new Error(`No tool call ${result.toolUseId} in task ${result.taskId}`)
  return parseToolCall(new Row('tool_events', row))
}

/** A task's tool calls in a state, with their output, in log order. */
function toolCallsIn(db: Database, taskId: string, state: ToolCallState): ToolCallOutput[] {
  return db
    .prepare(
      `SELECT tool_use_id, tool_output FROM tool_events
      WHERE task_id = ? AND kind = 'tool_call' AND tool_state = ? ORDER BY seq`,
    )
    .all(taskId, state)
    .map((raw) => {
      const row = new Row('tool_events', raw)
      return { toolUseId: row.text('tool_use_id'), output: row.nullableText('tool_output') }
    })
}

/**
 * Records every tool call of a task that is still running as interrupted, e.g. the calls of a turn the app died in,
 * with `output` saying why, and returns them updated, in log order.
 */
export function interruptRunningToolCalls(
  db: Database,
  taskId: string,
  output: string,
  now: EpochMs = Date.now(),
): ToolCallEvent[] {
  return toolCallsIn(db, taskId, ToolCallState.Running).map(({ toolUseId }) =>
    updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Interrupted, output }, now),
  )
}

/**
 * Records every paused tool call of a task as interrupted, once the task works again: the pause is behind it. Each
 * keeps its output. Returns them updated, in log order.
 */
export function interruptPausedToolCalls(db: Database, taskId: string): ToolCallEvent[] {
  return toolCallsIn(db, taskId, ToolCallState.Paused).map(({ toolUseId, output }) =>
    updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Interrupted, output }),
  )
}

/** A task's calls to any of the named tools, in the order they were made. */
export function listToolCallsNamed(db: Database, taskId: string, names: readonly string[]): ToolCallEvent[] {
  if (names.length === 0) return []
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM tool_events
      WHERE task_id = ? AND kind = 'tool_call' AND tool_name IN (${names.map(() => '?').join(', ')})
      ORDER BY seq`,
    )
    .all(taskId, ...names)
    .map((raw) => parseToolCall(new Row('tool_events', raw)))
}
