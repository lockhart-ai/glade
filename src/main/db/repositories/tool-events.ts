import { randomUUID } from 'node:crypto'
import type { Database } from 'better-sqlite3'
import {
  CompactionTrigger,
  DividerKind,
  LIVE_WATCHER_STATES,
  RefusalScope,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
  type DividerEvent,
  type EpochMs,
  type NarrationEvent,
  type RefusalFallbackEvent,
  type ToolCallEvent,
  type ToolEvent,
  type ToolEventBase,
  type ToolInput,
} from '../../../shared/domain'
import { Row } from './rows'
import { SUBAGENT_TOOL_NAMES } from '../../../shared/subagents'

const SUBAGENT_NAMES = SUBAGENT_TOOL_NAMES.map((name) => `'${name}'`).join(', ')

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

/** A refusal-fallback notice, as the runner logs it once the retry has answered (`docs/sdk-notes.md`). */
export interface NewRefusalFallback extends NewToolEventBase {
  readonly originalModel: string
  readonly fallbackModel: string
  readonly category: string | null
  readonly scope: RefusalScope
}

/** A compaction as it starts (running, with no token counts yet) or as it's reported done. */
export interface NewCompaction extends NewToolEventBase {
  readonly trigger: CompactionTrigger
  readonly state: ToolCallState
  readonly preTokens: number | null
  readonly postTokens: number | null
  readonly windowTokens: number
  /** What the agent carried over, for one reported done; none unless given. */
  readonly summary?: string | null
}

/** How a compaction finished, to fill in on the compaction with the same `id`. */
export interface CompactionOutcome {
  readonly id: string
  readonly state: ToolCallState
  readonly preTokens: number | null
  readonly postTokens: number | null
  /** What the agent carried over; none unless given. */
  readonly summary?: string | null
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
  readonly progressSummary: string | null
  readonly compactSummary: string | null
  readonly refusalOriginalModel: string | null
  readonly refusalFallbackModel: string | null
  readonly refusalCategory: string | null
  readonly refusalScope: RefusalScope | null
}

/** The columns a `tool_events` row has, apart from an agent call's token totals (#589), which a new row leaves unset. */
const ROW_COLUMNS = `id, task_id, kind, turn, created_at, text, tool_name, tool_input, tool_output, finished_at, tool_state,
  tool_use_id, parent_tool_use_id, divider_kind, compact_trigger, pre_tokens, post_tokens, window_tokens,
  progress_summary, compact_summary, refusal_original_model, refusal_fallback_model, refusal_category, refusal_scope`

/** Every column a read or `RETURNING` names, the row's own plus the agent call token totals only their writer sets. */
const COLUMNS = `${ROW_COLUMNS},
  total_input_tokens, total_output_tokens, context_tokens, seq`

const KINDS = Object.values(ToolEventKind)
const TOOL_CALL_STATES = Object.values(ToolCallState)
const DIVIDER_KINDS = Object.values(DividerKind)
const COMPACTION_TRIGGERS = Object.values(CompactionTrigger)
const REFUSAL_SCOPES = Object.values(RefusalScope)

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
    progressSummary: null,
    compactSummary: null,
    refusalOriginalModel: null,
    refusalFallbackModel: null,
    refusalCategory: null,
    refusalScope: null,
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
        progressSummary: event.progressSummary,
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
        compactSummary: event.summary,
      }
    case ToolEventKind.RefusalFallback:
      return {
        ...base,
        refusalOriginalModel: event.originalModel,
        refusalFallbackModel: event.fallbackModel,
        refusalCategory: event.category,
        refusalScope: event.scope,
      }
  }
}

function parseBase(row: Row): ToolEventBase {
  return {
    id: row.text('id'),
    taskId: row.text('task_id'),
    turn: row.integer('turn'),
    createdAt: row.integer('created_at'),
    seq: row.integer('seq'),
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
    progressSummary: row.nullableText('progress_summary'),
    // Set only when written, so a call without totals has exactly the shape it has always had (#589).
    ...(row.nullableInteger('total_input_tokens') === null
      ? {}
      : { totalInputTokens: row.integer('total_input_tokens') }),
    ...(row.nullableInteger('total_output_tokens') === null
      ? {}
      : { totalOutputTokens: row.integer('total_output_tokens') }),
    // Set only when written, so a call without a context size has exactly the shape it has always had (#592).
    ...(row.nullableInteger('context_tokens') === null ? {} : { contextTokens: row.integer('context_tokens') }),
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
    summary: row.nullableText('compact_summary'),
  }
}

function parseRefusalFallback(row: Row): RefusalFallbackEvent {
  return {
    ...parseBase(row),
    kind: ToolEventKind.RefusalFallback,
    originalModel: row.text('refusal_original_model'),
    fallbackModel: row.text('refusal_fallback_model'),
    category: row.nullableText('refusal_category'),
    scope: row.oneOf('refusal_scope', REFUSAL_SCOPES),
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
    case ToolEventKind.RefusalFallback:
      return parseRefusalFallback(row)
  }
}

/** Appends an entry to the end of its task's tool log, and answers the `seq` the log gave it. */
function append(db: Database, event: ToolEvent): number {
  const row: unknown = db
    .prepare(
      `INSERT INTO tool_events (seq, ${ROW_COLUMNS})
    VALUES ((SELECT COALESCE(MAX(seq), 0) + 1 FROM tool_events WHERE task_id = @taskId), @id, @taskId, @kind, @turn,
      @createdAt, @text, @toolName, @toolInput, @toolOutput, @finishedAt, @toolState, @toolUseId, @parentToolUseId, @dividerKind,
      @compactTrigger, @preTokens, @postTokens, @windowTokens, @progressSummary, @compactSummary, @refusalOriginalModel,
      @refusalFallbackModel, @refusalCategory, @refusalScope)
    RETURNING seq`,
    )
    .get(toParams(event))
  return new Row('tool_events', row).integer('seq')
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
  return { ...event, seq: append(db, event) }
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
    progressSummary: null,
  }
  return { ...event, seq: append(db, event) }
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
  return { ...event, seq: append(db, event) }
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
    summary: emptyAsNull(input.summary),
  }
  return { ...event, seq: append(db, event) }
}

/** Appends a refusal-fallback notice to the end of its task's tool log. */
export function appendRefusalFallback(
  db: Database,
  input: NewRefusalFallback,
  now: EpochMs = Date.now(),
): RefusalFallbackEvent {
  const event: RefusalFallbackEvent = {
    kind: ToolEventKind.RefusalFallback,
    id: randomUUID(),
    taskId: input.taskId,
    turn: input.turn,
    createdAt: now,
    originalModel: input.originalModel,
    fallbackModel: input.fallbackModel,
    category: input.category,
    scope: input.scope,
  }
  return { ...event, seq: append(db, event) }
}

/** A summary as stored: none for a missing or blank one. */
function emptyAsNull(summary: string | null | undefined): string | null {
  return summary === undefined || summary === null || summary.trim() === '' ? null : summary
}

/**
 * Records how a compaction finished, with the summary it wrote, if any, and returns it updated. Throws if there's no
 * compaction with that id.
 */
export function updateCompaction(db: Database, outcome: CompactionOutcome): CompactionEvent {
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET tool_state = @state, pre_tokens = @preTokens, post_tokens = @postTokens,
        compact_summary = @summary
      WHERE id = @id AND kind = 'compaction'
      RETURNING ${COLUMNS}`,
    )
    .get({ ...outcome, summary: emptyAsNull(outcome.summary) })
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

/** A page of a task's older tool log: up to `limit` of the entries before `before` (a `seq`), oldest first. */
export function listToolEventsBefore(db: Database, taskId: string, before: number, limit: number): ToolEvent[] {
  return db
    .prepare(`SELECT ${COLUMNS} FROM tool_events WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
    .all(taskId, before, limit)
    .map(parseToolEvent)
    .reverse()
}

const LIVE_DIVIDER_KINDS = `'${DividerKind.MarkedDone}', '${DividerKind.Reopened}', '${DividerKind.Resumed}'`

/**
 * The task's subagent-starting calls and its Reopened, Marked done and Resumed dividers, however old, in log order
 * (#637): few per task, and readers of the whole history need them even when only the tail of the log is sent —
 * the Agents tab's tabs and token totals, the Todos tab's maker names, the header's reopened dot.
 */
export function listCarriedToolEvents(db: Database, taskId: string, subagentNames: readonly string[]): ToolEvent[] {
  const names = subagentNames.map((name) => `'${name}'`).join(', ')
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM tool_events
      WHERE task_id = ? AND (
        (kind = 'tool_call' AND tool_name IN (${names}))
        OR (kind = 'divider' AND divider_kind IN (${LIVE_DIVIDER_KINDS}))
      )
      ORDER BY seq`,
    )
    .all(taskId)
    .map(parseToolEvent)
}

/**
 * A subagent's own tool calls and working notes, whole, in log order (#637): what its tab of the Agents tab shows,
 * which the task's log tail may hold only some of.
 */
export function listAgentEvents(db: Database, taskId: string, agentId: string): ToolEvent[] {
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM tool_events
      WHERE task_id = ? AND parent_tool_use_id = ? AND kind IN ('tool_call', 'narration')
      ORDER BY seq`,
    )
    .all(taskId, agentId)
    .map(parseToolEvent)
}

/**
 * Records a tool call's result, arrived at `now`, and returns the call updated. A call that has already finished (a
 * paused one, later interrupted) keeps the time it first did. A subagent's progress summary goes once its call is no
 * longer running. Throws if the task has no call with that id.
 */
export function updateToolCall(db: Database, result: ToolCallResult, now: EpochMs = Date.now()): ToolCallEvent {
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET tool_state = @state, tool_output = @output,
        finished_at = COALESCE(finished_at, @finishedAt),
        progress_summary = CASE WHEN @state = 'running' THEN progress_summary END
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
 * Records one tool call of a task as interrupted, if it's still running, with `output` saying why. Returns it updated,
 * or undefined when there's no such call or it isn't running.
 */
export function interruptRunningToolCall(
  db: Database,
  taskId: string,
  toolUseId: string,
  output: string,
  now: EpochMs = Date.now(),
): ToolCallEvent | undefined {
  const running = toolCallsIn(db, taskId, ToolCallState.Running).some((call) => call.toolUseId === toolUseId)
  if (!running) return undefined
  return updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Interrupted, output }, now)
}

/** The ids of the tasks with a tool call still running, e.g. a background subagent's when the app quit. */
export function listTasksWithRunningToolCalls(db: Database): string[] {
  return db
    .prepare(`SELECT DISTINCT task_id FROM tool_events WHERE kind = 'tool_call' AND tool_state = ? ORDER BY task_id`)
    .all(ToolCallState.Running)
    .map((raw) => new Row('tool_events', raw).text('task_id'))
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

/**
 * Every task's calls to any of the named tools that the task list's subagent count must know about before a task's
 * log is loaded (#579): one still running, or one whose own turn has ended but that started a watcher still live
 * (`LIVE_WATCHER_STATES`). A watcher started by a call further up the chain (a subagent of a subagent, say) needs
 * that call loaded too, so its own activity can say it's still going; one that's merely running or merely watched
 * loads on its own. By task and then in the order they were made.
 */
export function listSubagentCallsToPreload(db: Database, names: readonly string[]): ToolCallEvent[] {
  if (names.length === 0) return []
  const liveStates = LIVE_WATCHER_STATES.map(() => '?').join(', ')
  return db
    .prepare(
      `SELECT ${COLUMNS} FROM tool_events
      WHERE kind = 'tool_call' AND tool_name IN (${names.map(() => '?').join(', ')})
      AND (tool_state = ? OR EXISTS (
        SELECT 1 FROM watchers
        WHERE watchers.task_id = tool_events.task_id AND watchers.parent_tool_use_id = tool_events.tool_use_id
        AND watchers.state IN (${liveStates})
      ))
      ORDER BY task_id, seq`,
    )
    .all(...names, ToolCallState.Running, ...LIVE_WATCHER_STATES)
    .map((raw) => parseToolCall(new Row('tool_events', raw)))
}

/** A task's tool call by its `tool_use` id, or undefined when it has none. */
export function getToolCall(db: Database, taskId: string, toolUseId: string): ToolCallEvent | undefined {
  const raw: unknown = db
    .prepare(`SELECT ${COLUMNS} FROM tool_events WHERE task_id = ? AND tool_use_id = ? AND kind = 'tool_call'`)
    .get(taskId, toolUseId)
  return raw === undefined ? undefined : parseToolCall(new Row('tool_events', raw))
}

/**
 * The tool call an agent made just before another of its calls: the latest of the task's calls logged before
 * `toolUseId`'s by the same agent (the task's own, or the same subagent: the same `parentToolUseId`). Undefined when
 * that call isn't logged, or is its agent's first.
 */
export function previousToolCall(db: Database, taskId: string, toolUseId: string): ToolCallEvent | undefined {
  const raw: unknown = db
    .prepare(
      `SELECT ${COLUMNS} FROM tool_events
      WHERE task_id = @taskId AND kind = 'tool_call'
        AND seq < (SELECT seq FROM tool_events WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call')
        AND parent_tool_use_id IS
          (SELECT parent_tool_use_id FROM tool_events
          WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call')
      ORDER BY seq DESC LIMIT 1`,
    )
    .get({ taskId, toolUseId })
  return raw === undefined ? undefined : parseToolCall(new Row('tool_events', raw))
}

/** A subagent's latest progress summary and combined token total, for its `Agent` call (#592). */
export interface SubagentProgress {
  readonly taskId: string
  /** The `Agent` call that started the subagent. */
  readonly toolUseId: string
  /** What it's doing now, on one line; left out to keep the summary the call already has. */
  readonly summary?: string
  /**
   * How full the subagent's conversation was at its latest request, in tokens (`task_progress.usage.total_tokens`, as
   * the SDK reports it — a context size, not what it has spent); left out to keep the figure the call already has.
   */
  readonly contextTokens?: number
}

/**
 * Records the latest progress of a running subagent on its `Agent` (or `Task`) call, and returns the call updated.
 * Returns undefined, and records nothing, when the task has no such call still running (a summary that arrives after
 * its subagent finished) or neither the summary nor the context size is news for it.
 */
export function setSubagentProgress(db: Database, progress: SubagentProgress): ToolCallEvent | undefined {
  const params = { ...progress, summary: progress.summary ?? null, contextTokens: progress.contextTokens ?? null }
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET progress_summary = COALESCE(@summary, progress_summary),
        context_tokens = COALESCE(@contextTokens, context_tokens)
      WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call' AND tool_state = 'running'
        AND tool_name IN (${SUBAGENT_NAMES})
        AND (progress_summary IS NOT COALESCE(@summary, progress_summary)
          OR context_tokens IS NOT COALESCE(@contextTokens, context_tokens))
      RETURNING ${COLUMNS}`,
    )
    .get(params)
  return row === undefined ? undefined : parseToolCall(new Row('tool_events', row))
}

/**
 * Evicts one tool log entry a refusal-fallback retry superseded (`docs/sdk-notes.md`): the refused leg's narration or
 * tool call, named by the SDK message uuid it arrived on. Returns whether it was still there to remove; a no-op for an
 * id that's gone already, or was never logged (eviction is idempotent, per the SDK's own contract).
 */
export function deleteToolEvent(db: Database, taskId: string, id: string): boolean {
  const result = db.prepare('DELETE FROM tool_events WHERE id = ? AND task_id = ?').run(id, taskId)
  return result.changes > 0
}

/** An agent call's running token totals, for its line on the Agents tab. */
export interface AgentCallTokenTotals {
  readonly taskId: string
  /** The call that started the agent. */
  readonly toolUseId: string
  readonly totalInputTokens: number
  readonly totalOutputTokens: number
}

/**
 * Writes an agent's running token totals onto the call that started it (#589). The dispatched child a `dispatch` call
 * starts is the only writer so far, writing once as its run ends. Answers whether the task has such a call; any other
 * call is left alone. The totals ride the call's own updated event, and its row keeps them for a relaunch.
 */
export function setAgentCallTokenTotals(db: Database, totals: AgentCallTokenTotals): boolean {
  const result = db
    .prepare(
      `UPDATE tool_events SET total_input_tokens = @totalInputTokens, total_output_tokens = @totalOutputTokens
      WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call'`,
    )
    .run(totals)
  return result.changes > 0
}

/** An agent call's context size, for its line on the Agents tab. */
export interface AgentCallContextTokens {
  readonly taskId: string
  /** The `Agent` (or `Task`) call that started the subagent. */
  readonly toolUseId: string
  readonly contextTokens: number
}

/**
 * Writes an agent's context size onto the call that started it (#592): how full the conversation of the agent was at
 * its latest request, as the SDK reports it — a figure a subagent's end carries, whatever state its call is in by
 * then (a backgrounded call's row still runs, a foreground one has finished), or the exact one its foreground result
 * carries. Answers whether the task has such a call. It never touches the in-and-out split (#589), which is a real
 * total, and the line prefers it when it is there.
 */
export function setAgentCallContextTokens(db: Database, context: AgentCallContextTokens): boolean {
  const result = db
    .prepare(
      `UPDATE tool_events SET context_tokens = @contextTokens
      WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call' AND tool_name IN (${SUBAGENT_NAMES})`,
    )
    .run(context)
  return result.changes > 0
}

/** A subagent's SDK task id, for its `Agent` call. */
export interface SubagentTaskId {
  readonly taskId: string
  /** The `Agent` (or `Task`) call that started the subagent. */
  readonly toolUseId: string
  /** The SDK's id for the subagent's task (`task_started.task_id`, its `agentId`). */
  readonly sdkTaskId: string
}

/**
 * Records the SDK's task id of the subagent an `Agent` (or `Task`) call started, so it can be found again when it's
 * woken (`findSubagentCall`). Answers whether the task has such a call; any other call is left alone.
 */
export function setSubagentTaskId(db: Database, subagent: SubagentTaskId): boolean {
  const result = db
    .prepare(
      `UPDATE tool_events SET sdk_task_id = @sdkTaskId
      WHERE task_id = @taskId AND tool_use_id = @toolUseId AND kind = 'tool_call' AND tool_name IN (${SUBAGENT_NAMES})`,
    )
    .run(subagent)
  return result.changes > 0
}

/**
 * The `Agent` (or `Task`) call of a task whose subagent has the SDK task id, or undefined when it has none (a subagent
 * started before Glade recorded the ids, or another task's). The latest, should two ever share one.
 */
export function findSubagentCall(db: Database, taskId: string, sdkTaskId: string): ToolCallEvent | undefined {
  const raw: unknown = db
    .prepare(
      `SELECT ${COLUMNS} FROM tool_events
      WHERE task_id = ? AND sdk_task_id = ? AND kind = 'tool_call' AND tool_name IN (${SUBAGENT_NAMES})
      ORDER BY seq DESC LIMIT 1`,
    )
    .get(taskId, sdkTaskId)
  return raw === undefined ? undefined : parseToolCall(new Row('tool_events', raw))
}

/**
 * Sets a subagent that had finished running again, for a new run in the same row (#395): its `Agent` (or `Task`) call
 * goes back to running, with no outcome, end time, progress summary or token totals yet (#592), and keeps its log.
 * Returns the call updated, or undefined when the task has no such call, or it's running already.
 */
export function reopenSubagentCall(db: Database, taskId: string, toolUseId: string): ToolCallEvent | undefined {
  const row: unknown = db
    .prepare(
      `UPDATE tool_events SET tool_state = 'running', tool_output = NULL, finished_at = NULL, progress_summary = NULL,
        total_input_tokens = NULL, total_output_tokens = NULL, context_tokens = NULL
      WHERE task_id = ? AND tool_use_id = ? AND kind = 'tool_call' AND tool_name IN (${SUBAGENT_NAMES})
        AND tool_state != 'running'
      RETURNING ${COLUMNS}`,
    )
    .get(taskId, toolUseId)
  return row === undefined ? undefined : parseToolCall(new Row('tool_events', row))
}
