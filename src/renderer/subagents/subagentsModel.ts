/**
 * What the Subagents tab shows, worked out from a task's tool events: each `Agent` (or `Task`) call is a subagent, and
 * the calls and notes nested under it (`parentToolUseId`) are what it did. See `docs/sdk-notes.md`, "Subagents".
 *
 * There's no "queued" subagent: nothing in the stream says a subagent is waiting for a slot (`docs/sdk-notes.md`), so
 * every subagent is running, paused, done, interrupted or failed.
 */
import { TaskIndicator } from '../../shared/taskIndicator'
import { ToolCallState, ToolEventKind, type EpochMs, type ToolCallEvent, type ToolEvent } from '../../shared/domain'
import { argumentSummary, toolLogRows, type CallRow, type SubagentRow, type ToolLogRow } from '../tool-log/toolLogModel'

/** The tools that start a subagent: `Agent` in `tool_use` (the init tools list calls it `Task`). */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

/** What a subagent is called when its call names neither a description nor a type. */
export const UNNAMED_SUBAGENT = 'Subagent'

/** A subagent's status: its `Agent` call's state (see `ToolCallState`). */
export enum SubagentStatus {
  Running = 'running',
  /** Cut off by a pause the task is still in. */
  Paused = 'paused',
  Done = 'done',
  /** Cut off by Glade quitting, or by a pause the task has resumed from: not a failure. */
  Interrupted = 'interrupted',
  Error = 'error',
}

/** Every status, in the order the tally and the list show them. */
export const SUBAGENT_STATUSES: readonly SubagentStatus[] = Object.values(SubagentStatus)

export enum LatestLineKind {
  /** Its latest tool call: "Bash  gh pr view 1437". */
  ToolCall = 'tool_call',
  /** The last thing it said while running, quoted. */
  Said = 'said',
  /** What it finished with: its result, or its error. */
  Outcome = 'outcome',
}

export interface ToolCallLine {
  readonly kind: LatestLineKind.ToolCall
  readonly name: string
  readonly argument: string
}

export interface SaidLine {
  readonly kind: LatestLineKind.Said
  readonly text: string
}

export interface OutcomeLine {
  readonly kind: LatestLineKind.Outcome
  readonly text: string
}

/** The line under a subagent's name that says what it's doing, or what it came to. */
export type LatestLine = ToolCallLine | SaidLine | OutcomeLine

export interface Subagent {
  /** The `Agent` call that started it. */
  readonly call: ToolCallEvent
  readonly name: string
  readonly status: SubagentStatus
  /** How many tool calls it has made. */
  readonly toolCalls: number
  /** What it's doing or came to; null before it has done anything. */
  readonly latest: LatestLine | null
  /** What it did, in order: its log, as the tool log nests it. */
  readonly log: readonly SubagentRow[]
}

function stringInput(call: ToolCallEvent, field: string): string | undefined {
  const value = call.input[field]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** What a subagent is called: the description its call gives it, else its type. */
export function subagentName(call: ToolCallEvent): string {
  return stringInput(call, 'description') ?? stringInput(call, 'subagent_type') ?? UNNAMED_SUBAGENT
}

function subagentStatus(state: ToolCallState): SubagentStatus {
  switch (state) {
    case ToolCallState.Running:
      return SubagentStatus.Running
    case ToolCallState.Done:
      return SubagentStatus.Done
    case ToolCallState.Error:
      return SubagentStatus.Error
    case ToolCallState.Paused:
      return SubagentStatus.Paused
    case ToolCallState.Interrupted:
      return SubagentStatus.Interrupted
  }
}

/** The first line of a text that isn't blank, trimmed; empty when it has none. */
function firstLine(text: string): string {
  return (text.split('\n').find((line) => line.trim() !== '') ?? '').trim()
}

/** A row of its log as the line under its name. */
function rowLine(row: SubagentRow, rootPath: string | undefined): LatestLine {
  switch (row.kind) {
    case ToolEventKind.ToolCall:
      return { kind: LatestLineKind.ToolCall, name: row.name, argument: argumentSummary(row.call, rootPath) }
    case ToolEventKind.Narration:
      return { kind: LatestLineKind.Said, text: row.narration.text }
  }
}

/**
 * The line under a subagent's name: while it runs, its latest tool call or the last thing it said; once it's
 * finished, the first line of its result (or its error), or its last row when that's empty.
 */
function latestLine(row: CallRow, rootPath: string | undefined): LatestLine | null {
  const outcome = row.call.state === ToolCallState.Running ? '' : firstLine(row.call.output ?? '')
  if (outcome !== '') return { kind: LatestLineKind.Outcome, text: outcome }
  const last = row.children.at(-1)
  return last === undefined ? null : rowLine(last, rootPath)
}

function toSubagent(row: CallRow, rootPath: string | undefined): Subagent {
  return {
    call: row.call,
    name: subagentName(row.call),
    status: subagentStatus(row.call.state),
    toolCalls: row.children.filter((child) => child.kind === ToolEventKind.ToolCall).length,
    latest: latestLine(row, rootPath),
    log: row.children,
  }
}

/** Every `Agent` call among some rows, a subagent's own included, in log order. */
function subagentCalls(rows: readonly (ToolLogRow | SubagentRow)[]): CallRow[] {
  return rows.flatMap((row) => {
    if (row.kind !== ToolEventKind.ToolCall) return []
    const nested = subagentCalls(row.children)
    return SUBAGENT_TOOLS.has(row.call.name) ? [row, ...nested] : nested
  })
}

/**
 * A task's subagents: running ones first, then paused, done, interrupted and failed, each in the order they started. `rootPath` makes
 * file arguments relative to the workspace root.
 */
export function deriveSubagents(events: readonly ToolEvent[], rootPath?: string): Subagent[] {
  const subagents = subagentCalls(toolLogRows(events)).map((row) => toSubagent(row, rootPath))
  return SUBAGENT_STATUSES.flatMap((status) => subagents.filter((subagent) => subagent.status === status))
}

/** How many subagents a task has started: the Subagents tab's count. */
export function subagentCount(events: readonly ToolEvent[]): number {
  return events.filter((event) => event.kind === ToolEventKind.ToolCall && SUBAGENT_TOOLS.has(event.name)).length
}

/**
 * How long a subagent has run: from its call until its result, or until `now` while it runs. Null for one that
 * finished before Glade recorded when calls finish.
 */
export function elapsedMs(subagent: Subagent, now: EpochMs): number | null {
  const { call } = subagent
  if (call.state === ToolCallState.Running) return Math.max(0, now - call.createdAt)
  return call.finishedAt === null ? null : Math.max(0, call.finishedAt - call.createdAt)
}

/** An elapsed time as the tab shows it: "42s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${String(seconds)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${String(minutes)}m ${String(seconds % 60).padStart(2, '0')}s`
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** "12 tool calls", "1 tool call". */
export function toolCallsLabel(count: number): string {
  return `${String(count)} tool call${count === 1 ? '' : 's'}`
}

/** The line under a subagent's name and latest line: "4m 12s · 12 tool calls". */
export function metaLine(subagent: Subagent, now: EpochMs): string {
  const elapsed = elapsedMs(subagent, now)
  const calls = toolCallsLabel(subagent.toolCalls)
  return elapsed === null ? calls : `${formatElapsed(elapsed)} · ${calls}`
}

/** What a subagent's status is called: "Running", "Paused", "Done", "Interrupted", "Failed". */
export function statusLabel(status: SubagentStatus): string {
  switch (status) {
    case SubagentStatus.Running:
      return 'Running'
    case SubagentStatus.Paused:
      return 'Paused'
    case SubagentStatus.Done:
      return 'Done'
    case SubagentStatus.Interrupted:
      return 'Interrupted'
    case SubagentStatus.Error:
      return 'Failed'
  }
}

/** The dot a subagent shows, as its call's in the tool log: running blue, paused purple, failed pink, else slate. */
export function statusIndicator(status: SubagentStatus): TaskIndicator {
  switch (status) {
    case SubagentStatus.Running:
      return TaskIndicator.Working
    case SubagentStatus.Paused:
      return TaskIndicator.Waiting
    case SubagentStatus.Done:
    case SubagentStatus.Interrupted:
      return TaskIndicator.Done
    case SubagentStatus.Error:
      return TaskIndicator.Error
  }
}

/** One part of the tally: "3 running". */
export interface TallyPart {
  readonly status: SubagentStatus
  readonly label: string
}

/** The tally at the top of the tab: "3 running · 1 done", leaving out a status no subagent has. */
export function tally(subagents: readonly Subagent[]): TallyPart[] {
  return SUBAGENT_STATUSES.flatMap((status) => {
    const count = subagents.filter((subagent) => subagent.status === status).length
    return count === 0 ? [] : [{ status, label: `${String(count)} ${statusLabel(status).toLowerCase()}` }]
  })
}

/** Whether any subagent is still running, so its elapsed time needs to tick. */
export function anyRunning(subagents: readonly Subagent[]): boolean {
  return subagents.some((subagent) => subagent.status === SubagentStatus.Running)
}
