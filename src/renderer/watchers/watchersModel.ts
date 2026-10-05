// What the Agents tab's pinned watchers (`../agents/PinnedWatchers`) and the task list's watcher marks show of a task's
// watchers: what its agents left running or scheduled with the SDK's own tools (docs/sdk-notes.md §13).
import { LIVE_WATCHER_STATES, WatcherKind, WatcherState, type EpochMs, type Watcher } from '../../shared/domain'

/** Whether a watcher can still wake the agent: running, scheduled, or waiting for its session to resume. */
export function isLive(watcher: Watcher): boolean {
  return LIVE_WATCHER_STATES.includes(watcher.state)
}

/** The watchers the task's own agent started. A subagent's are its own, pinned on its tab of the Agents tab. */
export function ownWatchers(watchers: readonly Watcher[]): Watcher[] {
  return watchers.filter((watcher) => watcher.parentToolUseId === null)
}

/** How many of a task's own watchers are live: the task list's mark. Its subagents' don't count (`ownWatchers`). */
export function liveWatcherCount(watchers: readonly Watcher[] | undefined): number {
  return ownWatchers(watchers ?? []).filter(isLive).length
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

/** How the task list's watcher count reads to a screen reader and in its tooltip: "2 watchers running". */
export function watchingLabel(count: number): string {
  return `${String(count)} watcher${count === 1 ? '' : 's'} running`
}
