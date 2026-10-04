/**
 * What the tool log shows, worked out from a task's tool events: each tool call's one-line argument and result, the
 * dividers' labels, and the order of the rows. The tool log shows the task's own agent (`parentLogRows`); the Subagents
 * tab shows each subagent's calls nested under the call that started it (`toolLogRows`). A call a permission was
 * decided about, or still waits on one, carries its permission line (`../permissions/permissionLineModel`), found by
 * the call's `tool_use` id.
 */
import { TaskIndicator } from '../../shared/taskIndicator'
import { toolDisplayName } from '../../shared/toolName'
import { firstLine, stringField } from '../../shared/toolSummary'
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
  type Watcher,
} from '../../shared/domain'
import { clockTime, dayAndTime } from '../chat/chatModel'
import { formatTokens } from '../context-meter/format'
import {
  NO_PERMISSION_LINES,
  PermissionLineState,
  ranWithPermission,
  samePermissionLine,
  type PermissionLine,
  type PermissionLines,
} from '../permissions/permissionLineModel'

export { argumentSummary, relativePath } from '../../shared/toolSummary'

/** The last line of a text that isn't blank, trimmed. */
function lastLine(text: string): string {
  return (text.split('\n').findLast((line) => line.trim() !== '') ?? '').trim()
}

/** How many lines a text has, not counting a trailing newline. */
export function lineCount(text: string): number {
  if (text === '') return 0
  return text.replace(/\n$/, '').split('\n').length
}

/** "212 lines", "1 line". */
function lines(count: number): string {
  return `${String(count)} line${count === 1 ? '' : 's'}`
}

/**
 * The short result under a finished call: a line count for Read and Write, the lines added and removed for Edit, the
 * last line of Bash's output (where a test run or build puts its summary), and the first line of anything else's.
 */
function doneSummary(call: ToolCallEvent, output: string): string {
  switch (call.name) {
    case 'Read':
      return lines(lineCount(output))
    case 'Write': {
      const content = stringField(call.input, 'content')
      if (content !== undefined) return lines(lineCount(content))
      break
    }
    case 'Edit': {
      const added = stringField(call.input, 'new_string')
      const removed = stringField(call.input, 'old_string')
      if (added !== undefined && removed !== undefined) {
        return `+${String(lineCount(added))} −${String(lineCount(removed))}`
      }
      break
    }
    case 'Bash':
      return lastLine(output) || 'Done'
  }
  return firstLine(output) || 'Done'
}

/** The short result line under a tool call. */
export function resultSummary(call: ToolCallEvent): string {
  switch (call.state) {
    case ToolCallState.Running:
      return 'Running…'
    case ToolCallState.Error:
      return firstLine(call.output ?? '') || 'Failed'
    case ToolCallState.Done:
      return doneSummary(call, call.output ?? '')
    case ToolCallState.Paused:
      return 'Paused'
    case ToolCallState.Interrupted:
      return 'Interrupted'
  }
}

/**
 * The dot a tool call shows: running blue, done slate, error pink, paused purple (17-usage-limit.html), and interrupted
 * slate, since a call cut off by a crash didn't fail (18-relaunch.html).
 */
export function callIndicator(state: ToolCallState): TaskIndicator {
  switch (state) {
    case ToolCallState.Running:
      return TaskIndicator.Working
    case ToolCallState.Done:
    case ToolCallState.Interrupted:
      return TaskIndicator.Done
    case ToolCallState.Error:
      return TaskIndicator.Error
    case ToolCallState.Paused:
      return TaskIndicator.Waiting
  }
}

/** What a screen reader calls a tool call's dot. */
export function callStateLabel(state: ToolCallState): string {
  switch (state) {
    case ToolCallState.Running:
      return 'Running'
    case ToolCallState.Done:
      return 'Done'
    case ToolCallState.Error:
      return 'Failed'
    case ToolCallState.Paused:
      return 'Paused'
    case ToolCallState.Interrupted:
      return 'Interrupted'
  }
}

function sameDay(a: EpochMs, b: EpochMs): boolean {
  return new Date(a).toDateString() === new Date(b).toDateString()
}

/** A divider's time: "11:20", or "Sep 25, 09:14" on a different day from the entry before it. */
export function dividerTime(at: EpochMs, previous: EpochMs | undefined): string {
  return previous === undefined || sameDay(at, previous) ? clockTime(at) : dayAndTime(at)
}

/** What a divider says before its time: "turn 2", "marked done", "reopened", "resumed after restart". */
export function dividerLabel(divider: Pick<DividerEvent, 'dividerKind' | 'turn'>): string {
  switch (divider.dividerKind) {
    case DividerKind.Turn:
      return `turn ${String(divider.turn)}`
    case DividerKind.MarkedDone:
      return 'marked done'
    case DividerKind.Reopened:
      return 'reopened'
    case DividerKind.Resumed:
      return 'resumed after restart'
  }
}

/** One tool call in the log, with what its subagent did. */
export interface CallRow {
  readonly kind: ToolEventKind.ToolCall
  readonly call: ToolCallEvent
  /** The tool's name as the log shows it. */
  readonly name: string
  /** The calls made and the notes written by the subagent this call started, in order; empty for any other call. */
  readonly children: readonly SubagentRow[]
  /** What was decided about the call, or that it waits on you; null for a call no permission was involved in. */
  readonly permission: PermissionLine | null
}

/**
 * Whether a call waits on your OK: its permission card is open, and nothing has ended the call meanwhile. Its row then
 * shows the purple dot rather than the running blue one (`docs/design/html/23-permission-card.html`). A call the app
 * quit on keeps its own dot, since it did end: its line alone says it still waits.
 */
export function awaitsPermission({ call, permission }: Pick<CallRow, 'call' | 'permission'>): boolean {
  return call.state === ToolCallState.Running && permission?.state === PermissionLineState.Waiting
}

/**
 * Whether a call never ran because its permission request was withdrawn (the turn was stopped, say): the call ends as
 * an error, but it didn't fail, so its row shows the slate dot, not a failed call's pink
 * (`docs/design/html/24-permissions-picker.html`).
 */
export function withdrawnUnrun({ call, permission }: Pick<CallRow, 'call' | 'permission'>): boolean {
  return call.state === ToolCallState.Error && permission?.state === PermissionLineState.Withdrawn
}

/**
 * Whether a row shows its call's state as any other row does (a running call's highlight, a failed call's): not while
 * the call waits on your OK, nor when it never ran because its request was withdrawn.
 */
export function showsCallState(row: Pick<CallRow, 'call' | 'permission'>): boolean {
  return !awaitsPermission(row) && !withdrawnUnrun(row)
}

/** The dot a call's row shows: its call's (`callIndicator`), but purple while it waits on your OK, and slate once withdrawn. */
export function rowIndicator(row: Pick<CallRow, 'call' | 'permission'>): TaskIndicator {
  if (awaitsPermission(row)) return TaskIndicator.Waiting
  if (withdrawnUnrun(row)) return TaskIndicator.Done
  return callIndicator(row.call.state)
}

/** What a screen reader calls a row's dot (`rowIndicator`). */
export function rowStateLabel(row: Pick<CallRow, 'call' | 'permission'>): string {
  if (awaitsPermission(row)) return 'Waiting'
  if (withdrawnUnrun(row)) return 'Withdrawn'
  return callStateLabel(row.call.state)
}

/**
 * Whether a call's row shows its result line: not while it waits on a permission, nor once that was denied or
 * withdrawn, since the call never ran and its permission line says so (`ranWithPermission`).
 */
export function showsResult({ permission }: Pick<CallRow, 'permission'>): boolean {
  return permission === null || ranWithPermission(permission)
}

export interface NarrationRow {
  readonly kind: ToolEventKind.Narration
  readonly narration: NarrationEvent
}

/** One row of what a subagent did, nested under the call that started it: a tool call or a note. */
export type SubagentRow = CallRow | NarrationRow

export interface DividerRow {
  readonly kind: ToolEventKind.Divider
  readonly divider: DividerEvent
  /** "turn 2 · 11:20". */
  readonly label: string
}

/** A compaction, shown like a tool call named Compact (docs/design/html/19-compaction.html). */
export interface CompactionRow {
  readonly kind: ToolEventKind.Compaction
  readonly compaction: CompactionEvent
}

/** One top-level row of the tool log. */
export type ToolLogRow = CallRow | NarrationRow | DividerRow | CompactionRow

/** What a compaction row names it. */
export const COMPACTION_NAME = 'Compact'

/** The argument after a compaction's name: "198k → 41k tokens" once it's done, else nothing. */
export function compactionArgument({ state, preTokens, postTokens }: CompactionEvent): string {
  if (state !== ToolCallState.Done || preTokens === null) return ''
  return postTokens === null
    ? `from ${formatTokens(preTokens)} tokens`
    : `${formatTokens(preTokens)} → ${formatTokens(postTokens)} tokens`
}

/** The short result line under a compaction. */
export function compactionResult({ state, trigger }: CompactionEvent): string {
  switch (state) {
    case ToolCallState.Running:
      return 'Compacting…'
    // A compaction the app quit in ends as an error; it's never paused or interrupted, but would read the same.
    case ToolCallState.Error:
    case ToolCallState.Paused:
    case ToolCallState.Interrupted:
      return "Didn't finish"
    case ToolCallState.Done:
      return trigger === CompactionTrigger.Auto ? 'Automatic · resuming from a summary' : 'Resuming from a summary'
  }
}

/**
 * The tool log's rows, in order. A subagent's calls and notes sit under the call that started it (the one whose
 * `toolUseId` is their `parentToolUseId`); one whose parent isn't in the log stays at the top level. Turn 1's divider is
 * left out, since nothing comes before it to divide from. Each call gets its permission line, if `permissions` has one
 * for it.
 */
export function toolLogRows(
  events: readonly ToolEvent[],
  permissions: PermissionLines = NO_PERMISSION_LINES,
): ToolLogRow[] {
  // Each call's list of what its subagent did, by its tool_use id. A subagent's rows always come after its call.
  const childrenOf = new Map<string, SubagentRow[]>()
  const rows: ToolLogRow[] = []
  const nest = (parentToolUseId: string | null, row: SubagentRow): void => {
    const siblings = parentToolUseId === null ? undefined : childrenOf.get(parentToolUseId)
    if (siblings === undefined) rows.push(row)
    else siblings.push(row)
  }
  let previous: EpochMs | undefined
  for (const event of events) {
    switch (event.kind) {
      case ToolEventKind.Narration:
        nest(event.parentToolUseId, { kind: ToolEventKind.Narration, narration: event })
        break
      case ToolEventKind.Divider:
        if (event.dividerKind !== DividerKind.Turn || event.turn > 1) {
          const label = `${dividerLabel(event)} · ${dividerTime(event.createdAt, previous)}`
          rows.push({ kind: ToolEventKind.Divider, divider: event, label })
        }
        break
      case ToolEventKind.Compaction:
        rows.push({ kind: ToolEventKind.Compaction, compaction: event })
        break
      // The refusal notice is the chat's own quiet row (`../chat/chatModel`); the tool log doesn't show it.
      case ToolEventKind.RefusalFallback:
        break
      case ToolEventKind.ToolCall: {
        const children: SubagentRow[] = []
        nest(event.parentToolUseId, {
          kind: ToolEventKind.ToolCall,
          call: event,
          name: toolDisplayName(event.name),
          children,
          permission: permissions.get(event.toolUseId) ?? null,
        })
        childrenOf.set(event.toolUseId, children)
        break
      }
    }
    previous = event.createdAt
  }
  return rows
}

/**
 * Whether two of a subagent's rows (or two tool calls) show the same: the same event, and for a call, the same
 * permission line and the same rows under it. `toolLogRows` makes each row anew, so a row that hasn't changed is told by
 * what it holds (#413).
 */
export function sameSubagentRow(a: SubagentRow, b: SubagentRow): boolean {
  switch (a.kind) {
    case ToolEventKind.Narration:
      return b.kind === ToolEventKind.Narration && a.narration === b.narration
    case ToolEventKind.ToolCall:
      return (
        b.kind === ToolEventKind.ToolCall &&
        a.call === b.call &&
        samePermissionLine(a.permission, b.permission) &&
        sameSubagentRows(a.children, b.children)
      )
  }
}

/** Whether two lists of a subagent's rows show the same, row by row (`sameSubagentRow`). */
export function sameSubagentRows(a: readonly SubagentRow[], b: readonly SubagentRow[]): boolean {
  return a === b || (a.length === b.length && a.every((row, index) => sameSubagentRow(row, b[index] ?? row)))
}

/**
 * Whether the task's own agent logged an event, not one of its subagents: a subagent's calls and notes name the `Agent`
 * call they belong to (`parentToolUseId`); the parent's, and every divider and compaction, don't.
 */
export function isParentEvent(event: ToolEvent): boolean {
  switch (event.kind) {
    case ToolEventKind.ToolCall:
    case ToolEventKind.Narration:
      return event.parentToolUseId === null
    case ToolEventKind.Divider:
    case ToolEventKind.Compaction:
    case ToolEventKind.RefusalFallback:
      return true
  }
}

/**
 * The tool log's rows for the task's own agent: its calls, notes, dividers and compactions, in order. What a subagent
 * does belongs under it in the Subagents tab, not here, so an `Agent` call is a single row, with no calls under it.
 */
export function parentLogRows(events: readonly ToolEvent[], permissions?: PermissionLines): ToolLogRow[] {
  return toolLogRows(events.filter(isParentEvent), permissions)
}

/**
 * Whether one agent of the task logged an event: a subagent, by the `Agent` call that started it (its `tool_use` id),
 * or the task's own agent (null; `isParentEvent`). A subagent's are the calls and notes that name its call as their
 * parent: what a subagent it started itself does is that subagent's, not its own.
 */
export function isAgentEvent(event: ToolEvent, agentId: string | null): boolean {
  if (agentId === null) return isParentEvent(event)
  switch (event.kind) {
    case ToolEventKind.ToolCall:
    case ToolEventKind.Narration:
      return event.parentToolUseId === agentId
    case ToolEventKind.Divider:
    case ToolEventKind.Compaction:
    case ToolEventKind.RefusalFallback:
      return false
  }
}

/** The event a row of the tool log shows. */
export function rowEvent(row: ToolLogRow): ToolEvent {
  switch (row.kind) {
    case ToolEventKind.ToolCall:
      return row.call
    case ToolEventKind.Narration:
      return row.narration
    case ToolEventKind.Divider:
      return row.divider
    case ToolEventKind.Compaction:
      return row.compaction
  }
}

/** The kinds of row an agent's list has besides the tool log's own, which are named by their events' kinds. */
export enum AgentLogRowKind {
  /** A watcher that has ended (P16, #537). */
  Watcher = 'watcher',
}

/** A watcher that has ended, as a row of its agent's list at the time it ended. */
export interface EndedWatcherRow {
  readonly kind: AgentLogRowKind.Watcher
  readonly watcher: Watcher
}

/** One row of an agent's list in the Agents tab: a row of the tool log, or a watcher that has ended. */
export type AgentLogRow = ToolLogRow | EndedWatcherRow

/** What an agent's list shows of the agent's watchers (`../agents/agentWatchersModel`). */
export interface LogWatchers {
  /** Its watchers that have ended, in the order they ended: each is a row, at the time it ended. */
  readonly ended: readonly Watcher[]
  /**
   * The `tool_use` ids of the calls that started a watcher of its, live or ended. Such a call isn't a row: while its
   * watcher is live it's pinned under the list, and once it has ended the watcher's own row stands for it.
   */
  readonly startedBy: ReadonlySet<string>
}

const NO_LOG_WATCHERS: LogWatchers = { ended: [], startedBy: new Set<string>() }

/**
 * The tool log's rows for one agent of the task (`isAgentEvent`), in order: the Agents tab's list for that agent (P16,
 * #536). The task's own agent's are `parentLogRows`; a subagent's are its calls and notes, the ones the Subagents tab
 * nests under its row. Either way an `Agent` call is a single row, with nothing under it: its subagent has a tab of
 * its own.
 *
 * With the agent's `watchers` (#537), each one that has ended is a row at the time it ended: after everything logged
 * before then and before whatever came next, so what the agent did on being woken follows it. A watcher that ended
 * at the very time of an event comes before it: a wake ends its watcher, then starts the turn. The call that started
 * a watcher is left out.
 */
export function agentLogRows(
  events: readonly ToolEvent[],
  agentId: string | null,
  permissions?: PermissionLines,
  watchers: LogWatchers = NO_LOG_WATCHERS,
): AgentLogRow[] {
  const { ended, startedBy } = watchers
  const rows = toolLogRows(
    events.filter(
      (event) =>
        isAgentEvent(event, agentId) && !(event.kind === ToolEventKind.ToolCall && startedBy.has(event.toolUseId)),
    ),
    permissions,
  )
  if (ended.length === 0) return rows
  const merged: AgentLogRow[] = []
  let next = 0
  /** Adds the watchers that ended by `at`, which haven't a row yet. */
  const endedBy = (at: EpochMs): void => {
    for (let watcher = ended[next]; watcher !== undefined; watcher = ended[next]) {
      if ((watcher.endedAt ?? watcher.startedAt) > at) return
      merged.push({ kind: AgentLogRowKind.Watcher, watcher })
      next += 1
    }
  }
  for (const row of rows) {
    endedBy(rowEvent(row).createdAt)
    merged.push(row)
  }
  endedBy(Infinity)
  return merged
}

/** How many tool calls the task's own agent has made, not its subagents: the Tool calls tab's count. */
export function toolCallCount(events: readonly ToolEvent[]): number {
  return events.filter((event) => event.kind === ToolEventKind.ToolCall && isParentEvent(event)).length
}
