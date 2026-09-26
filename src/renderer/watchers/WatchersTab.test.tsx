import { act, fireEvent, render as renderUnwrapped, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { WatcherKind, WatcherState, type Watcher } from '../../shared/domain'
import { refuse, sampleWatcher } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { WATCHERS_REFRESH_MS, WatchersTab } from './WatchersTab'

/** Renders under a store, which Stop acts through. */
function render(ui: React.ReactElement, wrapper = storeWrapper()) {
  return renderUnwrapped(ui, { wrapper: wrapper.wrapper })
}

const at = (hour: number, minute: number, second = 0): number => new Date(2026, 8, 25, hour, minute, second).getTime()

/** One of each, as the design shows them (28-watchers.html). */
const WATCHERS: readonly Watcher[] = [
  sampleWatcher('ci', 't1', { wakes: 3, lastWokeAt: at(13, 18), lastOutput: 'unit-tests\tfail\t2m13s' }),
  sampleWatcher('tests', 't1', {
    kind: WatcherKind.Command,
    label: 'Integration tests',
    detail: 'npm run test:integration',
    recurring: false,
    startedAt: at(13, 10),
  }),
  sampleWatcher('docs', 't1', {
    kind: WatcherKind.Command,
    label: 'Build the docs site',
    detail: 'npm run build:docs',
    state: WatcherState.Failed,
    wakes: 1,
    lastWokeAt: at(12, 33),
    outcome: 'Background command "Build the docs site" failed with exit code 1',
    startedAt: at(12, 31),
    endedAt: at(12, 33),
  }),
  sampleWatcher('rollout', 't1', {
    kind: WatcherKind.Wakeup,
    label: 'Check the docs rollout',
    detail: 'Check whether the docs rollout finished, and report.',
    state: WatcherState.Scheduled,
    recurring: false,
    nextDueAt: at(13, 26),
    startedAt: at(13, 21),
  }),
  sampleWatcher('queue', 't1', {
    kind: WatcherKind.Cron,
    label: 'Check the staging queue depth.',
    detail: 'Check the staging queue depth.',
    schedule: 'Every 10 minutes',
    state: WatcherState.Suspended,
    startedAt: at(12, 5),
  }),
]

/** One of `WATCHERS`, by its id. */
function sample(id: string): Watcher {
  const found = WATCHERS.find((watcher) => watcher.id === id)
  if (found === undefined) throw new Error(`No sample watcher ${id}`)
  return found
}

function row(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('WatchersTab', () => {
  it('says when the agent has left nothing running or scheduled', () => {
    render(<WatchersTab taskId="t1" watchers={[]} />)
    expect(screen.getByText('Nothing running or scheduled.')).toBeInTheDocument()
  })

  it('tallies them and lists each, the live ones first, with its kind, what it runs, its last line and its wakes', () => {
    vi.useFakeTimers({ now: at(13, 22, 4) })
    render(<WatchersTab taskId="t1" watchers={WATCHERS} />)

    expect(screen.getByRole('group', { name: 'Watchers by state' })).toHaveTextContent(
      '2 running1 scheduled1 suspended1 ended',
    )
    expect(
      screen.getAllByRole('group', { name: /CI|tests|docs|staging/ }).map((element) => element.dataset.state),
    ).toEqual(['running', 'running', 'scheduled', 'suspended', 'failed'])
    expect(row('CI checks on PR #42')).toHaveTextContent(
      'CI checks on PR #42RunningStopMonitorgh pr checks 42 --watchlastunit-tests fail 2m13s' +
        '3 wakes · last 13:18 · 20m 04s · since 13:02',
    )
    expect(row('Integration tests')).toHaveTextContent('RunningStopCommandnpm run test:integration0 wakes · 12m 04s')
    expect(row('Check the docs rollout')).toHaveTextContent(
      'Due in 4mStopWakeupCheck whether the docs rollout finished, and report.0 wakes · at 13:26 · set 13:21',
    )
    expect(row('Check the staging queue depth.')).toHaveTextContent(
      'SuspendedStopCronEvery 10 minutes0 wakes · back when the session resumes · set 12:05',
    )
    expect(row('Build the docs site')).toHaveTextContent(
      'Build the docs siteFailedCommandnpm run build:docsend' +
        'Background command "Build the docs site" failed with exit code 11 wake · last 12:33 · 12:31–12:33',
    )
    expect(within(row('Build the docs site')).queryByRole('button')).not.toBeInTheDocument()
    // The full text is a hover away where a line is cut short.
    expect(within(row('CI checks on PR #42')).getByText('gh pr checks 42 --watch')).toHaveAttribute(
      'title',
      'gh pr checks 42 --watch',
    )
  })

  it('leaves out what a subagent started: that’s under the subagent (#291)', () => {
    const subagents = [
      sampleWatcher('sub', 't1', { label: 'A subagent’s e2e run', parentToolUseId: 'use-api' }),
      sampleWatcher('sub-ended', 't1', {
        label: 'A subagent’s lint',
        parentToolUseId: 'use-api',
        state: WatcherState.Finished,
      }),
    ]
    const { rerender } = render(<WatchersTab taskId="t1" watchers={[sample('ci'), ...subagents]} />)
    expect(screen.getByRole('group', { name: 'Watchers by state' })).toHaveTextContent(/^1 running$/)
    expect(screen.queryByText('A subagent’s e2e run')).toBeNull()

    rerender(<WatchersTab taskId="t1" watchers={subagents} />)
    expect(screen.getByText('Nothing running or scheduled.')).toBeInTheDocument()
  })

  it('stops a live watcher with its Stop, and says so if main refuses', async () => {
    const stoppedWatchers: string[] = []
    const wrapper = storeWrapper({ watchers: [...WATCHERS], stoppedWatchers })
    render(<WatchersTab taskId="t1" watchers={WATCHERS} />, wrapper)

    fireEvent.click(screen.getByRole('button', { name: 'Stop Check the docs rollout' }))
    await act(() => Promise.resolve())
    expect(stoppedWatchers).toEqual(['rollout'])

    const refusing = storeWrapper(
      {},
      {
        [CommandName.WatchersStop]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidTransition, "The watcher's session isn't running")),
      },
    )
    renderUnwrapped(<WatchersTab taskId="t1" watchers={[sample('ci')]} />, { wrapper: refusing.wrapper })
    const [, refused] = screen.getAllByRole('button', { name: 'Stop CI checks on PR #42' })
    if (refused === undefined) throw new Error('No second Stop')
    fireEvent.click(refused)
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())
    expect(screen.getByText("The watcher's session isn't running")).toBeInTheDocument()
  })

  it('ticks while one is live, and stops ticking once none is', () => {
    vi.useFakeTimers({ now: at(13, 21, 0) })
    const rollout = sample('rollout')
    const { rerender } = render(<WatchersTab taskId="t1" watchers={[rollout]} />)
    expect(row('Check the docs rollout')).toHaveTextContent('Due in 5m')

    act(() => {
      vi.advanceTimersByTime(4 * 60 * WATCHERS_REFRESH_MS + 30 * WATCHERS_REFRESH_MS)
    })
    expect(row('Check the docs rollout')).toHaveTextContent('Due in 30s')

    rerender(
      <WatchersTab
        taskId="t1"
        watchers={[{ ...rollout, state: WatcherState.Finished, wakes: 1, outcome: 'It fired.', endedAt: at(13, 26) }]}
      />,
    )
    expect(row('Check the docs rollout')).toHaveTextContent('FinishedWakeup')
    expect(vi.getTimerCount()).toBe(0)
  })
})
