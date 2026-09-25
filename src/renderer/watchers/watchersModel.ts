// What the Watchers tab (docs/design/html/27-watchers.html) and the task list's watcher marks show of a task's
// watchers: what its agent left running or scheduled with the SDK's own tools (docs/sdk-notes.md §13).
import { LIVE_WATCHER_STATES, WatcherKind, WatcherState, type EpochMs, type Watcher } from '../../shared/domain'
import { TaskIndicator } from '../../shared/taskIndicator'
import { clockTime } from '../chat/chatModel'
import { formatElapsed } from '../subagents/subagentsModel'

/** Whether a watcher can still wake the agent: running, scheduled, or waiting for its session to resume. */
export function isLive(watcher: Watcher): boolean {
  return LIVE_WATCHER_STATES.includes(watcher.state)
}

/** How many of a task's watchers are live: the tab's count, and the task list's mark. */
export function liveWatcherCount(watchers: readonly Watcher[] | undefined): number {
  return watchers?.filter(isLive).length ?? 0
}

/** The tab's order: the live ones first, in the order they started, then the ended ones, the latest to end first. */
export function orderWatchers(watchers: readonly Watcher[]): Watcher[] {
  const live = watchers.filter(isLive)
  const ended = watchers.filter((watcher) => !isLive(watcher))
  return [...live, ...ended.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))]
}

/** What a watcher's kind is called: the SDK tool the agent started it with, in words. */
export function kindLabel(kind: WatcherKind): string {
  switch (kind) {
    case WatcherKind.Monitor:
      return 'Monitor'
    case WatcherKind.Command:
      return 'Command'
    case WatcherKind.Wakeup:
      return 'Wakeup'
    case WatcherKind.Cron:
      return 'Cron'
  }
}

/** A duration until something, as the status says it: "in 42s", "in 4m", "in 1h 12m"; "now" once it's due. */
export function formatDueIn(at: EpochMs, now: EpochMs): string {
  const seconds = Math.ceil((at - now) / 1000)
  if (seconds <= 0) return 'now'
  if (seconds < 60) return `in ${String(seconds)}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `in ${String(minutes)}m`
  return `in ${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** What a watcher's state says beside its name: "Running", "Due in 4m", "Suspended", "Finished", … */
export function statusLabel(watcher: Watcher, now: EpochMs): string {
  switch (watcher.state) {
    case WatcherState.Running:
      return 'Running'
    case WatcherState.Scheduled:
      return watcher.nextDueAt === null ? 'Scheduled' : `Due ${formatDueIn(watcher.nextDueAt, now)}`
    case WatcherState.Suspended:
      return 'Suspended'
    case WatcherState.Finished:
      return 'Finished'
    case WatcherState.Failed:
      return 'Failed'
    case WatcherState.Stopped:
      return 'Stopped'
  }
}

/** A watcher's dot: running blue, scheduled or suspended purple (waiting), failed pink, ended slate. */
export function watcherIndicator(state: WatcherState): TaskIndicator {
  switch (state) {
    case WatcherState.Running:
      return TaskIndicator.Working
    case WatcherState.Scheduled:
    case WatcherState.Suspended:
      return TaskIndicator.Waiting
    case WatcherState.Failed:
      return TaskIndicator.Error
    case WatcherState.Finished:
    case WatcherState.Stopped:
      return TaskIndicator.Done
  }
}

/** What a watcher runs, beside its kind: the command, a wakeup's prompt, or a cron job's schedule. */
export function whatLine(watcher: Watcher): string {
  switch (watcher.kind) {
    case WatcherKind.Monitor:
    case WatcherKind.Command:
    case WatcherKind.Wakeup:
      return watcher.detail
    case WatcherKind.Cron:
      return watcher.schedule ?? ''
  }
}

/** Which line a watcher's latest line is: what it last reported, or how it ended. */
export enum OutputLineKind {
  Last = 'last',
  End = 'end',
}

export interface OutputLine {
  readonly kind: OutputLineKind
  readonly text: string
}

/** A live watcher's last report, or how an ended one ended; null when there's nothing to say yet. */
export function outputLine(watcher: Watcher): OutputLine | null {
  if (!isLive(watcher)) return watcher.outcome === null ? null : { kind: OutputLineKind.End, text: watcher.outcome }
  return watcher.lastOutput === null ? null : { kind: OutputLineKind.Last, text: watcher.lastOutput }
}

/** "3 wakes", "1 wake". */
export function wakesLabel(wakes: number): string {
  return `${String(wakes)} wake${wakes === 1 ? '' : 's'}`
}

/**
 * The line under a watcher: how many times it woke the agent and when it last did, then when it's due (scheduled),
 * how long it has run and since when (running), or when it ran (ended): "3 wakes · last 13:18 · 12m 04s · since 13:02".
 */
export function metaLine(watcher: Watcher, now: EpochMs): string {
  const parts = [wakesLabel(watcher.wakes)]
  if (watcher.lastWokeAt !== null) parts.push(`last ${clockTime(watcher.lastWokeAt)}`)
  switch (watcher.state) {
    case WatcherState.Running:
      parts.push(formatElapsed(Math.max(0, now - watcher.startedAt)), `since ${clockTime(watcher.startedAt)}`)
      break
    case WatcherState.Scheduled:
      if (watcher.nextDueAt !== null) parts.push(`${watcher.recurring ? 'next' : 'at'} ${clockTime(watcher.nextDueAt)}`)
      parts.push(`set ${clockTime(watcher.startedAt)}`)
      break
    case WatcherState.Suspended:
      parts.push('back when the session resumes', `set ${clockTime(watcher.startedAt)}`)
      break
    case WatcherState.Finished:
    case WatcherState.Failed:
    case WatcherState.Stopped:
      parts.push(`${clockTime(watcher.startedAt)}–${clockTime(watcher.endedAt ?? watcher.startedAt)}`)
      break
  }
  return parts.join(' · ')
}

/** How the tally groups watchers: live ones by state, the ended ones together. */
export enum TallyGroup {
  Running = 'running',
  Scheduled = 'scheduled',
  Suspended = 'suspended',
  Ended = 'ended',
}

const TALLY_GROUPS: readonly TallyGroup[] = Object.values(TallyGroup)

function tallyGroup(state: WatcherState): TallyGroup {
  switch (state) {
    case WatcherState.Running:
      return TallyGroup.Running
    case WatcherState.Scheduled:
      return TallyGroup.Scheduled
    case WatcherState.Suspended:
      return TallyGroup.Suspended
    case WatcherState.Finished:
    case WatcherState.Failed:
    case WatcherState.Stopped:
      return TallyGroup.Ended
  }
}

export interface TallyPart {
  readonly group: TallyGroup
  readonly label: string
}

/** The tally at the top of the tab: "2 running · 1 scheduled · 3 ended", leaving out a group with none. */
export function tally(watchers: readonly Watcher[]): TallyPart[] {
  return TALLY_GROUPS.flatMap((group) => {
    const count = watchers.filter((watcher) => tallyGroup(watcher.state) === group).length
    return count === 0 ? [] : [{ group, label: `${String(count)} ${group}` }]
  })
}

/** How the task list's mark reads to a screen reader and in its tooltip: "Watching 2 things". */
export function watchingLabel(count: number): string {
  return `Watching ${String(count)} thing${count === 1 ? '' : 's'}`
}
