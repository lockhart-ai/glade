/**
 * What the Agents tab shows (P16, #536; `docs/design/html/50-agents.html`), worked out from a task's tool events: its
 * agents (the task's own, Main, and a subagent for every `Agent` call, nested ones included), the order of their tabs,
 * which one is showing, and what the lines about a subagent say.
 *
 * An agent is named by its `AgentId`: a subagent by the `tool_use` id of the `Agent` call that started it, and Main by
 * null.
 */
import {
  ToolCallState,
  ToolEventKind,
  type EpochMs,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { isSubagentTool, subagentName } from '../../shared/subagents'
import { subagentTodo, type Filing } from '../../shared/todoHub'
import { firstLine } from '../../shared/toolSummary'
import type { GladeData } from '../store/state'
import { elapsedMs, statusLabel, subagentStatus } from '../subagents/subagentsModel'
import { formatAge } from '../task-header/headerModel'
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

/** What an agent's tab is called: Main, or a subagent's name (`subagentName`). */
export function agentName(call: ToolCallEvent | undefined): string {
  return call === undefined ? MAIN_AGENT_NAME : subagentName(call)
}

/** What a screen reader calls the dot on a subagent's tab: blue while it runs, slate once it has finished. */
export function agentDotLabel(running: boolean): string {
  return running ? 'Running' : 'Finished'
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
 * The line under a subagent's `Agent` call in the list of the agent that started it: "Running · 29m" while it runs,
 * and once it has finished, how it ended and the first line of what it came to: "Done · 28m · Opened PR #511".
 */
export function agentCallResult(call: ToolCallEvent, now: EpochMs): string {
  const state = agentStateLine(call, now)
  const outcome = isRunning(call) ? '' : firstLine(call.output ?? '')
  return outcome === '' ? state : `${state} · ${outcome}`
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
