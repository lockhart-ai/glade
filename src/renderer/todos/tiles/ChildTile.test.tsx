import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType } from '../../../shared/bridge'
import { ToolCallState, WatcherKind, WatcherState } from '../../../shared/domain'
import { ChildKind, commitChildKey } from '../../../shared/todoHub'
import type { StoreWrapper } from '../../store/test-wrapper'
import { NOW_REFRESH_MS } from '../../task-list/useNow'
import { HUB_NOW, hubAgent, hubCommit, hubStore, hubWatcher, minutesAgo, type HubTask } from '../test-hub'
import { ChildTile } from './ChildTile'
import styles from './Tile.module.css'

async function renderTile(task: HubTask, kind: ChildKind, childKey: string): Promise<StoreWrapper> {
  const wrapper = await hubStore(task)
  render(<ChildTile taskId="t1" kind={kind} childKey={childKey} />, { wrapper: wrapper.wrapper })
  return wrapper
}

function tile(): HTMLElement {
  return screen.getByRole('group')
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

// A file's and a link's tile are in `ArtifactTiles.test.tsx` (#498).

describe('a subagent’s tile', () => {
  it('is live while it runs: on the live tint, Running in blue, with what it’s doing now under its name', async () => {
    const agent = hubAgent('agent-a', 'fix-501-ci', 2, { progressSummary: 'Rerunning tests/test_throttle.py' })
    await renderTile({ toolEvents: [agent] }, ChildKind.Subagent, 'agent-a')

    expect(screen.getByRole('group', { name: 'Subagent: fix-501-ci' })).toHaveTextContent(
      /^fix-501-ciRunning · 2mRerunning tests\/test_throttle.py$/,
    )
    expect(tile()).toHaveAttribute('data-live')
    expect(screen.getByText('Running').parentElement).toHaveClass(styles.liveText ?? '')
  })

  it('has no line under its name before its first summary', async () => {
    await renderTile({ toolEvents: [hubAgent('agent-a', 'fix-501-ci', 0)] }, ChildKind.Subagent, 'agent-a')
    expect(tile()).toHaveTextContent(/^fix-501-ciRunning · now$/)
  })

  it('goes grey once it’s done, dated by the last thing it did', async () => {
    const done = hubAgent('agent-a', 'fix-501', 30, {
      state: ToolCallState.Done,
      output: 'Opened PR #511.',
      finishedAt: minutesAgo(7),
      progressSummary: 'Opening the PR',
    })
    await renderTile({ toolEvents: [done] }, ChildKind.Subagent, 'agent-a')
    expect(tile()).toHaveTextContent(/^fix-501Done · 7m$/)
    expect(tile()).not.toHaveAttribute('data-live')
    expect(screen.getByText('Done')).not.toHaveClass(styles.failed ?? '')
  })

  it('says a failed one failed in pink, and a paused or interrupted one in grey', async () => {
    const states: [ToolCallState, string, boolean][] = [
      [ToolCallState.Error, 'Failed', true],
      [ToolCallState.Paused, 'Paused', false],
      [ToolCallState.Interrupted, 'Interrupted', false],
    ]
    const events = states.map(([state], index) =>
      hubAgent(`agent-${String(index)}`, `sub-${String(index)}`, 3, { state }),
    )
    const wrapper = await hubStore({ toolEvents: events })
    for (const [index, [, label, failed]] of states.entries()) {
      const { unmount } = render(
        <ChildTile taskId="t1" kind={ChildKind.Subagent} childKey={`agent-${String(index)}`} />,
        {
          wrapper: wrapper.wrapper,
        },
      )
      expect(tile()).toHaveTextContent(new RegExp(`^sub-${String(index)}${label} · 3m$`))
      expect(screen.getByText(label).classList.contains(styles.failed ?? '')).toBe(failed)
      expect(tile()).not.toHaveAttribute('data-live')
      unmount()
    }
  })

  it('follows its subagent live: its summary as it changes, then done', async () => {
    const agent = hubAgent('agent-a', 'fix-501-ci', 2, { progressSummary: 'Reading the test' })
    const { fake } = await renderTile({ toolEvents: [agent] }, ChildKind.Subagent, 'agent-a')

    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...agent, progressSummary: 'Rerunning the burst test' },
      })
    })
    expect(tile()).toHaveTextContent('Rerunning the burst test')

    const finished = {
      ...agent,
      state: ToolCallState.Done,
      output: 'Fixed.',
      finishedAt: HUB_NOW,
      progressSummary: null,
    }
    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: finished })
    })
    expect(tile()).toHaveTextContent(/^fix-501-ciDone · now$/)
    expect(tile()).not.toHaveAttribute('data-live')
  })

  it('shows nothing for a subagent the log hasn’t got', async () => {
    await renderTile({ toolEvents: [] }, ChildKind.Subagent, 'agent-a')
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('a watcher’s tile', () => {
  it('is live while its process runs, with the last thing it reported', async () => {
    const watcher = hubWatcher('watch-a', 3, {
      label: 'CI checks on PR #513',
      lastOutput: 'lint pass 38s · unit-tests running',
    })
    await renderTile({ watchers: [watcher] }, ChildKind.Watcher, 'watch-a')

    expect(screen.getByRole('group', { name: 'Watcher: CI checks on PR #513' })).toHaveTextContent(
      /^CI checks on PR #513Running · 3mlastlint pass 38s · unit-tests running$/,
    )
    expect(tile()).toHaveAttribute('data-live')
  })

  it('is dated by when it last woke the agent, else when it ended, else when it started', async () => {
    const woke = hubWatcher('woke', 30, {
      lastWokeAt: minutesAgo(4),
      endedAt: minutesAgo(1),
      state: WatcherState.Finished,
    })
    const ended = hubWatcher('ended', 30, {
      endedAt: minutesAgo(9),
      state: WatcherState.Stopped,
      outcome: 'You stopped it.',
    })
    const wrapper = await renderTile({ watchers: [woke, ended] }, ChildKind.Watcher, 'woke')
    expect(tile()).toHaveTextContent('Finished · 4m')
    render(<ChildTile taskId="t1" kind={ChildKind.Watcher} childKey="ended" />, { wrapper: wrapper.wrapper })
    expect(screen.getAllByRole('group')[1]).toHaveTextContent(/Stopped · 9mendYou stopped it\.$/)
    expect(screen.getByText('You stopped it.')).not.toHaveClass(styles.failed ?? '')
  })

  it('says a failed one failed, and how, in pink, and stays grey around it', async () => {
    const failed = hubWatcher('watch-a', 20, {
      kind: WatcherKind.Command,
      label: 'Build the docs site',
      state: WatcherState.Failed,
      endedAt: minutesAgo(12),
      outcome: 'failed with exit code 1',
    })
    await renderTile({ watchers: [failed] }, ChildKind.Watcher, 'watch-a')

    expect(tile()).toHaveTextContent(/^Build the docs siteFailed · 12mendfailed with exit code 1$/)
    expect(screen.getByText('Failed')).toHaveClass(styles.failed ?? '')
    expect(screen.getByText('failed with exit code 1')).toHaveClass(styles.failed ?? '')
    expect(tile()).not.toHaveAttribute('data-live')
  })

  it('is grey while it’s only scheduled or suspended, since nothing runs yet, and counts down to its time by itself', async () => {
    const wakeup = hubWatcher('wake', 10, {
      kind: WatcherKind.Wakeup,
      label: 'Check the nightly flake report',
      state: WatcherState.Scheduled,
      nextDueAt: HUB_NOW + 20 * 60_000,
    })
    const cron = hubWatcher('cron', 10, { kind: WatcherKind.Cron, label: 'Queue depth', state: WatcherState.Suspended })
    const wrapper = await renderTile({ watchers: [wakeup, cron] }, ChildKind.Watcher, 'wake')

    expect(tile()).toHaveTextContent(/^Check the nightly flake reportDue in 20m · 10m$/)
    expect(tile()).not.toHaveAttribute('data-live')
    expect(screen.getByText('Due in 20m').parentElement).not.toHaveClass(styles.liveText ?? '')
    act(() => {
      vi.setSystemTime(HUB_NOW + 5 * 60_000)
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    expect(tile()).toHaveTextContent('Due in 15m')

    render(<ChildTile taskId="t1" kind={ChildKind.Watcher} childKey="cron" />, { wrapper: wrapper.wrapper })
    expect(screen.getByRole('group', { name: 'Watcher: Queue depth' })).toHaveTextContent(/^Queue depthSuspended/)
  })

  it('has no line under its label before it has reported anything', async () => {
    await renderTile(
      { watchers: [hubWatcher('watch-a', 0, { label: 'Tail the deploy log' })] },
      ChildKind.Watcher,
      'watch-a',
    )
    expect(tile()).toHaveTextContent(/^Tail the deploy logRunning · now$/)
  })

  it('shows nothing for a watcher the task hasn’t got', async () => {
    await renderTile({ watchers: [] }, ChildKind.Watcher, 'watch-a')
    expect(screen.queryByRole('group')).toBeNull()
  })
})

describe('a commit’s tile', () => {
  it('shows its short hash, its subject, the lines it added and removed, and its age', async () => {
    const commit = hubCommit('0c4d2e1f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d', 'Test the header under burst traffic', 8, {
      additions: 1204,
      deletions: 0,
    })
    await renderTile({ commits: [commit] }, ChildKind.Commit, commitChildKey(commit))

    expect(screen.getByRole('group', { name: 'Change: Test the header under burst traffic' })).toHaveTextContent(
      /^0c4d2e1Test the header under burst traffic\+1,204 −0 · 8m$/,
    )
    expect(screen.getByText('+1,204')).toHaveClass(styles.added ?? '')
    expect(screen.getByText('−0')).toHaveClass(styles.removed ?? '')
    expect(tile()).not.toHaveAttribute('data-live')
  })

  it('shows nothing for a commit the task hasn’t got', async () => {
    await renderTile({ commits: [] }, ChildKind.Commit, 'abc /code/api')
    expect(screen.queryByRole('group')).toBeNull()
  })
})
