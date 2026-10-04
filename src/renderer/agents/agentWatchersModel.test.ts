import { describe, expect, it } from 'vitest'
import { WatcherKind, WatcherState, type Watcher } from '../../shared/domain'
import { sampleWatcher } from '../store/test-bridge'
import { OutputLineKind } from '../watchers/watchersModel'
import {
  agentWatchers,
  endedLabel,
  endedOutputLine,
  endedSummary,
  endedTime,
  hasRunningWatcher,
  logWatchersSelector,
  pinnedCount,
  pinnedMetaLine,
  pinnedStatus,
  watchingTitle,
  wokeLabel,
} from './agentWatchersModel'

const at = (hour: number, minute: number, second = 0): number => new Date(2026, 8, 25, hour, minute, second).getTime()

function watcher(id: string, overrides: Partial<Watcher> = {}): Watcher {
  return sampleWatcher(id, 't1', { startedAt: at(13, 33), ...overrides })
}

const ended = (id: string, endedAt: number, overrides: Partial<Watcher> = {}): Watcher =>
  watcher(id, { state: WatcherState.Finished, endedAt, outcome: 'Monitor "CI" stream ended', ...overrides })

const scheduled = (id: string, overrides: Partial<Watcher> = {}): Watcher =>
  watcher(id, {
    kind: WatcherKind.Wakeup,
    state: WatcherState.Scheduled,
    recurring: false,
    nextDueAt: at(13, 50),
    startedAt: at(13, 36),
    ...overrides,
  })

describe('whose a watcher is', () => {
  const ci = watcher('ci')
  const preview = scheduled('preview')
  const tests = watcher('tests', { parentToolUseId: 'fix-501' })
  const lint = ended('lint', at(13, 41), { parentToolUseId: 'fix-501' })
  const docs = ended('docs', at(13, 38))
  const all = [ci, preview, tests, lint, docs]

  it('is the agent whose call started it: Main’s by null, a subagent’s by its Agent call', () => {
    expect(agentWatchers(all, null)).toEqual({
      pinned: [ci, preview],
      ended: [docs],
      startedBy: new Set(['toolu-ci', 'toolu-preview', 'toolu-docs']),
    })
    expect(agentWatchers(all, 'fix-501')).toEqual({
      pinned: [tests],
      ended: [lint],
      startedBy: new Set(['toolu-tests', 'toolu-lint']),
    })
  })

  it('has none for an agent that started none, and for a task whose watchers aren’t loaded', () => {
    expect(agentWatchers(all, 'docs-503')).toEqual({ pinned: [], ended: [], startedBy: new Set() })
    expect(agentWatchers(undefined, null)).toEqual({ pinned: [], ended: [], startedBy: new Set() })
    expect(agentWatchers([], null).pinned).toEqual([])
  })

  it('is worked out once for a list, however many agents read it', () => {
    expect(agentWatchers(all, null)).toBe(agentWatchers(all, null))
    expect(agentWatchers(all, 'fix-501')).toBe(agentWatchers(all, 'fix-501'))
  })

  it('pins a job that waits on its session, with what runs and what’s scheduled', () => {
    const queue = scheduled('queue', { kind: WatcherKind.Cron, state: WatcherState.Suspended })
    expect(agentWatchers([queue, docs], null).pinned).toEqual([queue])
  })

  it('puts the ended ones in the order they ended, and two that ended at once in the order they started', () => {
    const first = ended('first', at(13, 40))
    const second = ended('second', at(13, 45))
    const third = ended('third', at(13, 45))
    const unrecorded = watcher('unrecorded', { state: WatcherState.Stopped, startedAt: at(13, 42) })
    expect(agentWatchers([second, third, unrecorded, first], null).ended.map(({ id }) => id)).toEqual([
      'first',
      'unrecorded',
      'second',
      'third',
    ])
    expect(endedTime(first)).toBe(at(13, 40))
    expect(endedTime(unrecorded)).toBe(at(13, 42))
  })
})

describe('the eye on an agent’s tab', () => {
  it('counts everything pinned, scheduled ones included, and is live while a process runs', () => {
    const all = [watcher('ci'), scheduled('preview'), scheduled('later', { parentToolUseId: 'fix-501' })]

    expect(pinnedCount(all, null)).toBe(2)
    expect(hasRunningWatcher(all, null)).toBe(true)
    expect(pinnedCount(all, 'fix-501')).toBe(1)
    expect(hasRunningWatcher(all, 'fix-501')).toBe(false)
    expect(pinnedCount(all, 'docs-503')).toBe(0)
    expect(pinnedCount(undefined, null)).toBe(0)
    expect(hasRunningWatcher(undefined, null)).toBe(false)
  })

  it('doesn’t count a watcher that has ended', () => {
    expect(pinnedCount([ended('ci', at(13, 41))], null)).toBe(0)
  })

  it('says how many it’s watching', () => {
    expect(watchingTitle(1)).toBe('1 watching')
    expect(watchingTitle(2)).toBe('2 watching')
  })
})

describe('what an agent’s list reads of its watchers', () => {
  it('is the same value while its ended watchers and the calls that started one are', () => {
    const select = logWatchersSelector('t1', null)
    const ci = watcher('ci')
    const docs = ended('docs', at(13, 38))
    const first = select({ watchers: { t1: [ci, docs] } })
    expect(first).toEqual({ ended: [docs], startedBy: new Set(['toolu-ci', 'toolu-docs']) })

    // The live one reports a line and wakes the agent: a new list, with the ended one as it was.
    const reported = { ...ci, lastOutput: 'lint pass', wakes: 1 }
    expect(select({ watchers: { t1: [reported, docs] } })).toBe(first)
    // Another agent's watcher starts and ends.
    const other = ended('lint', at(13, 39), { parentToolUseId: 'fix-501' })
    expect(select({ watchers: { t1: [reported, docs, other] } })).toBe(first)
    // The same list read again.
    const again = { t1: [reported, docs, other] }
    expect(select({ watchers: again })).toBe(select({ watchers: again }))
  })

  it('changes when one ends, when an ended one changes, and when a call starts one', () => {
    const select = logWatchersSelector('t1', null)
    const ci = watcher('ci')
    const first = select({ watchers: { t1: [ci] } })

    const done = { ...ci, state: WatcherState.Finished, endedAt: at(13, 41) }
    const second = select({ watchers: { t1: [done] } })
    expect(second).not.toBe(first)
    expect(second.ended).toEqual([done])

    const woke = { ...done, wakes: 1 }
    const third = select({ watchers: { t1: [woke] } })
    expect(third.ended).toEqual([woke])

    const fourth = select({ watchers: { t1: [woke, scheduled('preview')] } })
    expect(fourth).not.toBe(third)
    expect(fourth.startedBy).toEqual(new Set(['toolu-ci', 'toolu-preview']))

    // One the same size, started by another call.
    const fifth = select({ watchers: { t1: [woke, scheduled('rollout')] } })
    expect(fifth.startedBy).toEqual(new Set(['toolu-ci', 'toolu-rollout']))
  })

  it('reads a subagent’s own, and nothing for a task with none loaded', () => {
    const select = logWatchersSelector('t1', 'fix-501')
    const lint = ended('lint', at(13, 39), { parentToolUseId: 'fix-501' })
    expect(select({ watchers: {} })).toEqual({ pinned: [], ended: [], startedBy: new Set() })
    expect(select({ watchers: { t1: [watcher('ci'), lint] } }).ended).toEqual([lint])
  })
})

describe('what a pinned watcher says', () => {
  it('says how long a running one has run, in its state', () => {
    const ci = watcher('ci')
    expect(pinnedStatus(ci, at(13, 33, 42))).toBe('Running · 42s')
    expect(pinnedStatus(ci, at(13, 38, 30))).toBe('Running · 5m')
    expect(pinnedStatus(ci, at(15, 22))).toBe('Running · 1h 49m')
    // A clock a moment behind the watcher's start.
    expect(pinnedStatus(ci, at(13, 32, 59))).toBe('Running · 0s')
  })

  it('says when a scheduled one is due, and that a suspended one is', () => {
    expect(pinnedStatus(scheduled('preview'), at(13, 38))).toBe('Due in 12m')
    expect(pinnedStatus(scheduled('preview'), at(13, 49, 30))).toBe('Due in 30s')
    expect(pinnedStatus(scheduled('preview', { nextDueAt: null }), at(13, 38))).toBe('Scheduled')
    expect(pinnedStatus(scheduled('queue', { state: WatcherState.Suspended }), at(13, 38))).toBe('Suspended')
  })

  it('counts a running one’s wakes, when it last woke the agent, and since when it has run', () => {
    expect(pinnedMetaLine(watcher('ci'))).toBe('0 wakes · since 13:33')
    expect(pinnedMetaLine(watcher('ci', { wakes: 3, lastWokeAt: at(13, 48) }))).toBe(
      '3 wakes · last 13:48 · since 13:33',
    )
    expect(pinnedMetaLine(watcher('ci', { wakes: 1, lastWokeAt: at(13, 40) }))).toBe(
      '1 wake · last 13:40 · since 13:33',
    )
  })

  it('says when a scheduled one is due first: at its time once, next for a job that comes round again', () => {
    expect(pinnedMetaLine(scheduled('preview'))).toBe('at 13:50 · 0 wakes · set 13:36')
    expect(
      pinnedMetaLine(
        scheduled('queue', { kind: WatcherKind.Cron, recurring: true, wakes: 10, lastWokeAt: at(13, 46) }),
      ),
    ).toBe('next 13:50 · 10 wakes · last 13:46 · set 13:36')
    expect(pinnedMetaLine(scheduled('preview', { nextDueAt: null }))).toBe('0 wakes · set 13:36')
  })

  it('says a suspended job comes back with its session', () => {
    expect(
      pinnedMetaLine(scheduled('queue', { state: WatcherState.Suspended, wakes: 4, lastWokeAt: at(13, 40) })),
    ).toBe('back when the session resumes · 4 wakes · last 13:40 · set 13:36')
  })
})

describe('what an ended watcher’s row says', () => {
  it('says how often it woke the agent, in words', () => {
    expect(wokeLabel(0)).toBe('didn’t wake the agent')
    expect(wokeLabel(1)).toBe('woke the agent once')
    expect(wokeLabel(4)).toBe('woke the agent 4 times')
  })

  it('says how it ended, how long it ran and how often it woke the agent', () => {
    const ci = ended('ci', at(13, 41), { wakes: 1 })
    expect(endedLabel(ci)).toBe('Finished')
    expect(endedSummary(ci)).toBe('ran 8m · woke the agent once')

    const docs = ended('docs', at(13, 35), { state: WatcherState.Failed, wakes: 1 })
    expect(endedLabel(docs)).toBe('Failed')
    expect(endedSummary(docs)).toBe('ran 2m · woke the agent once')

    const queue = ended('queue', at(14, 12), { state: WatcherState.Stopped, wakes: 4 })
    expect(endedLabel(queue)).toBe('Stopped')
    expect(endedSummary(queue)).toBe('ran 39m · woke the agent 4 times')

    expect(endedSummary(ended('quick', at(13, 33, 20)))).toBe('ran 20s · didn’t wake the agent')
  })

  it('leaves out how long one ran when its end wasn’t recorded', () => {
    const lost = watcher('lost', { state: WatcherState.Stopped, wakes: 2 })
    expect(endedLabel(lost)).toBe('Stopped')
    expect(endedSummary(lost)).toBe('woke the agent 2 times')
  })

  it('says what a finished one last reported, and how a failed or stopped one ended', () => {
    const found = ended('ci', at(13, 41), { lastOutput: 'unit-tests fail test_retry_after_burst' })
    expect(endedOutputLine(found)).toEqual({
      kind: OutputLineKind.Last,
      text: 'unit-tests fail test_retry_after_burst',
    })

    const failed = ended('docs', at(13, 35), {
      state: WatcherState.Failed,
      lastOutput: 'building…',
      outcome: 'npm run build:docs failed with exit code 1',
    })
    expect(endedOutputLine(failed)).toEqual({
      kind: OutputLineKind.End,
      text: 'npm run build:docs failed with exit code 1',
    })

    const stopped = ended('queue', at(14, 12), {
      state: WatcherState.Stopped,
      lastOutput: 'depth 12',
      outcome: 'You stopped it.',
    })
    expect(endedOutputLine(stopped)).toEqual({ kind: OutputLineKind.End, text: 'You stopped it.' })
  })

  it('falls back to the other line, and has none with neither', () => {
    expect(endedOutputLine(ended('fired', at(13, 50), { outcome: 'It fired.' }))).toEqual({
      kind: OutputLineKind.End,
      text: 'It fired.',
    })
    expect(
      endedOutputLine(ended('cut', at(13, 50), { state: WatcherState.Stopped, outcome: null, lastOutput: 'tick 3' })),
    ).toEqual({ kind: OutputLineKind.Last, text: 'tick 3' })
    expect(endedOutputLine(ended('bare', at(13, 50), { outcome: null }))).toBeNull()
  })
})
