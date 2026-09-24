import { act, fireEvent, render as renderUnwrapped, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolCallState, ToolEventKind, type NarrationEvent, type ToolCallEvent } from '../../shared/domain'
import { storeWrapper } from '../store/test-wrapper'
import { ELAPSED_REFRESH_MS, SubagentsTab } from './SubagentsTab'

/** Renders under a store, which the tab's context menus act through. */
function render(ui: React.ReactElement) {
  return renderUnwrapped(ui, { wrapper: storeWrapper().wrapper })
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
