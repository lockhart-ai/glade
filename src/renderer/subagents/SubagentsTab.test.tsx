import { act, fireEvent, render as renderUnwrapped, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import {
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherKind,
  WatcherState,
  type NarrationEvent,
  type ToolCallEvent,
  type Watcher,
} from '../../shared/domain'
import { refuse, sampleWatcher, sampleWorkspace } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { ELAPSED_REFRESH_MS, SubagentsTab } from './SubagentsTab'
import styles from './SubagentsTab.module.css'

/** Renders under a store, which the tab's context menus act through. */
function render(ui: React.ReactElement, wrapper = storeWrapper()) {
  return renderUnwrapped(ui, { wrapper: wrapper.wrapper })
}

const AT = new Date(2026, 8, 23, 13, 8).getTime()
const ROOT = '/Users/sample/code/api'

function call(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: AT,
    kind: ToolEventKind.ToolCall,
    name: 'Bash',
    input: {},
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

function agent(id: string, description: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return call(id, { name: 'Agent', input: { description, prompt: '…' }, ...overrides })
}

function said(id: string, text: string, parent: string): NarrationEvent {
  return { id, taskId: 't1', turn: 1, createdAt: AT, kind: ToolEventKind.Narration, text, parentToolUseId: parent }
}

/** Three running subagents (one quiet, one mid-call, one that last said something) and one done. */
const EVENTS = [
  agent('links', 'Check links in the 2.3 notes', {
    state: ToolCallState.Done,
    output: 'Found 2 broken links and fixed both in the draft.',
    finishedAt: AT + 72_000,
  }),
  agent('api', 'API changes'),
  agent('dash', 'Dashboard changes'),
  agent('admin', 'Admin & internal changes'),
  said('api-note', 'Reading the API PRs, newest first.', 'use-api'),
  call('api-list', {
    input: { command: 'gh pr list --label api --state merged' },
    state: ToolCallState.Done,
    output: '1402',
    parentToolUseId: 'use-api',
  }),
  call('api-read', { name: 'Read', input: { file_path: `${ROOT}/api/throttles.py` }, parentToolUseId: 'use-api' }),
  call('dash-list', { input: { command: 'gh pr list' }, state: ToolCallState.Done, parentToolUseId: 'use-dash' }),
  said('dash-note', '#1418 moves the charts onto the new query.', 'use-dash'),
]

function row(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

/** The first of some elements. */
function first(elements: readonly HTMLElement[]): HTMLElement {
  const [element] = elements
  if (element === undefined) throw new Error('No element')
  return element
}

/** A subagent's row header: the button that opens and closes its log. */
function header(name: string): HTMLElement {
  return first(within(row(name)).getAllByRole('button'))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SubagentsTab', () => {
  it('says when there are no subagents', () => {
    render(<SubagentsTab taskId="t1" events={[call('bash')]} />)
    expect(screen.getByText('No subagents yet.')).toBeInTheDocument()
  })

  it('tallies the subagents by status and lists them, running ones first', () => {
    vi.useFakeTimers({ now: AT + 252_000 })
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} />)

    expect(screen.getByRole('group', { name: 'Subagents by status' })).toHaveTextContent('3 running1 done')
    expect(screen.getAllByRole('group', { name: /changes|links/ }).map((element) => element.dataset.status)).toEqual([
      'running',
      'running',
      'running',
      'done',
    ])
    expect(header('API changes')).toHaveTextContent('API changesRunningReadapi/throttles.py')
    expect(header('API changes')).toHaveTextContent('4m 12s · 2 tool calls')
    expect(header('Dashboard changes')).toHaveTextContent('“#1418 moves the charts onto the new query.”')
    expect(header('Dashboard changes')).toHaveTextContent('1 tool call')
    expect(header('Admin & internal changes')).toHaveTextContent(
      /^Admin & internal changesRunning4m 12s · 0 tool calls$/,
    )
    expect(header('Check links in the 2.3 notes')).toHaveTextContent(
      'DoneFound 2 broken links and fixed both in the draft.1m 12s · 0 tool calls',
    )
  })

  it('shows a failed subagent with its error', () => {
    render(
      <SubagentsTab
        taskId="t1"
        events={[agent('api', 'API changes', { state: ToolCallState.Error, output: 'Stopped.' })]}
      />,
    )
    expect(screen.getByRole('group', { name: 'Subagents by status' })).toHaveTextContent('1 failed')
    expect(header('API changes')).toHaveTextContent('API changesFailedStopped.0 tool calls')
  })

  it('opens a row’s log inline, in the tool log’s style, and closes it again', () => {
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} />)
    const api = header('API changes')
    expect(api).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(api)
    expect(api).toHaveAttribute('aria-expanded', 'true')
    const log = screen.getByRole('log', { name: 'API changes log' })
    expect(log).toHaveTextContent('Reading the API PRs, newest first.')
    expect(
      within(log)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Bashgh pr list --label api --state merged13:08', 'Readapi/throttles.py13:08'])
    // The log ends with the latest line, so the row doesn't repeat it.
    expect(api).not.toHaveTextContent('throttles')

    // A call in the log opens its output, as in the tool log.
    fireEvent.click(first(within(log).getAllByRole('button')))
    expect(within(log).getByLabelText('Bash output')).toHaveTextContent('1402')

    // Another row opens alongside it; clicking the first again closes it.
    fireEvent.click(header('Dashboard changes'))
    expect(screen.getAllByRole('log')).toHaveLength(2)
    fireEvent.click(api)
    expect(api).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('log', { name: 'API changes log' })).not.toBeInTheDocument()
  })

  it('says when an open subagent hasn’t done anything yet', () => {
    render(<SubagentsTab taskId="t1" events={[agent('api', 'API changes')]} />)
    fireEvent.click(header('API changes'))
    expect(screen.getByRole('log', { name: 'API changes log' })).toHaveTextContent('Nothing yet.')
  })

  it('shows a running subagent’s summary under its name, updating live, and none once it has finished', () => {
    vi.useFakeTimers({ now: AT + 60_000 })
    const api = (overrides: Partial<ToolCallEvent>) => agent('api', 'API changes', overrides)
    const dash = agent('dash', 'Dashboard changes', { progressSummary: 'Listing the merged dashboard PRs' })
    const read = call('api-read', {
      name: 'Read',
      input: { file_path: `${ROOT}/api/views.py` },
      parentToolUseId: 'use-api',
    })
    const { rerender } = render(<SubagentsTab taskId="t1" events={[api({}), dash, read]} rootPath={ROOT} />)
    expect(header('API changes')).toHaveTextContent(/^API changesRunningReadapi\/views\.py1m 00s · 1 tool call$/)
    expect(header('Dashboard changes')).toHaveTextContent(
      /^Dashboard changesRunningListing the merged dashboard PRs1m 00s · 0 tool calls$/,
    )

    rerender(
      <SubagentsTab
        taskId="t1"
        events={[api({ progressSummary: 'Reading the API PRs, newest first' }), dash, read]}
        rootPath={ROOT}
      />,
    )
    // Under its name, above its latest call.
    expect(header('API changes')).toHaveTextContent(
      /^API changesRunningReading the API PRs, newest firstReadapi\/views\.py/,
    )
    expect(screen.getByTitle('Reading the API PRs, newest first')).toBeInTheDocument()

    rerender(
      <SubagentsTab
        taskId="t1"
        events={[api({ progressSummary: 'Sorting 14 API PRs into features and fixes' }), dash, read]}
        rootPath={ROOT}
      />,
    )
    expect(header('API changes')).toHaveTextContent('Sorting 14 API PRs into features and fixes')
    expect(header('API changes')).not.toHaveTextContent('newest first')

    // Finished, it shows what it came to, as before.
    rerender(
      <SubagentsTab
        taskId="t1"
        events={[api({ state: ToolCallState.Done, output: 'Sorted 14 PRs.', finishedAt: AT + 60_000 }), dash, read]}
        rootPath={ROOT}
      />,
    )
    expect(header('API changes')).toHaveTextContent(/^API changesDoneSorted 14 PRs\.1m 00s · 1 tool call$/)
    expect(screen.queryByTitle(/Sorting 14 API PRs/)).not.toBeInTheDocument()
  })

  it('keeps a long summary to one line, with the whole of it in its tooltip', () => {
    const summary = `Reading the API PRs merged since v2.3.0, ${'newest first, '.repeat(20)}and sorting them`
    render(<SubagentsTab taskId="t1" events={[agent('api', 'API changes', { progressSummary: summary })]} />)

    const line = screen.getByTitle(summary)
    expect(line).toHaveTextContent(summary)
    // One line, cut with an ellipsis (`.summary` in the stylesheet): the e2e spec measures it.
    expect(line.className).toBe(styles.summary)
  })

  it('still shows the summary with the row’s log open', () => {
    render(<SubagentsTab taskId="t1" events={[agent('api', 'API changes', { progressSummary: 'Reading the PRs' })]} />)
    fireEvent.click(header('API changes'))
    expect(header('API changes')).toHaveTextContent('Reading the PRs')
  })

  it('ticks a running subagent’s elapsed time, and stops ticking once none is running', () => {
    vi.useFakeTimers({ now: AT + 60_000 })
    const { rerender } = render(<SubagentsTab taskId="t1" events={[agent('api', 'API changes')]} />)
    expect(header('API changes')).toHaveTextContent('1m 00s')

    act(() => {
      vi.advanceTimersByTime(5 * ELAPSED_REFRESH_MS)
    })
    expect(header('API changes')).toHaveTextContent('1m 05s')

    rerender(
      <SubagentsTab
        taskId="t1"
        events={[agent('api', 'API changes', { state: ToolCallState.Done, output: 'Done.', finishedAt: AT + 66_000 })]}
      />,
    )
    expect(header('API changes')).toHaveTextContent('1m 06s')
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('a subagent’s context menu', () => {
  async function open(name: string): Promise<string[]> {
    fireEvent.contextMenu(header(name))
    await act(() => Promise.resolve())
    return screen.getAllByRole('menuitem').map((item) => item.textContent)
  }

  async function choose(name: string, label: string): Promise<void> {
    await open(name)
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))
    await act(() => Promise.resolve())
  }

  it('opens and closes the log, copies it, and stops a running subagent', async () => {
    const copied: string[] = []
    const stoppedSubagents: string[] = []
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} />, storeWrapper({ copied, stoppedSubagents }))

    expect(await open('API changes')).toEqual(['Expand log↵', 'Copy log', 'Stop subagent'])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Expand log/ }))
    expect(screen.getByRole('log', { name: 'API changes log' })).toBeInTheDocument()
    expect(await open('API changes')).toContain('Collapse log↵')
    fireEvent.click(screen.getByRole('menuitem', { name: /^Collapse log/ }))
    expect(screen.queryByRole('log', { name: 'API changes log' })).toBeNull()

    await choose('API changes', 'Copy log')
    expect(copied).toEqual([
      expect.stringMatching(/^API changes\nReading the API PRs, newest first\.\nBash gh pr list/),
    ])

    await choose('API changes', 'Stop subagent')
    expect(stoppedSubagents).toEqual(['use-api'])
  })

  it('can’t stop a subagent that has finished', async () => {
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} />)

    expect(await open('Check links in the 2.3 notes')).toEqual(['Expand log↵', 'Copy log'])
  })

  it('shows a toast when the subagent can’t be stopped', async () => {
    const wrapper = storeWrapper(
      {},
      {
        [CommandName.SubagentsStop]: () =>
          refuse(bridgeError(BridgeErrorCode.InvalidTransition, "The subagent isn't running")),
      },
    )
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} />, wrapper)

    await choose('API changes', 'Stop subagent')

    expect(await screen.findByText("The subagent isn't running")).toBeInTheDocument()
  })

  it('opens a subagent call’s file in the Files tab, and puts its command at the terminal’s prompt', async () => {
    const wrapper = storeWrapper({
      workspaces: [{ ...sampleWorkspace('w1'), rootPath: ROOT }],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
    })
    await act(() => wrapper.store.getState().hydrate())
    const events = [
      agent('api', 'API changes'),
      call('api-list', {
        input: { command: 'gh pr list --label api' },
        state: ToolCallState.Done,
        output: '1402',
        parentToolUseId: 'use-api',
      }),
      call('api-read', {
        name: 'Read',
        input: { file_path: `${ROOT}/api/throttles.py` },
        state: ToolCallState.Done,
        output: 'RATE = 10',
        parentToolUseId: 'use-api',
      }),
    ]
    render(<SubagentsTab taskId="t1" events={events} rootPath={ROOT} />, wrapper)
    fireEvent.click(header('API changes'))
    const log = screen.getByRole('log', { name: 'API changes log' })
    const choose = async (name: RegExp, label: string): Promise<void> => {
      fireEvent.contextMenu(within(log).getByRole('button', { name }).parentElement ?? log)
      await act(() => Promise.resolve())
      fireEvent.click(screen.getByRole('menuitem', { name: label }))
      await act(() => Promise.resolve())
    }

    await choose(/^Done\s*Read/, 'Open file')
    expect(wrapper.store.getState().openFiles.t1?.activePath).toBe('api/throttles.py')
    expect(wrapper.store.getState().uiState[UiStateKey.RightPanelTab]).toBe('files')

    await choose(/^Done\s*Bash/, 'Run again in terminal')
    expect(wrapper.store.getState().terminalPaste).toMatchObject({ text: 'gh pr list --label api' })
  })

  it('leaves a tool call in an open log its own menu', async () => {
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} />)
    fireEvent.click(header('API changes'))

    const log = screen.getByRole('log', { name: 'API changes log' })
    fireEvent.contextMenu(within(log).getAllByRole('button')[0]?.parentElement ?? log)
    await act(() => Promise.resolve())

    expect(screen.getByRole('menu', { name: 'Tool call actions' })).toBeInTheDocument()
  })
})

describe('a subagent’s background work (#291)', () => {
  /** What the API subagent left running and what ended, beside the task's own command. */
  const WATCHERS: readonly Watcher[] = [
    sampleWatcher('own', 't1', { kind: WatcherKind.Command, label: 'Tail the deploy log', parentToolUseId: null }),
    sampleWatcher('e2e', 't1', {
      kind: WatcherKind.Command,
      label: 'Run the e2e suite',
      detail: 'npm run test:e2e',
      recurring: false,
      parentToolUseId: 'use-api',
      startedAt: AT,
    }),
    sampleWatcher('lint', 't1', {
      kind: WatcherKind.Command,
      label: 'Lint',
      detail: 'npm run lint',
      state: WatcherState.Finished,
      outcome: 'Background command "Lint" completed (exit code 0)',
      parentToolUseId: 'use-api',
      startedAt: AT,
      endedAt: AT + 30_000,
    }),
    sampleWatcher('dash-ci', 't1', { label: 'Dashboard CI', parentToolUseId: 'use-dash', state: WatcherState.Stopped }),
  ]

  it('marks a subagent with live background work, and lists it under the subagent’s log with Stop', async () => {
    const stoppedWatchers: string[] = []
    render(
      <SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} watchers={WATCHERS} />,
      storeWrapper({ watchers: [...WATCHERS], stoppedWatchers }),
    )

    expect(within(row('API changes')).getByRole('img', { name: '1 watcher running' })).toHaveTextContent('1')
    // Ended work isn't live: no mark.
    expect(within(row('Dashboard changes')).queryByRole('img')).toBeNull()
    expect(screen.queryByRole('group', { name: 'API changes background work' })).toBeNull()

    fireEvent.click(header('API changes'))
    const work = screen.getByRole('group', { name: 'API changes background work' })
    expect(
      within(work)
        .getAllByRole('group')
        .map((each) => each.getAttribute('aria-label')),
    ).toEqual(['Run the e2e suite', 'Lint'])
    expect(within(work).getByRole('group', { name: 'Lint' })).toHaveTextContent(
      'Background command "Lint" completed (exit code 0)',
    )
    // The task's own isn't a subagent's.
    expect(screen.queryByText('Tail the deploy log')).toBeNull()

    fireEvent.click(within(work).getByRole('button', { name: 'Stop Run the e2e suite' }))
    await act(() => Promise.resolve())
    expect(stoppedWatchers).toEqual(['e2e'])
    expect(within(work).queryByRole('button', { name: 'Stop Lint' })).toBeNull()
  })

  it('shows nothing for a subagent that left nothing running', () => {
    render(<SubagentsTab taskId="t1" events={EVENTS} rootPath={ROOT} watchers={WATCHERS} />)
    fireEvent.click(header('Admin & internal changes'))
    expect(screen.queryByRole('group', { name: 'Admin & internal changes background work' })).toBeNull()
  })

  it('ticks while a finished subagent’s work runs on', () => {
    vi.useFakeTimers({ now: AT + 60_000 })
    const finished = agent('api', 'API changes', { state: ToolCallState.Done, output: 'Done.', finishedAt: AT })
    render(<SubagentsTab taskId="t1" events={[finished]} watchers={WATCHERS} />)
    fireEvent.click(header('API changes'))
    expect(row('Run the e2e suite')).toHaveTextContent('1m 00s')
    act(() => {
      vi.advanceTimersByTime(5 * ELAPSED_REFRESH_MS)
    })
    expect(row('Run the e2e suite')).toHaveTextContent('1m 05s')
  })
})
