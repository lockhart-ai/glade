// Watchers in the Agents tab (P16, #537): pinned under the tool calls of the agent that started them while they're
// live, a row among those calls once they've ended, and the eye on that agent's tab. Then what the Agents tab took over
// from the Subagents tab: a subagent's tab menu, and what a running subagent is doing now. On the fake main with the
// todo hub's hidden switch on.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, CommandName, EventType, bridgeError } from '../../shared/bridge'
import {
  ToolCallState,
  ToolEventKind,
  WatcherKind,
  WatcherState,
  type NarrationEvent,
  type ToolCallEvent,
  type Watcher,
} from '../../shared/domain'
import { refuse, sampleWatcher } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { NOW_REFRESH_MS } from '../task-list/useNow'
import { HUB_NOW, hubAgent, hubMain, minutesAgo, type HubStore, type HubTask } from '../todos/test-hub'
import { AgentsTab } from './AgentsTab'
import { DUE_SOON_MS } from './useDueNow'
import { SECONDS_REFRESH_MS } from './useElapsedNow'

const MINUTE = 60_000
const ROOT = '/Users/sample/code/api'

function call(id: string, minutes: number, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: `event-${id}`,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(minutes),
    kind: ToolEventKind.ToolCall,
    name: 'Bash',
    input: { command: `pytest tests/${id}.py` },
    output: '14 passed',
    state: ToolCallState.Done,
    finishedAt: minutesAgo(minutes),
    toolUseId: id,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

function note(id: string, text: string, minutes: number, parentToolUseId: string | null = null): NarrationEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: minutesAgo(minutes),
    kind: ToolEventKind.Narration,
    text,
    parentToolUseId,
  }
}

/** A watcher of task `t1`, started `minutes` ago by the call `toolu-<id>`. */
function watcher(id: string, minutes: number, overrides: Partial<Watcher> = {}): Watcher {
  return sampleWatcher(id, 't1', { toolUseId: `toolu-${id}`, startedAt: minutesAgo(minutes), ...overrides })
}

/** The screens' watch: a `Monitor` on PR #511's checks, started five minutes ago. */
const CI = watcher('ci', 5, {
  label: 'CI checks on PR #511',
  detail: 'gh pr checks 511 --watch --interval 30',
  lastOutput: 'lint pass 41s · unit-tests running',
})
/** The screens' wakeup: set two minutes ago, due in twelve. */
const PREVIEW = watcher('preview', 2, {
  kind: WatcherKind.Wakeup,
  state: WatcherState.Scheduled,
  recurring: false,
  label: 'Check the docs preview for PR #512',
  detail: 'Check whether the docs preview for PR #512 built, and report.',
  nextDueAt: HUB_NOW + 12 * MINUTE,
})
const LIMITS = hubAgent('limits-502', 'limits-502', 34)
const FIX = hubAgent('fix-501', 'fix-501', 40, {
  state: ToolCallState.Done,
  output: 'Opened PR #511.',
  finishedAt: minutesAgo(12),
})

/** Main watching the checks, with a wakeup set: screen 52. */
const WATCHING: HubTask = {
  toolEvents: [
    note('n1', 'Three issues, so three subagents, one for each todo.', 41),
    FIX,
    LIMITS,
    note('n2', 'Watching the checks on PR #511.', 5),
    call('toolu-ci', 5, { name: 'Monitor', input: { description: CI.label, command: CI.detail } }),
    note('n3', 'Its preview takes a while to build, so I’ll look again later.', 2),
    call('toolu-preview', 2, { name: 'ScheduleWakeup', input: { delaySeconds: 840, reason: PREVIEW.label } }),
  ],
  watchers: [CI, PREVIEW],
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
  vi.setSystemTime(HUB_NOW)
  Element.prototype.scrollIntoView = vi.fn()
})

afterEach(() => {
  vi.useRealTimers()
})

async function renderAgents(
  task: HubTask = WATCHING,
  more: Parameters<typeof storeWrapper>[0] = {},
  overrides: Parameters<typeof storeWrapper>[1] = {},
): Promise<HubStore> {
  const main = { ...hubMain(task), ...more }
  const hub: HubStore = { ...storeWrapper(main, overrides), main }
  await act(() => hub.store.getState().hydrate())
  render(<AgentsTab taskId="t1" rootPath={ROOT} />, { wrapper: hub.wrapper })
  await act(() => Promise.resolve())
  return hub
}

const strip = (): HTMLElement => screen.getByRole('tablist', { name: 'Agents' })
const tab = (name: string): HTMLElement => within(strip()).getByTitle(name, { exact: true })
/** The eye on an agent's tab, if it has one. */
const eye = (name: string): HTMLElement | null => within(tab(name)).queryByRole('img', { name: /watching$/ })
const list = (): HTMLElement => screen.getByRole('log', { name: 'Tool log' })
const pinned = (): HTMLElement | null => screen.queryByRole('group', { name: 'Watching' })
/** The pinned cards, top to bottom, each by its watcher's label. */
const cards = (): string[] =>
  [...(pinned()?.querySelectorAll('[data-kind]') ?? [])].map((card) => card.getAttribute('aria-label') ?? '')
const card = (label: string): HTMLElement => within(pinned() ?? document.body).getByRole('group', { name: label })
/** What's pinned, which must be there. */
const watching = (): HTMLElement => screen.getByRole('group', { name: 'Watching' })
/** The one ended watcher's row in the list. */
function endedRow(): HTMLElement {
  const [row, ...more] = endedRows()
  if (row === undefined || more.length > 0) throw new Error('Not one ended watcher')
  return row
}
/** The ended watchers' rows in the list, top to bottom. */
const endedRows = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('[data-watcher]')]
/** Every row of the list as text, top to bottom: calls, notes and ended watchers. */
const rows = (): string[] =>
  [...(list().firstElementChild?.children ?? [])].map((element) => element.textContent.replace(/\s+/g, ' ').trim())

/** Main sends the task's watchers anew, as it does with every change to one. */
function send(hub: HubStore, watchers: readonly Watcher[]): void {
  act(() => {
    hub.fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: watchers.map((each) => ({ ...each })) })
  })
}

const finishedAt = (minutes: number, overrides: Partial<Watcher> = {}): Partial<Watcher> => ({
  state: WatcherState.Finished,
  endedAt: minutesAgo(minutes),
  outcome: 'Monitor "CI checks on PR #511" stream ended',
  ...overrides,
})

describe('a live watcher', () => {
  it('is pinned under its agent’s tool calls, outside their scroll, under a Watching label', async () => {
    await renderAgents()

    expect(cards()).toEqual([CI.label, PREVIEW.label])
    expect(pinned()).toHaveTextContent(/^Watching/)
    // Under the list, and no part of what scrolls.
    expect(list().contains(pinned())).toBe(false)
    expect(list().compareDocumentPosition(watching()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(screen.getByRole('tabpanel').contains(pinned())).toBe(true)
  })

  it('says what it is: its label, state, what it runs, its last output, and how often it woke the agent', async () => {
    await renderAgents()

    expect(card(CI.label)).toHaveTextContent(
      'CI checks on PR #511Running · 5mStopMonitorgh pr checks 511 --watch --interval 30lastlint pass 41s · unit-tests running0 wakes · since 14:25',
    )
    expect(card(CI.label)).toHaveAttribute('data-state', WatcherState.Running)
    expect(card(CI.label).className).toContain('live')
  })

  it('pins a wakeup that’s only scheduled the same way, grey, with when it’s due', async () => {
    await renderAgents()

    expect(card(PREVIEW.label)).toHaveTextContent(
      'Check the docs preview for PR #512Due in 12mStopWakeupCheck whether the docs preview for PR #512 built, and report.at 14:42 · 0 wakes · set 14:28',
    )
    expect(card(PREVIEW.label)).toHaveAttribute('data-state', WatcherState.Scheduled)
    expect(card(PREVIEW.label).className).not.toContain('live')
  })

  it('isn’t in the list: the call that started it is no row', async () => {
    await renderAgents()

    expect(rows()).toEqual([
      'Three issues, so three subagents, one for each todo. 13:49',
      'Agentfix-50113:50Done · 28m · Opened PR #511.',
      'Agentlimits-50213:56Running · 34m',
      'Watching the checks on PR #511. 14:25',
      'Its preview takes a while to build, so I’ll look again later. 14:28',
    ])
    expect(endedRows()).toEqual([])
  })

  it('shows nothing pinned for an agent that watches nothing', async () => {
    await renderAgents({ toolEvents: [call('only', 4)] })

    expect(pinned()).toBeNull()
    expect(eye('Main')).toBeNull()
  })

  it('stops on its Stop, and then is a row in the list where it ended', async () => {
    const stoppedWatchers: string[] = []
    await renderAgents(WATCHING, { stoppedWatchers })

    fireEvent.click(within(card(PREVIEW.label)).getByRole('button', { name: `Stop ${PREVIEW.label}` }))
    await act(() => Promise.resolve())

    expect(stoppedWatchers).toEqual(['preview'])
    expect(cards()).toEqual([CI.label])
    expect(endedRows().map((row) => row.textContent)).toEqual([
      'WakeupCheck the docs preview for PR #51214:28Stopped · didn’t wake the agentendYou stopped it.',
    ])
  })

  it('says so when main can’t stop it, and leaves it pinned', async () => {
    await renderAgents(
      WATCHING,
      {},
      {
        [CommandName.WatchersStop]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidTransition, "The watcher's session isn't running")),
      },
    )

    fireEvent.click(within(card(CI.label)).getByRole('button', { name: `Stop ${CI.label}` }))
    await act(() => Promise.resolve())
    await act(() => Promise.resolve())

    expect(screen.getByText("The watcher's session isn't running")).toBeInTheDocument()
    expect(cards()).toEqual([CI.label, PREVIEW.label])
  })

  it('updates as it reports a line and wakes the agent', async () => {
    const hub = await renderAgents()

    send(hub, [{ ...CI, lastOutput: 'unit-tests fail test_retry_after_burst', wakes: 1, lastWokeAt: HUB_NOW }, PREVIEW])

    expect(card(CI.label)).toHaveTextContent(
      'lastunit-tests fail test_retry_after_burst1 wake · last 14:30 · since 14:25',
    )
    expect(card(PREVIEW.label)).toHaveTextContent('0 wakes')
  })

  it('has no last line until it has reported one', async () => {
    await renderAgents({ toolEvents: [], watchers: [{ ...CI, lastOutput: null }] })

    expect(card(CI.label)).toHaveTextContent(/--interval 300 wakes · since 14:25$/)
  })

  it('counts its time by itself: seconds through its first minute, then minutes', async () => {
    await renderAgents({ toolEvents: [], watchers: [watcher('fresh', 0, { label: 'Fresh watch' })] })
    expect(card('Fresh watch')).toHaveTextContent('Running · 0s')

    act(() => {
      vi.advanceTimersByTime(42 * SECONDS_REFRESH_MS)
    })
    expect(card('Fresh watch')).toHaveTextContent('Running · 42s')

    act(() => {
      vi.advanceTimersByTime(18 * SECONDS_REFRESH_MS + 4 * NOW_REFRESH_MS)
    })
    expect(card('Fresh watch')).toHaveTextContent('Running · 3m')
  })

  it('counts down to when a scheduled one is due: in minutes, then in seconds around its time', async () => {
    await renderAgents()

    act(() => {
      vi.advanceTimersByTime(8 * MINUTE)
    })
    expect(card(PREVIEW.label)).toHaveTextContent('Due in 4m')

    act(() => {
      vi.advanceTimersByTime(12 * MINUTE - 8 * MINUTE - DUE_SOON_MS)
    })
    act(() => {
      vi.advanceTimersByTime(DUE_SOON_MS - 30_000)
    })
    expect(card(PREVIEW.label)).toHaveTextContent('Due in 30s')

    act(() => {
      vi.advanceTimersByTime(30_000)
    })
    expect(card(PREVIEW.label)).toHaveTextContent('Due now')
  })
})

describe('the eye on an agent’s tab', () => {
  it('counts what the agent has pinned, scheduled ones included, and is blue while a process runs', async () => {
    await renderAgents()

    expect(eye('Main')).toHaveTextContent('2')
    expect(eye('Main')).toHaveAttribute('title', '2 watching')
    expect(eye('Main')).toHaveAttribute('data-live')
    expect(eye('limits-502')).toBeNull()
    expect(eye('fix-501')).toBeNull()
  })

  it('is grey when all the agent has is scheduled', async () => {
    await renderAgents({ ...WATCHING, watchers: [PREVIEW] })

    expect(eye('Main')).toHaveTextContent('1')
    expect(eye('Main')).not.toHaveAttribute('data-live')
    expect(eye('Main')?.className).toContain('idle')
  })

  it('goes as the last of them ends', async () => {
    const hub = await renderAgents()

    send(hub, [{ ...CI, ...finishedAt(0) }, PREVIEW])
    expect(eye('Main')).toHaveTextContent('1')
    expect(eye('Main')).not.toHaveAttribute('data-live')

    send(hub, [
      { ...CI, ...finishedAt(0) },
      { ...PREVIEW, ...finishedAt(0, { outcome: 'It fired.', wakes: 1 }) },
    ])
    expect(eye('Main')).toBeNull()
    expect(pinned()).toBeNull()
  })
})

describe('a watcher that has ended', () => {
  it('leaves the bottom and is a row in the list at the time it ended, with what the agent did next after it', async () => {
    const hub = await renderAgents()

    send(hub, [
      {
        ...CI,
        ...finishedAt(0),
        wakes: 1,
        lastWokeAt: HUB_NOW,
        lastOutput: 'unit-tests fail test_retry_after_burst',
        startedAt: minutesAgo(8),
      },
      PREVIEW,
    ])
    act(() => {
      hub.fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: { ...note('n4', 'CI failed on #511: the burst test.', 0), createdAt: HUB_NOW + 1000 },
      })
    })

    expect(cards()).toEqual([PREVIEW.label])
    expect(rows().slice(-3)).toEqual([
      'Its preview takes a while to build, so I’ll look again later. 14:28',
      'MonitorCI checks on PR #51114:30Finished · ran 8m · woke the agent oncelastunit-tests fail test_retry_after_burst',
      'CI failed on #511: the burst test. 14:30',
    ])
    const row = endedRow()
    expect(row).toHaveAttribute('data-state', WatcherState.Finished)
    expect(within(row).getByRole('img', { name: 'Watcher' })).toBeInTheDocument()
    // What it ran is in its label's tooltip.
    expect(within(row).getByText(CI.label)).toHaveAttribute('title', CI.detail)
    // Grey, whatever it found.
    expect(row.className).not.toContain('failedWatcher')
  })

  it('is pink when its own command failed, and says how', async () => {
    const docs = watcher('docs', 4, {
      kind: WatcherKind.Command,
      recurring: false,
      label: 'Build the docs site',
      detail: 'npm run build:docs',
      ...finishedAt(2, { state: WatcherState.Failed, outcome: 'npm run build:docs failed with exit code 1', wakes: 1 }),
    })
    await renderAgents({ toolEvents: [call('toolu-docs', 4), call('after', 1)], watchers: [docs] })

    expect(rows()).toEqual([
      'CommandBuild the docs site14:28Failed · ran 2m · woke the agent onceendnpm run build:docs failed with exit code 1',
      'Bashpytest tests/after.py14:2914 passed',
    ])
    expect(endedRows()[0]?.className).toContain('failedWatcher')
    expect(endedRows()[0]).toHaveAttribute('data-state', WatcherState.Failed)
    expect(pinned()).toBeNull()
  })

  it('reads in order with the calls around it, however many have ended', async () => {
    const early = watcher('early', 30, { label: 'Early', ...finishedAt(25) })
    const middle = watcher('middle', 20, { label: 'Middle', ...finishedAt(15, { state: WatcherState.Stopped }) })
    const late = watcher('late', 10, { label: 'Late', ...finishedAt(1) })
    await renderAgents({
      toolEvents: [call('a', 28), call('b', 18), call('c', 12), call('d', 2)],
      // As main lists them: in the order they started.
      watchers: [early, middle, late],
    })

    expect(rows().map((row) => /^(Monitor[A-Z][a-z]+|Bashpytest tests\/\w)/.exec(row)?.[0])).toEqual([
      'Bashpytest tests/a',
      'MonitorEarly',
      'Bashpytest tests/b',
      'MonitorMiddle',
      'Bashpytest tests/c',
      'Bashpytest tests/d',
      'MonitorLate',
    ])
  })

  it('has no last line when it reported nothing and nothing says how it ended', async () => {
    await renderAgents({
      toolEvents: [],
      watchers: [watcher('bare', 4, { label: 'Bare', ...finishedAt(1, { outcome: null }) })],
    })

    expect(endedRows().map((row) => row.textContent)).toEqual([
      'MonitorBare14:29Finished · ran 3m · didn’t wake the agent',
    ])
  })

  it('doesn’t open, and has no menu: it’s a record, not a call', async () => {
    const hub = await renderAgents()
    send(hub, [{ ...CI, ...finishedAt(0) }, PREVIEW])

    const row = endedRow()
    expect(within(row).queryByRole('button')).toBeNull()
    fireEvent.contextMenu(row)
    await act(() => Promise.resolve())
    expect(screen.queryByRole('menu')).toBeNull()
  })
})

describe('under stress', () => {
  it('stacks five watchers pinned at once, in the order they started, each with its own Stop', async () => {
    const five = [1, 2, 3, 4, 5].map((n) =>
      watcher(`w${String(n)}`, 10 - n, { label: `Watch ${String(n)}`, lastOutput: `line ${String(n)}` }),
    )
    const stoppedWatchers: string[] = []
    const hub = await renderAgents({ toolEvents: [call('before', 12)], watchers: five }, { stoppedWatchers })

    expect(cards()).toEqual(['Watch 1', 'Watch 2', 'Watch 3', 'Watch 4', 'Watch 5'])
    expect(eye('Main')).toHaveTextContent('5')
    expect(within(watching()).getAllByRole('button', { name: /^Stop Watch \d$/ })).toHaveLength(5)

    // One reports: the others say what they said.
    send(
      hub,
      five.map((each) => (each.id === 'w3' ? { ...each, lastOutput: 'line 3b', wakes: 2, lastWokeAt: HUB_NOW } : each)),
    )
    expect(card('Watch 3')).toHaveTextContent('lastline 3b2 wakes · last 14:30')
    expect(card('Watch 4')).toHaveTextContent('lastline 40 wakes')

    // The middle one is stopped: the rest keep their order.
    fireEvent.click(screen.getByRole('button', { name: 'Stop Watch 3' }))
    await act(() => Promise.resolve())
    expect(stoppedWatchers).toEqual(['w3'])
    expect(cards()).toEqual(['Watch 1', 'Watch 2', 'Watch 4', 'Watch 5'])
    expect(eye('Main')).toHaveTextContent('4')
    expect(endedRows()).toHaveLength(1)
  })

  it('leaves the list where it is when a watcher ends while you’re scrolled back, and follows it at the bottom', async () => {
    const hub = await renderAgents({
      toolEvents: Array.from({ length: 60 }, (_, index) => call(`c${String(index)}`, 70 - index)),
      watchers: [CI, PREVIEW],
    })
    const scroller = list()
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 3000 },
      clientHeight: { configurable: true, value: 400 },
    })
    // A row arrives, so the list takes its measure as it now is.
    act(() => {
      hub.fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('c60', 9) })
    })
    expect(scroller.scrollTop).toBe(3000)

    // Scrolled back, reading.
    scroller.scrollTop = 900
    fireEvent.scroll(scroller)
    send(hub, [{ ...CI, ...finishedAt(0) }, PREVIEW])
    expect(endedRows()).toHaveLength(1)
    expect(scroller.scrollTop).toBe(900)

    // At the bottom, the list keeps to its end as the row arrives.
    scroller.scrollTop = 2600
    fireEvent.scroll(scroller)
    send(hub, [
      { ...CI, ...finishedAt(0) },
      { ...PREVIEW, ...finishedAt(0, { outcome: 'It fired.' }) },
    ])
    expect(endedRows()).toHaveLength(2)
    expect(scroller.scrollTop).toBe(3000)
  })

  it('keeps a cron job pinned as it fires ten times, counting each', async () => {
    const queue = watcher('queue', 50, {
      kind: WatcherKind.Cron,
      state: WatcherState.Scheduled,
      label: 'Staging queue depth',
      detail: 'Check the staging queue depth.',
      schedule: 'Every 5 minutes',
      nextDueAt: HUB_NOW + 5 * MINUTE,
    })
    const hub = await renderAgents({ toolEvents: [call('toolu-queue', 50, { name: 'CronCreate' })], watchers: [queue] })
    expect(card(queue.label)).toHaveTextContent('CronEvery 5 minutesnext 14:35 · 0 wakes · set 13:40')

    for (let fire = 1; fire <= 10; fire += 1) {
      const at = HUB_NOW + fire * 5 * MINUTE
      vi.setSystemTime(at)
      send(hub, [{ ...queue, wakes: fire, lastWokeAt: at, nextDueAt: at + 5 * MINUTE }])
      expect(cards()).toEqual([queue.label])
      expect(endedRows()).toEqual([])
    }

    expect(card(queue.label)).toHaveTextContent('next 15:25 · 10 wakes · last 15:20 · set 13:40')
    expect(eye('Main')).toHaveTextContent('1')
    expect(eye('Main')).not.toHaveAttribute('data-live')

    // Then you stop it: it joins the list, with all ten.
    send(hub, [
      { ...queue, wakes: 10, ...finishedAt(-50, { state: WatcherState.Stopped, outcome: 'You stopped it.' }) },
    ])
    expect(endedRows().map((row) => row.textContent)).toEqual([
      'CronStaging queue depth15:20Stopped · ran 1h 40m · woke the agent 10 timesendYou stopped it.',
    ])
  })

  it('shows a stopped one that the agent stopped, timed out or lost its session, each saying how', async () => {
    const stopped = (id: string, minutes: number, outcome: string): Watcher =>
      watcher(id, 20, { label: id, ...finishedAt(minutes, { state: WatcherState.Stopped, outcome }) })
    await renderAgents({
      toolEvents: [],
      watchers: [
        stopped('by-agent', 9, 'The agent stopped it.'),
        stopped('timed-out', 6, 'It timed out.'),
        stopped('relaunch', 3, 'Stopped by the relaunch.'),
      ],
    })

    expect(endedRows().map((row) => row.textContent)).toEqual([
      'Monitorby-agent14:21Stopped · ran 11m · didn’t wake the agentendThe agent stopped it.',
      'Monitortimed-out14:24Stopped · ran 14m · didn’t wake the agentendIt timed out.',
      'Monitorrelaunch14:27Stopped · ran 17m · didn’t wake the agentendStopped by the relaunch.',
    ])
    expect(endedRows().every((row) => !row.className.includes('failedWatcher'))).toBe(true)
  })
})

describe('a subagent’s watcher', () => {
  const TESTS = watcher('tests', 6, {
    kind: WatcherKind.Command,
    recurring: false,
    parentToolUseId: 'limits-502',
    label: 'Run the search tests',
    detail: 'pytest tests/test_search.py -f',
  })
  const SUBAGENT: HubTask = {
    toolEvents: [
      FIX,
      LIMITS,
      note('s1', 'Running the search tests in the background.', 6, 'limits-502'),
      call('toolu-tests', 6, { parentToolUseId: 'limits-502' }),
      call('read', 5, { parentToolUseId: 'limits-502', name: 'Read', input: { file_path: `${ROOT}/api/search.py` } }),
    ],
    watchers: [TESTS],
  }

  it('is on that subagent’s tab, with the eye on its tab: not Main’s', async () => {
    await renderAgents(SUBAGENT)

    expect(pinned()).toBeNull()
    expect(eye('Main')).toBeNull()
    expect(eye('limits-502')).toHaveTextContent('1')
    expect(eye('limits-502')).toHaveAttribute('data-live')

    fireEvent.click(tab('limits-502'))
    expect(cards()).toEqual([TESTS.label])
    expect(rows()).toEqual(['Running the search tests in the background. 14:24', 'Readapi/search.py14:251 line'])
  })

  it('stays on its tab after the subagent finishes: ended with it, a row of its list', async () => {
    const hub = await renderAgents(SUBAGENT)
    fireEvent.click(tab('limits-502'))

    act(() => {
      hub.fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...LIMITS, state: ToolCallState.Done, output: 'Opened PR #513.', finishedAt: HUB_NOW },
      })
    })
    send(hub, [{ ...TESTS, ...finishedAt(0, { state: WatcherState.Stopped, outcome: 'Ended with its subagent.' }) }])

    expect(tab('limits-502')).toHaveAttribute('aria-selected', 'true')
    expect(tab('limits-502')).not.toHaveAttribute('data-running')
    expect(eye('limits-502')).toBeNull()
    expect(pinned()).toBeNull()
    expect(rows().at(-1)).toBe(
      'CommandRun the search tests14:30Stopped · ran 6m · didn’t wake the agentendEnded with its subagent.',
    )
  })

  it('stays pinned on the tab of a subagent that has since finished, while it’s still live', async () => {
    const later = watcher('later', 20, {
      kind: WatcherKind.Wakeup,
      state: WatcherState.Scheduled,
      recurring: false,
      parentToolUseId: 'fix-501',
      label: 'Look at the deploy again',
      nextDueAt: HUB_NOW + 3 * MINUTE,
    })
    const stoppedWatchers: string[] = []
    await renderAgents({ ...SUBAGENT, watchers: [TESTS, later] }, { stoppedWatchers })

    expect(tab('fix-501')).not.toHaveAttribute('data-running')
    expect(eye('fix-501')).toHaveTextContent('1')
    expect(eye('fix-501')).not.toHaveAttribute('data-live')

    fireEvent.click(tab('fix-501'))
    expect(cards()).toEqual([later.label])
    fireEvent.click(screen.getByRole('button', { name: `Stop ${later.label}` }))
    await act(() => Promise.resolve())
    expect(stoppedWatchers).toEqual(['later'])
    expect(eye('fix-501')).toBeNull()
    // The other subagent's is as it was.
    expect(eye('limits-502')).toHaveTextContent('1')
  })

  it('shows each agent’s own as you go between their tabs', async () => {
    await renderAgents({
      ...SUBAGENT,
      toolEvents: [...(WATCHING.toolEvents ?? []), ...(SUBAGENT.toolEvents ?? [])].filter(
        (event, index, all) => all.findIndex(({ id }) => id === event.id) === index,
      ),
      watchers: [CI, PREVIEW, TESTS],
    })

    expect(cards()).toEqual([CI.label, PREVIEW.label])
    fireEvent.click(tab('limits-502'))
    expect(cards()).toEqual([TESTS.label])
    fireEvent.click(tab('fix-501'))
    expect(pinned()).toBeNull()
    fireEvent.click(tab('Main'))
    expect(cards()).toEqual([CI.label, PREVIEW.label])
  })
})

describe('after a relaunch', () => {
  it('shows what was live as the Watchers tab does: stopped by the relaunch, and a job waiting on its session', async () => {
    const queue = watcher('queue', 50, {
      kind: WatcherKind.Cron,
      state: WatcherState.Suspended,
      label: 'Staging queue depth',
      detail: 'Check the staging queue depth.',
      schedule: 'Every 5 minutes',
      wakes: 4,
      lastWokeAt: minutesAgo(8),
      nextDueAt: minutesAgo(3),
    })
    const relaunched = { state: WatcherState.Stopped, outcome: 'Stopped by the relaunch.', endedAt: minutesAgo(1) }
    const hub = await renderAgents({
      toolEvents: WATCHING.toolEvents ?? [],
      watchers: [{ ...CI, ...relaunched }, { ...PREVIEW, ...relaunched, nextDueAt: null }, queue],
    })

    // The monitor and the wakeup ended with the session: rows, at the relaunch.
    expect(endedRows().map((row) => row.textContent)).toEqual([
      'MonitorCI checks on PR #51114:29Stopped · ran 4m · didn’t wake the agentendStopped by the relaunch.',
      'WakeupCheck the docs preview for PR #51214:29Stopped · ran 1m · didn’t wake the agentendStopped by the relaunch.',
    ])
    // The job is still the session's: pinned, grey, until it resumes.
    expect(cards()).toEqual([queue.label])
    expect(card(queue.label)).toHaveTextContent(
      'Staging queue depthSuspendedStopCronEvery 5 minutesback when the session resumes · 4 wakes · last 14:22 · set 13:40',
    )
    expect(card(queue.label).className).not.toContain('live')
    expect(eye('Main')).not.toHaveAttribute('data-live')

    // The resumed session lists it again.
    send(hub, [
      { ...CI, ...relaunched },
      { ...PREVIEW, ...relaunched, nextDueAt: null },
      { ...queue, state: WatcherState.Scheduled, nextDueAt: HUB_NOW + 2 * MINUTE },
    ])
    expect(card(queue.label)).toHaveTextContent('Due in 2m')
  })
})

describe('a subagent’s tab menu', () => {
  const AGENTS: HubTask = {
    toolEvents: [
      FIX,
      LIMITS,
      note('s1', 'Reading the throttle.', 30, 'limits-502'),
      call('read', 29, {
        parentToolUseId: 'limits-502',
        name: 'Read',
        input: { file_path: `${ROOT}/api/throttle.py` },
        output: 'a\nb',
      }),
    ],
  }

  async function open(name: string): Promise<string[]> {
    fireEvent.contextMenu(tab(name))
    await act(() => Promise.resolve())
    return screen.queryAllByRole('menuitem').map((item) => item.textContent)
  }

  async function choose(name: string, label: string): Promise<void> {
    await open(name)
    fireEvent.click(screen.getByRole('menuitem', { name: label }))
    await act(() => Promise.resolve())
  }

  it('copies its log, and stops it while it runs', async () => {
    const copied: string[] = []
    const stoppedSubagents: string[] = []
    await renderAgents(AGENTS, { copied, stoppedSubagents })

    expect(await open('limits-502')).toEqual(['Copy log', 'Stop subagent'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy log' }))
    await act(() => Promise.resolve())
    expect(copied).toEqual(['limits-502\nReading the throttle.\nRead api/throttle.py\n  2 lines'])

    await choose('limits-502', 'Stop subagent')
    expect(stoppedSubagents).toEqual(['limits-502'])
    // The menu is the tab's own: it doesn't pick the tab.
    expect(tab('Main')).toHaveAttribute('aria-selected', 'true')
  })

  it('can’t stop one that has finished, and copies what it came to', async () => {
    const copied: string[] = []
    await renderAgents(AGENTS, { copied })

    expect(await open('fix-501')).toEqual(['Copy log'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy log' }))
    await act(() => Promise.resolve())
    expect(copied).toEqual(['fix-501\n\nOpened PR #511.'])
  })

  it('opens on the keyboard’s menu key, from the tab that has the focus', async () => {
    await renderAgents(AGENTS)
    const limits = tab('limits-502')
    fireEvent.click(limits)
    limits.focus()

    fireEvent.keyDown(limits, { key: 'ContextMenu' })
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy log', 'Stop subagent'])
    // The key was the menu's: it didn't move to another agent.
    expect(limits).toHaveAttribute('aria-selected', 'true')
  })

  it('has none on Main’s tab', async () => {
    await renderAgents(AGENTS)

    expect(await open('Main')).toEqual([])
    expect(screen.queryByRole('menu')).toBeNull()
  })

  it('has none for a subagent whose call left the log while its menu was asked for', async () => {
    const hub = await renderAgents(AGENTS)
    fireEvent.contextMenu(tab('limits-502'))
    act(() => {
      hub.store.setState(({ toolEvents }) => ({ toolEvents: { ...toolEvents, t1: [FIX] } }))
    })
    await act(() => Promise.resolve())

    expect(screen.queryAllByRole('menuitem')).toEqual([])
  })

  it('says so when the subagent can’t be stopped', async () => {
    await renderAgents(
      AGENTS,
      {},
      {
        [CommandName.SubagentsStop]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidTransition, "The subagent isn't running")),
      },
    )

    await choose('limits-502', 'Stop subagent')
    await act(() => Promise.resolve())

    expect(screen.getByText("The subagent isn't running")).toBeInTheDocument()
  })
})

describe('what a running subagent is doing now', () => {
  const agentCall = (name: string): HTMLElement => {
    const found = [...list().querySelectorAll<HTMLElement>('[data-agent-call]')].find((row) =>
      row.textContent.includes(name),
    )
    if (found === undefined) throw new Error(`No Agent call for ${name}`)
    return found
  }

  it('is under its Agent call’s state while it runs, on one line with the whole of it in its tooltip', async () => {
    const hub = await renderAgents({ toolEvents: [FIX, LIMITS] })
    expect(agentCall('limits-502')).toHaveTextContent(/Running · 34m$/)

    act(() => {
      hub.fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...LIMITS, progressSummary: 'Rerunning tests/test_search.py' },
      })
    })

    expect(agentCall('limits-502')).toHaveTextContent(/Running · 34mRerunning tests\/test_search\.py$/)
    expect(within(agentCall('limits-502')).getByText('Rerunning tests/test_search.py')).toHaveAttribute(
      'title',
      'Rerunning tests/test_search.py',
    )
  })

  it('goes once it has finished, whatever it last said it was doing', async () => {
    await renderAgents({
      toolEvents: [
        { ...FIX, progressSummary: 'Opening the PR' },
        { ...LIMITS, progressSummary: 'Reading the diff' },
      ],
    })

    expect(agentCall('fix-501')).toHaveTextContent(/Done · 28m · Opened PR #511\.$/)
    expect(agentCall('limits-502')).toHaveTextContent(/Running · 34mReading the diff$/)
  })
})
