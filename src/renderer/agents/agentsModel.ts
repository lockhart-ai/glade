/**
 * What the Agents tab shows (P16, #536; `docs/design/html/50-agents.html`), worked out from a task's tool events: its
 * agents (the task's own, Main, and a subagent for every `Agent` call, nested ones included), the order of their tabs,
 * which one is showing, and what the lines about a subagent say.
 *
 * An agent is named by its `AgentId`: a subagent by the `tool_use` id of the `Agent` call that started it, and Main by
 * null.
 */
import {
  MessageSource,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  type EpochMs,
  type Message,
  type Task,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import { isSubagentTool, subagentName } from '../../shared/subagents'
import { subagentTodo, type Filing } from '../../shared/todoHub'
import { argumentSummary, firstLine } from '../../shared/toolSummary'
import type { GladeData } from '../store/state'
import {
  AgentActivity,
  agentActivity,
  elapsedMs,
  isAgentActive,
  statusLabel,
  subagentStatus,
} from '../subagents/subagentsModel'
import { formatAge } from '../task-header/headerModel'
import { formatTokens } from '../context-meter/format'
import { isAgentEvent } from '../tool-log/toolLogModel'

/** Which agent of a task: a subagent, by its `Agent` call's `tool_use` id, or null for Main, the task's own agent. */
export type AgentId = string | null

/** What the task's own agent's tab is called. */
export const MAIN_AGENT_NAME = 'Main'

/** A task's subagents, as the strip of agent tabs shows them. */
export interface TaskAgents {
  /**
   * Every subagent's id, in tab order: the running ones, then the finished ones, the newest first within each. Main
   * isn't among them: it's pinned before them all.
   */
  readonly ids: readonly string[]
  /** Each subagent's `Agent` call, by its id. */
  readonly calls: ReadonlyMap<string, ToolCallEvent>
}

const NO_AGENTS: TaskAgents = { ids: [], calls: new Map<string, ToolCallEvent>() }
const NO_EVENTS: readonly ToolEvent[] = []
const NO_MESSAGES: readonly Message[] = []

/** Whether a subagent is running, by its `Agent` call: what its tab's dot and its place in the strip go by. */
export function isRunning(call: Pick<ToolCallEvent, 'state'>): boolean {
  return call.state === ToolCallState.Running
}

function deriveAgents(events: readonly ToolEvent[]): TaskAgents {
  const calls = new Map<string, ToolCallEvent>()
  for (const event of events) {
    if (event.kind === ToolEventKind.ToolCall && isSubagentTool(event.name)) calls.set(event.toolUseId, event)
  }
  // The log is in the order they started, so the newest is the last.
  const newestFirst = [...calls.values()].reverse()
  const ordered = [...newestFirst.filter(isRunning), ...newestFirst.filter((call) => !isRunning(call))]
  return { ids: ordered.map(({ toolUseId }) => toolUseId), calls }
}

/** What's been worked out from each tool log, so the strip, its tabs and the panel's count read it once per change. */
const derived = new WeakMap<readonly ToolEvent[], TaskAgents>()

/**
 * A task's subagents, from its tool log: every `Agent` call, a subagent's own included. Worked out once per log (the
 * store makes a new list with every event), in one pass, however many read it.
 */
export function agentsOf(events: readonly ToolEvent[] | undefined): TaskAgents {
  if (events === undefined) return NO_AGENTS
  let agents = derived.get(events)
  if (agents === undefined) {
    agents = deriveAgents(events)
    derived.set(events, agents)
  }
  return agents
}

/** How many agents a task has, Main included: the Agents tab's count. */
export function agentCount(events: readonly ToolEvent[] | undefined): number {
  return 1 + agentsOf(events).ids.length
}

/**
 * The agent whose tab a task's Agents tab shows: the one it was left on, while that's still one of the task's
 * subagents; else Main.
 */
export function shownAgent(events: readonly ToolEvent[] | undefined, remembered: string | undefined): AgentId {
  return remembered !== undefined && agentsOf(events).calls.has(remembered) ? remembered : null
}

/** The agent a task's Agents tab shows, from the store (`shownAgent`). */
export function selectShownAgent(state: Pick<GladeData, 'toolEvents' | 'agentTabs'>, taskId: string): AgentId {
  return shownAgent(state.toolEvents[taskId], state.agentTabs[taskId])
}

/** Whether the task's own agent's turn is running right now, what `agentActivity` needs for Main (#579): read the
 * same way wherever an agent's activity is worked out, so a tab and its dot can never disagree. */
export function mainTurnRunning(task: Pick<Task, 'activity'> | undefined): boolean {
  return task !== undefined && (task.activity === TaskActivity.Working || task.activity === TaskActivity.Paused)
}

/**
 * A task's agent tabs, split the way the strip shows them (#617): the ones that share its width — running, or
 * waiting on something they started (`AgentActivity`, #579, the same rule the dot uses) — and the finished ones,
 * named only in the caret's dropdown. Main isn't among either: it's pinned before them both.
 */
export interface AgentTabs {
  /** Newest first, as `agentsOf`'s order already has them. */
  readonly active: readonly string[]
  /**
   * By when each finished, the most recently finished first: the caret's "Finished, newest first". One Glade never
   * recorded an end for sorts after those that have one; ties keep the order they started in.
   */
  readonly finished: readonly string[]
}

const NO_TABS: AgentTabs = { active: [], finished: [] }

function deriveAgentTabs(
  ids: readonly string[],
  calls: ReadonlyMap<string, ToolCallEvent>,
  activity: ReadonlyMap<string | null, AgentActivity>,
): AgentTabs {
  const active: string[] = []
  const finished: string[] = []
  for (const id of ids) {
    if (isAgentActive(activity.get(id) ?? AgentActivity.Done)) active.push(id)
    else finished.push(id)
  }
  // `ids` has them by when they started; the dropdown reads "Finished, newest first", so by when they ended. A
  // stable sort keeps ties, and the ones with no recorded end, in the order they started in.
  finished.sort((a, b) => {
    const endA = calls.get(a)?.finishedAt ?? null
    const endB = calls.get(b)?.finishedAt ?? null
    if (endA === endB) return 0
    if (endA === null) return 1
    if (endB === null) return -1
    return endB - endA
  })
  return active.length === 0 && finished.length === 0 ? NO_TABS : { active, finished }
}

/** What's been worked out from one task's agent order and activity, so everything that reads its tabs for the same
 * render works it out once. */
const tabsCache = new WeakMap<readonly string[], WeakMap<ReadonlyMap<string | null, AgentActivity>, AgentTabs>>()

/** A task's agent tabs (`AgentTabs`, `deriveAgentTabs`), worked out once per (agent order, activity) pair, however
 * many read it. */
export function agentTabsOf(
  events: readonly ToolEvent[] | undefined,
  watchers: readonly Watcher[] | undefined,
  mainRunning: boolean,
): AgentTabs {
  const { ids, calls } = agentsOf(events)
  const activity = agentActivity(events, watchers, mainRunning)
  let byActivity = tabsCache.get(ids)
  if (byActivity === undefined) {
    byActivity = new WeakMap()
    tabsCache.set(ids, byActivity)
  }
  let tabs = byActivity.get(activity)
  if (tabs === undefined) {
    tabs = deriveAgentTabs(ids, calls, activity)
    byActivity.set(activity, tabs)
  }
  return tabs
}

/** `AgentTabs` from the store, by the task's id (#617). */
export function selectAgentTabs(
  state: Pick<GladeData, 'toolEvents' | 'watchers' | 'tasks'>,
  taskId: string,
): AgentTabs {
  return agentTabsOf(state.toolEvents[taskId], state.watchers[taskId], mainTurnRunning(state.tasks[taskId]))
}

/**
 * Whether the agent a task's Agents tab shows is a finished one (#617): true only while a finished subagent's tab is
 * picked, the strip's temporary tab after the active ones. Main and an active subagent are never finished.
 */
export function shownAgentFinished(
  state: Pick<GladeData, 'toolEvents' | 'watchers' | 'tasks' | 'agentTabs'>,
  taskId: string,
): boolean {
  const agentId = selectShownAgent(state, taskId)
  return agentId !== null && selectAgentTabs(state, taskId).finished.includes(agentId)
}

/** Below this, an active tab's name drops to the smaller type and whatever of it still fits (#617, the mockups'
 * "56px minimum"). */
export const MIN_ACTIVE_TAB_WIDTH = 56

/**
 * Whether the strip's active tabs (the temporary finished one among them included) are crowded past the 56px floor
 * (#617): each tab's fair share of `rowWidth`, once `gap` between them is taken out, is under `MIN_ACTIVE_TAB_WIDTH`.
 */
export function activeTabsCrowded(rowWidth: number, count: number, gap: number): boolean {
  if (count === 0) return false
  const perTab = (rowWidth - gap * (count - 1)) / count
  return perTab < MIN_ACTIVE_TAB_WIDTH
}

/** What an agent's tab is called: Main, or a subagent's name (`subagentName`). */
export function agentName(call: ToolCallEvent | undefined): string {
  return call === undefined ? MAIN_AGENT_NAME : subagentName(call)
}

/**
 * What a screen reader calls an agent's tab dot (#579): blue while it's running or still going in the background
 * (a watcher, a scheduled wakeup, a background command, or a child that's itself going, however deep), slate once
 * it's finished (`AgentActivity`). Main's pin reads the same way. "Working in the background" rather than naming a
 * watcher specifically: the reason can just as well be a child subagent still going after this one's own turn ended
 * (docs/product.md, "Working in the background").
 */
export function agentDotLabel(activity: AgentActivity): string {
  switch (activity) {
    case AgentActivity.Running:
      return 'Running'
    case AgentActivity.Waiting:
      return 'Working in the background'
    case AgentActivity.Done:
      return 'Finished'
  }
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

/**
 * Reads one agent's events from the store (`isAgentEvent`), as a list that's the same list for as long as they are:
 * an event of another agent of the task makes the store's log anew, and leaves this one as it was, so the list showing
 * this agent's doesn't render for it. One per list shown; it remembers the last log it read.
 */
export function agentEventsSelector(
  taskId: string,
  agentId: AgentId,
): (state: Pick<GladeData, 'toolEvents'>) => readonly ToolEvent[] {
  let read: readonly ToolEvent[] | undefined
  let last = NO_EVENTS
  return (state) => {
    const events = state.toolEvents[taskId]
    if (events === read) return last
    read = events
    const next = (events ?? NO_EVENTS).filter((event) => isAgentEvent(event, agentId))
    if (!sameItems(next, last)) last = next
    return last
  }
}

/**
 * Reads Main's GitHub notices from the store (#682): the task's messages left by the link watcher, in the order they
 * arrived, for the row each gets in Main's tool log at the time it arrived (#715). Empty, always, for a subagent: a
 * notice is only ever for the task's own agent. One per list shown; it remembers the last log it read.
 */
export function githubNoticeSelector(
  taskId: string,
  agentId: AgentId,
): (state: Pick<GladeData, 'messages'>) => readonly Message[] {
  let read: readonly Message[] | undefined
  let last = NO_MESSAGES
  return (state) => {
    if (agentId !== null) return NO_MESSAGES
    const messages = state.messages[taskId]
    if (messages === read) return last
    read = messages
    const next = (messages ?? NO_MESSAGES).filter((message) => message.source === MessageSource.Github)
    if (!sameItems(next, last)) last = next
    return last
  }
}

const MINUTE = 60_000

/** How long something ran, as the Agents tab says it: "42s" under a minute, then "6m", "1h 49m" and "3d". */
export function formatDuration(ms: number): string {
  return ms < MINUTE ? `${String(Math.floor(Math.max(ms, 0) / 1000))}s` : formatAge(0, ms)
}

/**
 * A subagent's state and how long it ran, or has run: "Running · 6m", "Done · 28m", "Failed · 3m". The state alone for
 * one that finished before Glade recorded when calls finish.
 */
export function agentStateLine(call: ToolCallEvent, now: EpochMs): string {
  const label = statusLabel(subagentStatus(call.state))
  const elapsed = elapsedMs({ call }, now)
  return elapsed === null ? label : `${label} · ${formatDuration(elapsed)}`
}

/**
 * How long ago a finished subagent ended, as the caret's dropdown says it ("2m", "1h 12m", #617): `formatDuration`
 * from when it finished. Null for one Glade never recorded an end for (`agentStateLine`'s same fallback).
 */
export function agentFinishedAgo(call: Pick<ToolCallEvent, 'finishedAt'>, now: EpochMs): string | null {
  return call.finishedAt === null ? null : formatDuration(now - call.finishedAt)
}

/**
 * The line under a subagent's `Agent` call in the list of the agent that started it: "Running · 29m" while it runs,
 * and once it has finished, how it ended and the first line of what it came to: "Done · 28m · Opened PR #511".
 */
export function agentCallResult(call: ToolCallEvent, now: EpochMs): string {
  const state = agentStateLine(call, now)
  const outcome = isRunning(call) ? '' : firstLine(call.output ?? '')
  return outcome === '' ? state : `${state} · ${outcome}`
}

/**
 * What the Prompt row under a subagent's line shows collapsed (#762): the prompt's first non-blank line, cut by CSS
 * to the one line once it's past the row's width.
 */
export function promptPreview(prompt: string): string {
  return firstLine(prompt)
}

/** What the line under the strip says before a subagent's todo: "Working on" until it has finished, then "Worked on". */
export function todoLineVerb(call: Pick<ToolCallEvent, 'state'>): string {
  switch (call.state) {
    case ToolCallState.Running:
    case ToolCallState.Paused:
      return 'Working on'
    case ToolCallState.Done:
    case ToolCallState.Error:
    case ToolCallState.Interrupted:
      return 'Worked on'
  }
}

/**
 * The todo a subagent works on (`subagentTodo`, #495): the one its `Agent` call named or was filed under since, else
 * the one the subagent that started it works on, however deep. Null for a subagent with no todo, one whose todo was
 * deleted, and until the task's filings are read.
 */
export function agentTodo(
  filings: readonly Filing[] | undefined,
  todos: readonly Todo[] | undefined,
  agents: TaskAgents,
  agentId: string,
): Todo | null {
  if (filings === undefined || todos === undefined) return null
  // Only the todos, the subagents and their filings say which todo a subagent works on (#535).
  const todoId = subagentTodo({ todos, subagents: [...agents.calls.values()], filings }, agentId)
  return todoId === null ? null : (todos.find(({ id }) => id === todoId) ?? null)
}

/**
 * Reads the todo a subagent works on from the store (`agentTodo`), working it out again only when the task's filings,
 * its todos or its tool log changed. One per line shown; it remembers what it last read.
 */
export function agentTodoSelector(
  taskId: string,
  agentId: string,
): (state: Pick<GladeData, 'filings' | 'todos' | 'toolEvents'>) => Todo | null {
  let read: readonly unknown[] = []
  let last: Todo | null = null
  return (state) => {
    const filings = state.filings[taskId]
    const todos = state.todos[taskId]?.items
    const agents = agentsOf(state.toolEvents[taskId])
    const inputs = [filings, todos, agents]
    if (!sameItems(inputs, read)) {
      read = inputs
      last = agentTodo(filings, todos, agents, agentId)
    }
    return last
  }
}

/**
 * What the Main tab's line says under its model (#566, design 64): the task's status summary, or, until the agent has
 * set one, what it's working on now — its running tool call. Null when it has neither.
 */
export function mainAgentText(
  task: Pick<Task, 'status'>,
  currentCall: ToolCallEvent | null,
  rootPath: string | undefined,
): string | null {
  if (task.status !== '') return task.status
  if (currentCall === null) return null
  return `${currentCall.name} ${argumentSummary(currentCall, rootPath)}`.trim()
}

/**
 * What the Main tab's line says at its right (design 64): "Running · 42m", by the task's age as the header's title
 * says it, while it works; nothing otherwise.
 */
export function mainAgentStateLine(working: boolean, createdAt: EpochMs, now: EpochMs): string | null {
  return working ? `Running · ${formatAge(createdAt, now)}` : null
}

/** Below this a token total shows as itself, which `formatTokens` would round to `0k` or `1k`. */
const THOUSAND_TOKENS = 1_000

/**
 * What Main's line says its turns have spent (#587, design 64): "1.2M in · 45k out" by the running totals. A total
 * under a thousand shows as itself, the way the context meter's `formatTokens` rounds it to `0k` and `1k` otherwise.
 */
export function mainTokensLine(totalInputTokens: number, totalOutputTokens: number): string {
  const tokens = (total: number): string => (total < THOUSAND_TOKENS ? String(total) : formatTokens(total))
  return `${tokens(totalInputTokens)} in · ${tokens(totalOutputTokens)} out`
}

/**
 * What an agent's line says of the agent its call started (#592): "1.2M in · 45k out" by the split of a dispatched
 * child, which is what it has really spent (#589); for a native subagent, "478k context" — how full its conversation
 * was at its latest request, as the SDK reports it, never what it has spent. The same under-a-thousand rule as Main's
 * line: a figure under a thousand shows as itself. Nothing when there is no figure, or what there is says zero.
 */
export function agentTokensLine(
  contextTokens: number | undefined,
  totalInputTokens: number | undefined,
  totalOutputTokens: number | undefined,
): string | null {
  if (totalInputTokens !== undefined && totalOutputTokens !== undefined) {
    if (totalInputTokens === 0 && totalOutputTokens === 0) return null
    return mainTokensLine(totalInputTokens, totalOutputTokens)
  }
  if (contextTokens === undefined || contextTokens === 0) return null
  return `${contextTokens < THOUSAND_TOKENS ? String(contextTokens) : formatTokens(contextTokens)} context`
}

/**
 * Main's current tool call, from the store: its last one still running, or null. A subagent's `Agent` call is not it —
 * the subagent has a tab of its own, and the line's fallback is for work the tab's log shows. One per log shown; the
 * selector remembers what it last read.
 */
export function selectMainCurrentCall(taskId: string): (state: Pick<GladeData, 'toolEvents'>) => ToolCallEvent | null {
  let read: readonly ToolEvent[] | undefined
  let last: ToolCallEvent | null = null
  return (state) => {
    const events = state.toolEvents[taskId]
    if (events === read) return last
    read = events
    last =
      (events ?? NO_EVENTS).findLast(
        (event): event is ToolCallEvent =>
          event.kind === ToolEventKind.ToolCall &&
          event.parentToolUseId === null &&
          event.state === ToolCallState.Running &&
          !isSubagentTool(event.name),
      ) ?? null
    return last
  }
}
