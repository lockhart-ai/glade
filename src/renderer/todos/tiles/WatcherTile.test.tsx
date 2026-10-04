// A watcher's tile in the todo hub (#499; docs/design/html/48-todo-hub-tiles.html and the states under
// 46-todo-hub.html): what its row in the Watchers tab shows, in every state, with Stop while it's live, and the tag of
// the subagent that left it running.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../../shared/bridge'
import { WatcherKind, WatcherState, type Watcher } from '../../../shared/domain'
import { ChildKind } from '../../../shared/todoHub'
import { refuse, type FakeHandlers, type FakeMain } from '../../store/test-bridge'
import { storeWrapper, type StoreWrapper } from '../../store/test-wrapper'
import { WATCHERS_REFRESH_MS } from '../../watchers/WatchersTab'
import { HUB_NOW, hubAgent, hubMain, hubWatcher, minutesAgo, type HubTask } from '../test-hub'
import { ChildTile } from './ChildTile'
import styles from './Tile.module.css'
import partStyles from './TileParts.module.css'

interface TileStore extends StoreWrapper {
  readonly main: Partial<FakeMain>
}

async function hubStore(task: HubTask, overrides: Partial<FakeHandlers> = {}): Promise<TileStore> {
  const main = { ...hubMain(task), stoppedWatchers: [], opened: [] }
  const wrapper = storeWrapper(main, overrides)
  await act(() => wrapper.store.getState().hydrate())
  return { ...wrapper, main }
}

/** A watcher's tile over a fake main with the hub on, hydrated. */
async function renderTile(task: HubTask, childKey: string, overrides: Partial<FakeHandlers> = {}): Promise<TileStore> {
  const store = await hubStore(task, overrides)
  render(<ChildTile taskId="t1" kind={ChildKind.Watcher} childKey={childKey} />, { wrapper: store.wrapper })
  return store
}

function tile(): HTMLElement {
  return screen.getByRole('group', { name: /^Watcher: / })
}

function stop(): HTMLElement | null {
  return within(tile()).queryByRole('button', { name: /^Stop / })
}

/** The live watcher in 48-todo-hub-tiles.html: a `Monitor` on a PR's checks. */
const CI = hubWatcher('ci', 5, {
  label: 'CI checks on PR #48',
  detail: 'gh pr checks 48 --watch --interval 30',
  lastOutput: 'lint pass 38s · unit-tests running',
  wakes: 3,
  lastWokeAt: minutesAgo(2),
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a watcher’s tile', () => {
  it('shows what its row in the Watchers tab does: its kind and what it runs, its last report, its wakes and times', async () => {
    await renderTile({ watchers: [CI] }, 'ci')

    expect(tile()).toHaveTextContent(
      /^CI checks on PR #48Running · 2mStopMonitorgh pr checks 48 --watch --interval 30lastlint pass 38s · unit-tests running3 wakes · last 14:28 · 5m 00s · since 14:25$/,
    )
    // Each line is cut short, and says the whole of itself on hover.
    expect(screen.getByTitle('gh pr checks 48 --watch --interval 30')).toBeInTheDocument()
    expect(screen.getByTitle('lint pass 38s · unit-tests running')).toBeInTheDocument()
    // Blue, on the live tint, with Stop.
    expect(tile()).toHaveAttribute('data-live')
    expect(screen.getByText('Running').parentElement).toHaveClass(styles.liveText ?? '')
    expect(stop()).toHaveAccessibleName('Stop CI checks on PR #48')
    expect(stop()).toHaveClass(partStyles.stop ?? '')
  })

  it('counts how long it has run by itself, a second at a time, while it runs', async () => {
    await renderTile({ watchers: [CI] }, 'ci')

    act(() => {
      vi.advanceTimersByTime(WATCHERS_REFRESH_MS)
    })
    expect(tile()).toHaveTextContent('3 wakes · last 14:28 · 5m 01s · since 14:25')
    act(() => {
      vi.advanceTimersByTime(6 * WATCHERS_REFRESH_MS)
    })
    expect(tile()).toHaveTextContent('3 wakes · last 14:28 · 5m 07s · since 14:25')
  })

  it('makes a link of an address in what it last reported, which opens in the browser', async () => {
    const { main } = await renderTile(
      { watchers: [{ ...CI, lastOutput: 'failed: https://ci.example.com/runs/48' }] },
      'ci',
    )
    fireEvent.click(within(tile()).getByRole('link', { name: 'https://ci.example.com/runs/48' }))
    await act(() => Promise.resolve())
    expect(main.opened).toEqual(['https://ci.example.com/runs/48'])
  })

  describe('in each state', () => {
    it('scheduled for a time: grey, saying when it’s due in place of its age, with Stop', async () => {
      const wakeup = hubWatcher('wake', 32, {
        kind: WatcherKind.Wakeup,
        label: 'Check the nightly flake report',
        detail: 'Check whether last night’s run still shows the login flake.',
        recurring: false,
        state: WatcherState.Scheduled,
        nextDueAt: HUB_NOW + 20 * 60_000,
      })
      await renderTile({ watchers: [wakeup] }, 'wake')

      expect(tile()).toHaveTextContent(
        /^Check the nightly flake reportDue in 20mStopWakeupCheck whether last night’s run still shows the login flake\.0 wakes · at 14:50 · set 13:58$/,
      )
      expect(tile()).not.toHaveAttribute('data-live')
      expect(screen.getByText('Due in 20m').parentElement).not.toHaveClass(styles.liveText ?? '')
      expect(tile().querySelector('time')).toBeNull()
      expect(stop()).not.toBeNull()
    })

    it('a cron job: its schedule in words as what it runs, and its age when no time is known for it', async () => {
      const cron = hubWatcher('cron', 10, {
        kind: WatcherKind.Cron,
        label: 'Check the staging queue depth.',
        detail: 'Check the staging queue depth.',
        schedule: 'Every 10 minutes',
        state: WatcherState.Scheduled,
        nextDueAt: null,
      })
      await renderTile({ watchers: [cron] }, 'cron')

      expect(tile()).toHaveTextContent(/^Check the staging queue depth\.Scheduled · 10mStopCronEvery 10 minutes0 wakes/)
      expect(tile()).not.toHaveAttribute('data-live')
    })

    it('suspended: grey, still live enough to stop', async () => {
      const suspended = hubWatcher('cron', 10, { kind: WatcherKind.Cron, state: WatcherState.Suspended })
      await renderTile({ watchers: [suspended] }, 'cron')

      expect(tile()).toHaveTextContent(/Suspended · 10mStopCron.*0 wakes · back when the session resumes · set 14:20$/)
      expect(tile()).not.toHaveAttribute('data-live')
      expect(stop()).not.toBeNull()
    })

    it('finished: grey, its last report still under it, and nothing to stop', async () => {
      const finished = hubWatcher('ci', 6, {
        label: 'CI checks on PR #511',
        state: WatcherState.Finished,
        lastOutput: 'unit-tests fail test_retry_after_burst',
        outcome: 'exit code 0',
        wakes: 1,
        lastWokeAt: minutesAgo(1),
        endedAt: minutesAgo(1),
      })
      await renderTile({ watchers: [finished] }, 'ci')

      expect(tile()).toHaveTextContent(
        /^CI checks on PR #511Finished · 1mMonitorgh pr checks 42 --watchlastunit-tests fail test_retry_after_burst1 wake · last 14:29 · 14:24–14:29$/,
      )
      expect(tile()).not.toHaveAttribute('data-live')
      expect(screen.getByText('Finished')).not.toHaveClass(styles.failed ?? '')
      expect(stop()).toBeNull()
    })

    it('finished without ever reporting: how it ended', async () => {
      const finished = hubWatcher('build', 6, {
        kind: WatcherKind.Command,
        state: WatcherState.Finished,
        outcome: 'exit code 0',
        endedAt: minutesAgo(1),
      })
      await renderTile({ watchers: [finished] }, 'build')
      expect(tile()).toHaveTextContent(/Finished · 1mCommand.*endexit code 00 wakes/)
    })

    it('failed: it says so in pink, and how, and nothing else is', async () => {
      const failed = hubWatcher('build', 20, {
        kind: WatcherKind.Command,
        label: 'Build the docs site',
        detail: 'npm run build:docs',
        state: WatcherState.Failed,
        endedAt: minutesAgo(12),
        outcome: 'failed with exit code 1',
      })
      await renderTile({ watchers: [failed] }, 'build')

      expect(tile()).toHaveTextContent(
        /^Build the docs siteFailed · 12mCommandnpm run build:docsendfailed with exit code 10 wakes · 14:10–14:18$/,
      )
      expect(screen.getByText('Failed')).toHaveClass(styles.failed ?? '')
      expect(screen.getByText('failed with exit code 1').parentElement).toHaveClass(styles.failed ?? '')
      expect(screen.getByText('npm run build:docs').parentElement).not.toHaveClass(styles.failed ?? '')
      expect(tile()).not.toHaveAttribute('data-live')
      expect(stop()).toBeNull()
    })

    it('stopped: grey, as a finished one is', async () => {
      const stopped = hubWatcher('queue', 30, {
        kind: WatcherKind.Cron,
        label: 'Staging queue depth',
        schedule: '*/10 * * * *',
        state: WatcherState.Stopped,
        endedAt: minutesAgo(12),
        outcome: 'You stopped it.',
      })
      await renderTile({ watchers: [stopped] }, 'queue')

      expect(tile()).toHaveTextContent(/^Staging queue depthStopped · 12mCron\*\/10 \* \* \* \*endYou stopped it\./)
      expect(screen.getByText('You stopped it.').parentElement).not.toHaveClass(styles.failed ?? '')
      expect(stop()).toBeNull()
    })
  })

  describe('Stop', () => {
    it('stops it: it goes grey, says who stopped it, and has no Stop left', async () => {
      const { main } = await renderTile({ watchers: [CI] }, 'ci')

      fireEvent.click(stop() ?? tile())
      await act(() => Promise.resolve())

      expect(main.stoppedWatchers).toEqual([CI.id])
      expect(tile()).toHaveTextContent(/^CI checks on PR #48Stopped · 2mMonitor.*endYou stopped it\.3 wakes/)
      expect(tile()).not.toHaveAttribute('data-live')
      expect(stop()).toBeNull()
    })

    it('stops one that’s only scheduled', async () => {
      const wakeup = hubWatcher('wake', 2, {
        kind: WatcherKind.Wakeup,
        state: WatcherState.Scheduled,
        nextDueAt: HUB_NOW + 60_000,
      })
      const { main } = await renderTile({ watchers: [wakeup] }, 'wake')

      fireEvent.click(stop() ?? tile())
      await act(() => Promise.resolve())

      expect(main.stoppedWatchers).toEqual([wakeup.id])
      // Its age is back, now that it says no time.
      expect(tile()).toHaveTextContent(/Stopped · 2mWakeup/)
    })

    it('shows a toast when it can’t be stopped, and leaves it as it is', async () => {
      await renderTile({ watchers: [CI] }, 'ci', {
        [CommandName.WatchersStop]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'It had already ended')),
      })

      fireEvent.click(stop() ?? tile())

      expect(await screen.findByText('It had already ended')).toBeInTheDocument()
      expect(tile()).toHaveAttribute('data-live')
      expect(stop()).not.toBeNull()
    })
  })

  it('turns pink when it fails while it’s watched: its command failed, and Stop goes', async () => {
    const { fake } = await renderTile({ watchers: [CI] }, 'ci')
    const failed: Watcher = {
      ...CI,
      state: WatcherState.Failed,
      outcome: 'failed with exit code 2',
      endedAt: HUB_NOW,
    }

    act(() => {
      fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: [failed] })
    })

    expect(tile()).toHaveTextContent(
      /Failed · 2mMonitor.*endfailed with exit code 23 wakes · last 14:28 · 14:25–14:30$/,
    )
    expect(screen.getByText('Failed')).toHaveClass(styles.failed ?? '')
    expect(tile()).not.toHaveAttribute('data-live')
    expect(stop()).toBeNull()
    // Nothing ticks for one that has ended.
    expect(vi.getTimerCount()).toBe(1)
  })

  describe('one a subagent left running', () => {
    const SOAK = hubAgent('soak', 'soak-login', 4)
    const TESTS = hubWatcher('tests', 3, {
      kind: WatcherKind.Command,
      label: 'Login test, 200 runs',
      detail: 'pytest tests/test_login.py --count 200 -x',
      parentToolUseId: 'soak',
    })

    it('is a tile of its own, tagged with the subagent’s name after its last line', async () => {
      await renderTile({ toolEvents: [SOAK], watchers: [TESTS] }, 'tests')

      expect(tile()).toHaveTextContent(
        /^Login test, 200 runsRunning · 3mStopCommandpytest tests\/test_login\.py --count 200 -x0 wakes · 3m 00s · since 14:27soak-login$/,
      )
      const tag = screen.getByTitle('Started by the subagent “soak-login”')
      expect(tag).toHaveTextContent(/^soak-login$/)
      expect(tag).toHaveClass(partStyles.by ?? '')
      // Stop stops the watcher, not its subagent.
      expect(stop()).toHaveAccessibleName('Stop Login test, 200 runs')
    })

    it('says a subagent started it even when the tool log hasn’t got that subagent', async () => {
      await renderTile({ watchers: [TESTS] }, 'tests')
      expect(screen.getByTitle('Started by the subagent “Subagent”')).toHaveTextContent(/^Subagent$/)
    })

    it('has no tag when the task’s own agent started it', async () => {
      await renderTile({ toolEvents: [SOAK], watchers: [CI] }, 'ci')
      expect(screen.queryByTitle(/^Started by/)).toBeNull()
    })
  })
})
