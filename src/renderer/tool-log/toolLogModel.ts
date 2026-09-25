/**
 * What the tool log shows, worked out from a task's tool events: each tool call's one-line argument and result, the
 * dividers' labels, and the order of the rows. The tool log shows the task's own agent (`parentLogRows`); the Subagents
 * tab shows each subagent's calls nested under the call that started it (`toolLogRows`).
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
} from '../../shared/domain'
import { clockTime, dayAndTime } from '../chat/chatModel'
import { formatTokens } from '../context-meter/format'

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
 * left out, since nothing comes before it to divide from.
 */
export function toolLogRows(events: readonly ToolEvent[]): ToolLogRow[] {
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
      case ToolEventKind.ToolCall: {
        const children: SubagentRow[] = []
        nest(event.parentToolUseId, {
          kind: ToolEventKind.ToolCall,
          call: event,
          name: toolDisplayName(event.name),
          children,
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
      return true
  }
}

/**
 * The tool log's rows for the task's own agent: its calls, notes, dividers and compactions, in order. What a subagent
 * does belongs under it in the Subagents tab, not here, so an `Agent` call is a single row, with no calls under it.
 */
export function parentLogRows(events: readonly ToolEvent[]): ToolLogRow[] {
  return toolLogRows(events.filter(isParentEvent))
}

/** How many tool calls the task's own agent has made, not its subagents: the Tool calls tab's count. */
export function toolCallCount(events: readonly ToolEvent[]): number {
  return events.filter((event) => event.kind === ToolEventKind.ToolCall && isParentEvent(event)).length
}
