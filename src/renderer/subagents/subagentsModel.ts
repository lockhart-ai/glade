/**
 * A task's subagents, worked out from its tool events: each `Agent` (or `Task`) call is a subagent, and the calls and
 * notes nested under it (`parentToolUseId`) are what it did. The Agents tab gives each a tab of its own
 * (`../agents`); the task list counts the running ones. See `docs/sdk-notes.md`, "Subagents".
 *
 * There's no "queued" subagent: nothing in the stream says a subagent is waiting for a slot (`docs/sdk-notes.md`), so
 * every subagent is running, paused, done, interrupted or failed.
 */
import { isSubagentTool, subagentName, UNNAMED_SUBAGENT } from '../../shared/subagents'
import { ToolCallState, ToolEventKind, type EpochMs, type ToolCallEvent, type ToolEvent } from '../../shared/domain'
import type { PermissionLines } from '../permissions/permissionLineModel'
import {
  argumentSummary,
  resultSummary,
  toolLogRows,
  type CallRow,
  type SubagentRow,
  type ToolLogRow,
} from '../tool-log/toolLogModel'

// What a subagent is called is shared with main (`shared/subagents`); the renderer's own code reads it from here.
export { subagentName, UNNAMED_SUBAGENT }

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

export interface Subagent {
  /** The `Agent` call that started it. */
  readonly call: ToolCallEvent
  readonly name: string
  readonly status: SubagentStatus
  /**
   * While it runs, the SDK's latest one-line summary of what it's doing (`ToolCallEvent.progressSummary`); null before
   * the first, and once it has finished.
   */
  readonly summary: string | null
  /** What it did, in order: its log, as the tool log nests it. */
  readonly log: readonly SubagentRow[]
}

/** Every status, in the order subagents are listed. */
const SUBAGENT_STATUSES: readonly SubagentStatus[] = Object.values(SubagentStatus)

/** A subagent's status, from its `Agent` call's state. */
export function subagentStatus(state: ToolCallState): SubagentStatus {
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

function toSubagent(row: CallRow): Subagent {
  return {
    call: row.call,
    name: subagentName(row.call),
    status: subagentStatus(row.call.state),
    summary: row.call.state === ToolCallState.Running ? row.call.progressSummary : null,
    log: row.children,
  }
}

/** Every `Agent` call among some rows, a subagent's own included, in log order. */
function subagentCalls(rows: readonly (ToolLogRow | SubagentRow)[]): CallRow[] {
  return rows.flatMap((row) => {
    if (row.kind !== ToolEventKind.ToolCall) return []
    const nested = subagentCalls(row.children)
    return isSubagentTool(row.call.name) ? [row, ...nested] : nested
  })
}

/**
 * A task's subagents: running ones first, then paused, done, interrupted and failed, each in the order they started.
 * `permissions` gives each call in their logs its permission line.
 */
export function deriveSubagents(events: readonly ToolEvent[], permissions?: PermissionLines): Subagent[] {
  const subagents = subagentCalls(toolLogRows(events, permissions)).map(toSubagent)
  return SUBAGENT_STATUSES.flatMap((status) => subagents.filter((subagent) => subagent.status === status))
}

/**
 * How many of a task's subagents are running now, nested ones included: the count on the task's row in the task list. Counted from whatever of its log is loaded: all of it once the task has been
 * opened, else the running subagents loaded on start and what events have brought since.
 */
export function runningSubagentCount(events: readonly ToolEvent[] | undefined): number {
  return (events ?? []).filter(
    (event) =>
      event.kind === ToolEventKind.ToolCall && event.state === ToolCallState.Running && isSubagentTool(event.name),
  ).length
}

/** Each task's running subagents (`runningSubagentCount`), by task id, leaving out the tasks with none. */
export function runningSubagentCounts(
  toolEvents: Readonly<Record<string, readonly ToolEvent[]>>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [taskId, events] of Object.entries(toolEvents)) {
    const count = runningSubagentCount(events)
    if (count > 0) counts[taskId] = count
  }
  return counts
}

/** What a task row's subagent count says in its tooltip and to a screen reader: "3 subagents running". */
export function subagentsRunningLabel(count: number): string {
  return `${String(count)} subagent${count === 1 ? '' : 's'} running`
}

/**
 * How long a subagent has run: from its call until its result, or until `now` while it runs. Null for one that
 * finished before Glade recorded when calls finish.
 */
export function elapsedMs(subagent: Pick<Subagent, 'call'>, now: EpochMs): number | null {
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

/** A subagent's log rows as lines of text, each nested subagent's rows indented under its call. */
function logLines(rows: readonly SubagentRow[], rootPath: string | undefined, indent: string): string[] {
  return rows.flatMap((row) => {
    switch (row.kind) {
      case ToolEventKind.ToolCall:
        return [
          `${indent}${row.name} ${argumentSummary(row.call, rootPath)}`.trimEnd(),
          `${indent}  ${resultSummary(row.call)}`,
          ...logLines(row.children, rootPath, `${indent}  `),
        ]
      case ToolEventKind.Narration:
        return [`${indent}${row.narration.text}`]
    }
  })
}

/**
 * A subagent's log as text (Copy log): its name, then each of its tool calls with its argument and short result and
 * each of its notes, in order, and once it has finished, what it came to.
 */
export function subagentLogText(subagent: Subagent, rootPath?: string): string {
  const outcome = subagent.status === SubagentStatus.Running ? '' : (subagent.call.output ?? '').trim()
  return [subagent.name, ...logLines(subagent.log, rootPath, ''), ...(outcome === '' ? [] : ['', outcome])].join('\n')
}
