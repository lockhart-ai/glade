/**
 * A task's subagents, worked out from its tool events: each `Agent` (or `Task`) call is a subagent, and the calls and
 * notes nested under it (`parentToolUseId`) are what it did. The Agents tab gives each a tab of its own
 * (`../agents`); the task list counts the ones with something alive under them (#579). See `docs/sdk-notes.md`,
 * "Subagents".
 *
 * There's no "queued" subagent: nothing in the stream says a subagent is waiting for a slot (`docs/sdk-notes.md`), so
 * every subagent is running, paused, done, interrupted or failed.
 */
import { isSubagentTool, subagentName, UNNAMED_SUBAGENT } from '../../shared/subagents'
import {
  ToolCallState,
  ToolEventKind,
  type EpochMs,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import type { PermissionLines } from '../permissions/permissionLineModel'
import { isLive } from '../watchers/watchersModel'
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
 * Where an agent, Main or a subagent, stands right now (#579): its own turn running, its own turn ended but
 * something it started still alive under it (a watcher, a scheduled wakeup, a background command, or a child that is
 * itself active, however deep), or nothing under it alive at all. One rule, shared by the task row's subagent count
 * and its tooltip, every agent's tab in the Agents tab (Main's included), and anywhere else that shows an agent as
 * working, waiting or finished.
 */
export enum AgentActivity {
  /** Its own turn is running right now. */
  Running = 'running',
  /** Its own turn has ended, but a watcher, wakeup, background command or child it started is still alive. */
  Waiting = 'waiting',
  /** Nothing under it is alive. */
  Done = 'done',
}

/** Whether an activity still counts as going on: running, or waiting on something it started (#579). */
export function isAgentActive(activity: AgentActivity): boolean {
  return activity !== AgentActivity.Done
}

type ActivityMap = ReadonlyMap<string | null, AgentActivity>

const NO_EVENTS: readonly ToolEvent[] = []
const NO_WATCHERS: readonly Watcher[] = []

/**
 * Every agent's activity in a task (`AgentActivity`), bottom-up: an agent whose own turn is running is `Running`;
 * else one with a live watcher of its own (`isLive`), or a child whose activity isn't `Done`, is `Waiting`; else
 * `Done`. Main is keyed `null`; a subagent by its `Agent` call's `tool_use` id. `mainRunning` is the task's own turn
 * under way (`TaskActivity.Working` or `Paused`), which isn't itself a tool event, so it's given rather than read
 * here.
 */
function deriveAgentActivity(
  events: readonly ToolEvent[],
  watchers: readonly Watcher[],
  mainRunning: boolean,
): ActivityMap {
  const calls = new Map<string, ToolCallEvent>()
  const childrenOf = new Map<string | null, string[]>()
  for (const event of events) {
    if (event.kind !== ToolEventKind.ToolCall || !isSubagentTool(event.name)) continue
    calls.set(event.toolUseId, event)
    const siblings = childrenOf.get(event.parentToolUseId)
    if (siblings === undefined) childrenOf.set(event.parentToolUseId, [event.toolUseId])
    else siblings.push(event.toolUseId)
  }
  const liveWatcherOwners = new Set<string | null>()
  for (const watcher of watchers) {
    if (isLive(watcher)) liveWatcherOwners.add(watcher.parentToolUseId)
  }
  const activity = new Map<string | null, AgentActivity>()
  const resolve = (id: string | null): AgentActivity => {
    const cached = activity.get(id)
    if (cached !== undefined) return cached
    // A subagent can't start itself, so there's no cycle; this guards a bug here from looping forever anyway.
    activity.set(id, AgentActivity.Done)
    const ownRunning = id === null ? mainRunning : calls.get(id)?.state === ToolCallState.Running
    const alive =
      !ownRunning &&
      (liveWatcherOwners.has(id) || (childrenOf.get(id) ?? []).some((child) => isAgentActive(resolve(child))))
    const result = ownRunning ? AgentActivity.Running : alive ? AgentActivity.Waiting : AgentActivity.Done
    activity.set(id, result)
    return result
  }
  resolve(null)
  for (const id of calls.keys()) resolve(id)
  return activity
}

/** What's been worked out from one task's events, watchers and Main's own turn, so everything that reads an agent's
 * activity for the same task in the same render works it out once. */
const activityCache = new WeakMap<readonly ToolEvent[], WeakMap<readonly Watcher[], Map<boolean, ActivityMap>>>()

/** Every agent's activity in a task (`deriveAgentActivity`), worked out once per (events, watchers, mainRunning). */
export function agentActivity(
  events: readonly ToolEvent[] | undefined,
  watchers: readonly Watcher[] | undefined,
  mainRunning: boolean,
): ActivityMap {
  const ev = events ?? NO_EVENTS
  const wa = watchers ?? NO_WATCHERS
  let byWatchers = activityCache.get(ev)
  if (byWatchers === undefined) {
    byWatchers = new WeakMap()
    activityCache.set(ev, byWatchers)
  }
  let byMain = byWatchers.get(wa)
  if (byMain === undefined) {
    byMain = new Map()
    byWatchers.set(wa, byMain)
  }
  let map = byMain.get(mainRunning)
  if (map === undefined) {
    map = deriveAgentActivity(ev, wa, mainRunning)
    byMain.set(mainRunning, map)
  }
  return map
}

/** How many of a task's subagents are running, and how many have ended their own turn but still have something they
 * started alive (#579): the counts on the task's row in the task list. A subagent with both counts once, as running. */
export interface SubagentCounts {
  readonly running: number
  readonly waiting: number
}

const NO_SUBAGENT_COUNTS: SubagentCounts = { running: 0, waiting: 0 }

/**
 * `SubagentCounts` for one task, from whatever of its log and watchers are loaded: all of it once the task has been
 * opened, else what's loaded on start and what events have brought since.
 */
export function subagentCounts(
  events: readonly ToolEvent[] | undefined,
  watchers: readonly Watcher[] | undefined,
): SubagentCounts {
  const activity = agentActivity(events, watchers, false)
  let running = 0
  let waiting = 0
  for (const [id, status] of activity) {
    if (id === null) continue
    if (status === AgentActivity.Running) running += 1
    else if (status === AgentActivity.Waiting) waiting += 1
  }
  return running === 0 && waiting === 0 ? NO_SUBAGENT_COUNTS : { running, waiting }
}

/** Each task's running subagents (`subagentCounts`), by task id, leaving out the tasks with none. */
export function runningSubagentCounts(
  toolEvents: Readonly<Record<string, readonly ToolEvent[]>>,
  watchers: Readonly<Record<string, readonly Watcher[]>>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [taskId, events] of Object.entries(toolEvents)) {
    const running = subagentCounts(events, watchers[taskId]).running
    if (running > 0) counts[taskId] = running
  }
  return counts
}

/** Each task's subagents waiting on something they started (`subagentCounts`), by task id, leaving out the tasks with none. */
export function waitingSubagentCounts(
  toolEvents: Readonly<Record<string, readonly ToolEvent[]>>,
  watchers: Readonly<Record<string, readonly Watcher[]>>,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const [taskId, events] of Object.entries(toolEvents)) {
    const waiting = subagentCounts(events, watchers[taskId]).waiting
    if (waiting > 0) counts[taskId] = waiting
  }
  return counts
}

/**
 * What a task row's subagent count says in its tooltip and to a screen reader (#579): "3 subagents running" with none
 * waiting, "2 subagents waiting on a watcher" with none running, else split, "3 subagents: 2 running, 1 waiting on a
 * watcher". The singular for one in total either way: "1 subagent running".
 */
export function subagentsLabel(counts: SubagentCounts): string {
  const total = counts.running + counts.waiting
  const noun = `subagent${total === 1 ? '' : 's'}`
  if (counts.waiting === 0) return `${String(total)} ${noun} running`
  if (counts.running === 0) return `${String(total)} ${noun} waiting on a watcher`
  return `${String(total)} ${noun}: ${String(counts.running)} running, ${String(counts.waiting)} waiting on a watcher`
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
