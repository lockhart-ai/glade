import { describe, expect, it } from 'vitest'
import { WatcherKind, WatcherState } from '../../shared/domain'
import { TaskIndicator } from '../../shared/taskIndicator'
import { sampleWatcher } from '../store/test-bridge'
import {
  formatDueIn,
  isLive,
  kindLabel,
  liveWatcherCount,
  metaLine,
  orderWatchers,
  outputLine,
  OutputLineKind,
  ownWatchers,
  statusLabel,
  subagentWatchers,
  tally,
  TallyGroup,
  wakesLabel,
  watcherIndicator,
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
    expect(subagentWatchers(watchers, 'toolu_api')).toEqual([api, apiEnded])
    expect(subagentWatchers(watchers, 'toolu_nested')).toEqual([nested])
    expect(subagentWatchers(watchers, 'toolu_none')).toEqual([])
  })

  it('lists the live ones first, in the order they started, then the ended ones, latest to end first', () => {
    const watchers = [
      sampleWatcher('a', 't1', { state: WatcherState.Finished, endedAt: at(12, 10) }),
      sampleWatcher('b', 't1', { state: WatcherState.Scheduled }),
      sampleWatcher('c', 't1', { state: WatcherState.Failed, endedAt: at(12, 40) }),
      sampleWatcher('d', 't1', { state: WatcherState.Running }),
      sampleWatcher('e', 't1', { state: WatcherState.Stopped, endedAt: null }),
    ]
    expect(orderWatchers(watchers).map(({ id }) => id)).toEqual(['b', 'd', 'c', 'a', 'e'])
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

  it('has a dot for each state: running blue, waiting purple, failed pink, ended slate', () => {
    expect(Object.values(WatcherState).map(watcherIndicator)).toEqual([
      TaskIndicator.Working,
      TaskIndicator.Waiting,
      TaskIndicator.Waiting,
      TaskIndicator.Done,
      TaskIndicator.Error,
      TaskIndicator.Done,
    ])
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

  it('counts its wakes, and says when it last woke the agent and when it runs', () => {
    expect([0, 1, 2].map(wakesLabel)).toEqual(['0 wakes', '1 wake', '2 wakes'])
    const now = at(13, 14, 4)
    const running = sampleWatcher('r', 't1', { wakes: 3, lastWokeAt: at(13, 10) })
    expect(metaLine(running, now)).toBe('3 wakes · last 13:10 · 12m 04s · since 13:02')
    expect(metaLine(sampleWatcher('r', 't1', { startedAt: now + 1_000 }), now)).toBe('0 wakes · 0s · since 13:14')

    const wakeup = { kind: WatcherKind.Wakeup, state: WatcherState.Scheduled, recurring: false, nextDueAt: at(14, 5) }
    expect(metaLine(sampleWatcher('w', 't1', wakeup), now)).toBe('0 wakes · at 14:05 · set 13:02')
    const cron = { kind: WatcherKind.Cron, state: WatcherState.Scheduled, recurring: true, nextDueAt: at(13, 20) }
    expect(metaLine(sampleWatcher('c', 't1', { ...cron, wakes: 1, lastWokeAt: at(13, 10) }), now)).toBe(
      '1 wake · last 13:10 · next 13:20 · set 13:02',
    )
    expect(metaLine(sampleWatcher('c', 't1', { ...cron, nextDueAt: null }), now)).toBe('0 wakes · set 13:02')
    expect(metaLine(sampleWatcher('c', 't1', { ...cron, state: WatcherState.Suspended }), now)).toBe(
      '0 wakes · back when the session resumes · set 13:02',
    )
    for (const state of [WatcherState.Finished, WatcherState.Failed, WatcherState.Stopped]) {
      expect(metaLine(sampleWatcher('e', 't1', { state, endedAt: at(13, 9) }), now)).toBe('0 wakes · 13:02–13:09')
      expect(metaLine(sampleWatcher('e', 't1', { state, endedAt: null }), now)).toBe('0 wakes · 13:02–13:02')
    }
  })

  it('tallies them by state, the ended ones together, leaving out a group with none', () => {
    const watchers = [
      sampleWatcher('a', 't1'),
      sampleWatcher('b', 't1'),
      sampleWatcher('c', 't1', { state: WatcherState.Scheduled }),
      sampleWatcher('d', 't1', { state: WatcherState.Finished }),
      sampleWatcher('e', 't1', { state: WatcherState.Failed }),
      sampleWatcher('f', 't1', { state: WatcherState.Stopped }),
    ]
    expect(tally(watchers)).toEqual([
      { group: TallyGroup.Running, label: '2 running' },
      { group: TallyGroup.Scheduled, label: '1 scheduled' },
      { group: TallyGroup.Ended, label: '3 ended' },
    ])
    expect(tally([sampleWatcher('s', 't1', { state: WatcherState.Suspended })])).toEqual([
      { group: TallyGroup.Suspended, label: '1 suspended' },
    ])
  })

  it('names the task list’s mark', () => {
    expect(watchingLabel(1)).toBe('1 watcher running')
    expect(watchingLabel(4)).toBe('4 watchers running')
  })
})
