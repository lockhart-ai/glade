import { describe, expect, it } from 'vitest'
import { WatcherKind, WatcherState } from '../../shared/domain'
import { sampleWatcher } from '../store/test-bridge'
import {
  formatDueIn,
  isLive,
  kindLabel,
  liveWatcherCount,
  outputLine,
  OutputLineKind,
  ownWatchers,
  statusLabel,
  wakesLabel,
  watchingLabel,
  whatLine,
} from './watchersModel'

const at = (hour: number, minute: number, second = 0): number => new Date(2026, 8, 25, hour, minute, second).getTime()

describe('which watchers are live', () => {
  it('counts the running, scheduled and suspended ones, and none for a task with none loaded', () => {
    const watchers = Object.values(WatcherState).map((state) => sampleWatcher(state, 't1', { state }))
    expect(watchers.filter(isLive).map(({ state }) => state)).toEqual([
      WatcherState.Running,
      WatcherState.Scheduled,
      WatcherState.Suspended,
    ])
    expect(liveWatcherCount(watchers)).toBe(3)
    expect(liveWatcherCount(undefined)).toBe(0)
    expect(liveWatcherCount([])).toBe(0)
  })

  it('counts only the task’s own: a subagent’s are its own, under it (#291)', () => {
    const own = sampleWatcher('own', 't1')
    const api = sampleWatcher('api', 't1', { parentToolUseId: 'toolu_api' })
    const apiEnded = sampleWatcher('api-ended', 't1', { parentToolUseId: 'toolu_api', state: WatcherState.Finished })
    const nested = sampleWatcher('nested', 't1', { parentToolUseId: 'toolu_nested' })
    const watchers = [own, api, apiEnded, nested]
    expect(liveWatcherCount(watchers)).toBe(1)
    expect(liveWatcherCount([api, nested])).toBe(0)
    expect(ownWatchers(watchers)).toEqual([own])
  })
})

describe('how a watcher reads', () => {
  it('names its kind', () => {
    expect(Object.values(WatcherKind).map(kindLabel)).toEqual(['Monitor', 'Command', 'Wakeup', 'Cron'])
  })

  it('says when it’s due, to the second under a minute, the minute under an hour, and hours past that', () => {
    const now = at(13, 7, 30)
    expect(formatDueIn(now - 1, now)).toBe('now')
    expect(formatDueIn(now, now)).toBe('now')
    expect(formatDueIn(now + 42_000, now)).toBe('in 42s')
    expect(formatDueIn(now + 4 * 60_000, now)).toBe('in 4m')
    expect(formatDueIn(now + 72 * 60_000, now)).toBe('in 1h 12m')
  })

  it('says its state beside its name, with when a scheduled one is due', () => {
    const now = at(13, 7)
    const label = (state: WatcherState, nextDueAt: number | null = null) =>
      statusLabel(sampleWatcher('w', 't1', { state, nextDueAt }), now)
    expect(label(WatcherState.Running)).toBe('Running')
    expect(label(WatcherState.Scheduled, at(13, 11))).toBe('Due in 4m')
    expect(label(WatcherState.Scheduled)).toBe('Scheduled')
    expect(label(WatcherState.Suspended)).toBe('Suspended')
    expect(label(WatcherState.Finished)).toBe('Finished')
    expect(label(WatcherState.Failed)).toBe('Failed')
    expect(label(WatcherState.Stopped)).toBe('Stopped')
  })

  it('says what it runs: the command, a wakeup’s prompt, or a cron job’s schedule', () => {
    expect(whatLine(sampleWatcher('m', 't1'))).toBe('gh pr checks 42 --watch')
    expect(whatLine(sampleWatcher('c', 't1', { kind: WatcherKind.Command, detail: 'npm test' }))).toBe('npm test')
    expect(whatLine(sampleWatcher('w', 't1', { kind: WatcherKind.Wakeup, detail: 'Check it.' }))).toBe('Check it.')
    expect(whatLine(sampleWatcher('j', 't1', { kind: WatcherKind.Cron, schedule: 'Every 10 minutes' }))).toBe(
      'Every 10 minutes',
    )
    expect(whatLine(sampleWatcher('j', 't1', { kind: WatcherKind.Cron, schedule: null }))).toBe('')
  })

  it('shows a live one’s last report, and how an ended one ended', () => {
    expect(outputLine(sampleWatcher('a', 't1'))).toBeNull()
    expect(outputLine(sampleWatcher('a', 't1', { lastOutput: 'lint pass' }))).toEqual({
      kind: OutputLineKind.Last,
      text: 'lint pass',
    })
    expect(
      outputLine(
        sampleWatcher('a', 't1', { state: WatcherState.Stopped, lastOutput: 'x', outcome: 'You stopped it.' }),
      ),
    ).toEqual({ kind: OutputLineKind.End, text: 'You stopped it.' })
    expect(outputLine(sampleWatcher('a', 't1', { state: WatcherState.Finished }))).toBeNull()
  })

  it('counts its wakes', () => {
    expect([0, 1, 2].map(wakesLabel)).toEqual(['0 wakes', '1 wake', '2 wakes'])
  })

  it('names the task list’s mark', () => {
    expect(watchingLabel(1)).toBe('1 watcher running')
    expect(watchingLabel(4)).toBe('4 watchers running')
  })
})
