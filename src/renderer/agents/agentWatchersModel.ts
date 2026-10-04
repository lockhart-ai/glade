/**
 * What the Agents tab shows of a task's watchers (P16, #537; `docs/design/html/52-agents-watcher.html`,
 * `53-agents-watcher-done.html`), worked out from the task's watchers: whose each one is, which are pinned under an
 * agent's tool calls and which are rows among them, and what each says. What a watcher is called, what it runs and
 * what it last reported are in `../watchers/watchersModel`.
 *
 * A watcher belongs to the agent whose call started it: a subagent's by that subagent's `Agent` call
 * (`Watcher.parentToolUseId`), and the task's own agent's, Main's, by null. While it's live (its process runs, it's
 * scheduled, or it waits for its session to resume) it's pinned under that agent's tool calls; once it has ended it's a
 * row among them, at the time it ended. Either way the call that started it isn't a row of its own.
 */
import { WatcherState, type EpochMs, type Watcher } from '../../shared/domain'
import { clockTime } from '../chat/chatModel'
import type { GladeData } from '../store/state'
import type { LogWatchers } from '../tool-log/toolLogModel'
import { isLive, OutputLineKind, statusLabel, wakesLabel, type OutputLine } from '../watchers/watchersModel'
import { formatDuration, type AgentId } from './agentsModel'

/** One agent's watchers, as its tab shows them. */
export interface AgentWatchers extends LogWatchers {
  /** What's pinned under its tool calls: its live watchers, in the order they started. */
  readonly pinned: readonly Watcher[]
}

const NO_WATCHERS: AgentWatchers = { pinned: [], ended: [], startedBy: new Set<string>() }

/** When a watcher ended; one whose end wasn't recorded counts as ending when it started. */
export function endedTime(watcher: Pick<Watcher, 'startedAt' | 'endedAt'>): EpochMs {
  return watcher.endedAt ?? watcher.startedAt
}

function deriveWatchers(watchers: readonly Watcher[]): ReadonlyMap<AgentId, AgentWatchers> {
  const byAgent = new Map<AgentId, Watcher[]>()
  for (const watcher of watchers) {
    const own = byAgent.get(watcher.parentToolUseId)
    if (own === undefined) byAgent.set(watcher.parentToolUseId, [watcher])
    else own.push(watcher)
  }
  return new Map(
    [...byAgent].map(([agentId, own]) => [
      agentId,
      {
        pinned: own.filter(isLive),
        // A sort keeps the order they started in for two that ended at once.
        ended: own.filter((watcher) => !isLive(watcher)).sort((a, b) => endedTime(a) - endedTime(b)),
        startedBy: new Set(own.map(({ toolUseId }) => toolUseId)),
      },
    ]),
  )
}

/** What's been worked out from each list of watchers, so every tab, card and list reads it once per change. */
const derived = new WeakMap<readonly Watcher[], ReadonlyMap<AgentId, AgentWatchers>>()

/**
 * One agent's watchers, from the task's: the ones its own calls started. Worked out once per list (the store keeps a
 * list until one of its watchers changes), for every agent in one pass, however many read it.
 */
export function agentWatchers(watchers: readonly Watcher[] | undefined, agentId: AgentId): AgentWatchers {
  if (watchers === undefined) return NO_WATCHERS
  let byAgent = derived.get(watchers)
  if (byAgent === undefined) {
    byAgent = deriveWatchers(watchers)
    derived.set(watchers, byAgent)
  }
  return byAgent.get(agentId) ?? NO_WATCHERS
}

/** How many watchers an agent has pinned, scheduled ones included: the count beside the eye on its tab. */
export function pinnedCount(watchers: readonly Watcher[] | undefined, agentId: AgentId): number {
  return agentWatchers(watchers, agentId).pinned.length
}

/**
 * Whether one of an agent's watchers has its process running: the eye on its tab is then blue. With only a wakeup or
 * a cron job scheduled, it's grey.
 */
export function hasRunningWatcher(watchers: readonly Watcher[] | undefined, agentId: AgentId): boolean {
  return agentWatchers(watchers, agentId).pinned.some(({ state }) => state === WatcherState.Running)
}

/** What the eye on an agent's tab says to a screen reader and in its tooltip: "2 watching". */
export function watchingTitle(count: number): string {
  return `${String(count)} watching`
}

function sameItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index])
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  return a.size === b.size && [...a].every((item) => b.has(item))
}

/**
 * Reads what an agent's list shows of its watchers from the store: the ended ones, and which calls started one. It's
 * the same value for as long as those are, so a pinned watcher reporting a line, waking the agent or coming due doesn't
 * render the list above it. One per list shown; it remembers the last list of watchers it read.
 */
export function logWatchersSelector(
  taskId: string,
  agentId: AgentId,
): (state: Pick<GladeData, 'watchers'>) => LogWatchers {
  let read: readonly Watcher[] | undefined
  let last: LogWatchers = NO_WATCHERS
  return (state) => {
    const watchers = state.watchers[taskId]
    if (watchers === read) return last
    read = watchers
    const { ended, startedBy } = agentWatchers(watchers, agentId)
    if (!sameItems(ended, last.ended) || !sameSet(startedBy, last.startedBy)) last = { ended, startedBy }
    return last
  }
}

/** A pinned watcher's state beside its name: "Running · 5m", "Due in 12m", "Suspended". */
export function pinnedStatus(watcher: Watcher, now: EpochMs): string {
  const label = statusLabel(watcher, now)
  return watcher.state === WatcherState.Running ? `${label} · ${formatDuration(now - watcher.startedAt)}` : label
}

/**
 * The last line of a pinned watcher: how many times it woke the agent and when it last did, and since when it has run
 * ("3 wakes · last 13:18 · since 13:02"); for one that's scheduled, when it's due first ("at 13:50 · 0 wakes · set
 * 13:36", "next" for a job that comes round again); and for a job waiting on its session, that it does.
 */
export function pinnedMetaLine(watcher: Watcher): string {
  const wakes = [
    wakesLabel(watcher.wakes),
    ...(watcher.lastWokeAt === null ? [] : [`last ${clockTime(watcher.lastWokeAt)}`]),
  ]
  const started = clockTime(watcher.startedAt)
  if (watcher.state === WatcherState.Running) return [...wakes, `since ${started}`].join(' · ')
  const due =
    watcher.state === WatcherState.Suspended
      ? ['back when the session resumes']
      : watcher.nextDueAt === null
        ? []
        : [`${watcher.recurring ? 'next' : 'at'} ${clockTime(watcher.nextDueAt)}`]
  return [...due, ...wakes, `set ${started}`].join(' · ')
}

/** How often a watcher woke the agent, in words: "woke the agent once", "woke the agent 4 times". */
export function wokeLabel(wakes: number): string {
  if (wakes === 0) return 'didn’t wake the agent'
  return wakes === 1 ? 'woke the agent once' : `woke the agent ${String(wakes)} times`
}

/** How an ended watcher ended, in a word: "Finished", "Failed", "Stopped". */
export function endedLabel(watcher: Watcher): string {
  return statusLabel(watcher, endedTime(watcher))
}

/**
 * What an ended watcher's row says after how it ended: how long it ran and how often it woke the agent ("ran 8m · woke
 * the agent once"). Just the wakes for one whose end wasn't recorded.
 */
export function endedSummary(watcher: Watcher): string {
  const woke = wokeLabel(watcher.wakes)
  return watcher.endedAt === null ? woke : `ran ${formatDuration(watcher.endedAt - watcher.startedAt)} · ${woke}`
}

/**
 * The last line of an ended watcher's row. One that finished says what it last reported, which is what it found
 * ("last  unit-tests fail test_retry_after_burst"); one that failed or was stopped says how ("end  npm run build:docs
 * failed with exit code 1", "end  You stopped it."). Each falls back to the other, and there's no line with neither.
 */
export function endedOutputLine(watcher: Watcher): OutputLine | null {
  const last = watcher.lastOutput === null ? null : { kind: OutputLineKind.Last, text: watcher.lastOutput }
  const end = watcher.outcome === null ? null : { kind: OutputLineKind.End, text: watcher.outcome }
  return watcher.state === WatcherState.Finished ? (last ?? end) : (end ?? last)
}
