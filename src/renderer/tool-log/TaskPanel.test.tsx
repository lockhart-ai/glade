import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import {
  CompactionTrigger,
  DividerKind,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type DividerEvent,
  type NarrationEvent,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
import { FOCUS_HIGHLIGHT_MS, HIGHLIGHT_CLASS } from './ToolLog'
import { TaskPanel } from './TaskPanel'

const AT = new Date(2026, 8, 23, 10, 44).getTime()
const ROOT = sampleWorkspace('w1').rootPath

function call(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn: 1,
    createdAt: AT,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: { file_path: `${ROOT}/api/views.py` },
    output: '1\tfrom x import y\n2\t\n3\tclass A: pass',
    state: ToolCallState.Done,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    ...overrides,
  }
}

function narration(id: string, turn: number, text: string): NarrationEvent {
  return { id, taskId: 't1', turn, createdAt: AT - 60_000, kind: ToolEventKind.Narration, text }
}

function divider(id: string, turn: number, dividerKind = DividerKind.Turn): DividerEvent {
  return { id, taskId: 't1', turn, createdAt: AT + 36 * 60_000, kind: ToolEventKind.Divider, dividerKind }
}

const TURN_ONE: ToolEvent[] = [
  divider('d1', 1),
  narration('n1', 1, 'Looking at how the API views are set up.'),
  call('c1'),
  call('c2', { name: 'Grep', input: { pattern: 'throttle' }, output: 'No matches found' }),
]

interface Setup {
  readonly toolEvents?: ToolEvent[]
  readonly selected?: boolean
}

async function renderPanel({ toolEvents = TURN_ONE, selected = true }: Setup = {}): Promise<
  FakeBridge & { store: GladeStore }
> {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
    ],
    toolEvents,
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <TaskPanel />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store }
}

function log(): HTMLElement {
  return screen.getByRole('log', { name: 'Tool log' })
}

function tab(name: RegExp | string): HTMLElement {
  return screen.getByRole('tab', { name })
}

function row(name: RegExp): HTMLElement {
  return within(log()).getByRole('button', { name })
}

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskPanel', () => {
  it('shows the tab bar, with Tool calls selected and counted, and an inert collapse button', async () => {
    await renderPanel()

    expect(screen.getAllByRole('tab').map((element) => element.textContent)).toEqual([
      'Tool calls 2',
      'Files',
      'Todos',
      'Artifacts',
      'Subagents',
    ])
    expect(tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    expect(tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
  })

  it('shows an empty state on the tabs not built yet', async () => {
    await renderPanel()

    for (const [name, empty] of [
      ['Files', 'No files yet.'],
      ['Todos', 'No todos yet.'],
      ['Artifacts', 'No artifacts yet.'],
      ['Subagents', 'No subagents yet.'],
    ] as const) {
      fireEvent.click(tab(name))
      expect(screen.getByRole('tabpanel')).toHaveTextContent(empty)
    }
    fireEvent.click(tab(/^Tool calls/))
    expect(log()).toBeInTheDocument()
  })

  it('says when there are no tool calls yet, and shows nothing without a task', async () => {
    await renderPanel({ toolEvents: [] })
    expect(screen.getByRole('tabpanel')).toHaveTextContent('No tool calls yet.')
    expect(tab(/^Tool calls/)).toHaveTextContent('Tool calls 0')
  })

  it('shows nothing in the log when no task is selected', async () => {
    await renderPanel({ selected: false })
    expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement()
  })

  describe('the tool log', () => {
    it('shows each call’s state, name, argument, time and short result', async () => {
      await renderPanel()

      expect(row(/Read/)).toHaveTextContent(/^Readapi\/views\.py10:443 lines$/)
      expect(within(row(/Read/)).getByRole('img', { name: 'Done' })).toHaveAttribute('data-state', 'done')
      expect(row(/Grep/)).toHaveTextContent('No matches found')
    })

    it('sits the agent’s notes between the rows, with their time', async () => {
      await renderPanel()

      expect(log()).toHaveTextContent(/^Looking at how the API views are set up\. 10:43Read/)
    })

    it('expands a row to its full output, and collapses it again', async () => {
      await renderPanel()

      fireEvent.click(row(/Read/))
      expect(row(/Read/)).toHaveAttribute('aria-expanded', 'true')
      expect(screen.getByLabelText('Read output')).toHaveTextContent('class A: pass')
      fireEvent.click(row(/Read/))
      expect(row(/Read/)).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByLabelText('Read output')).toBeNull()
    })

    it('says a running call has no output yet, and shows a failed call’s error', async () => {
      await renderPanel({
        toolEvents: [
          call('c1', { state: ToolCallState.Running, output: null }),
          call('c2', { name: 'Bash', input: { command: 'make' }, state: ToolCallState.Error, output: 'Exit 2' }),
          call('c3', { name: 'Glob', input: { pattern: '*' }, output: null }),
        ],
      })

      fireEvent.click(row(/^Running\s*Read/))
      expect(screen.getByLabelText('Read output')).toHaveTextContent('No output yet.')
      expect(row(/^Running\s*Read/)).toHaveTextContent('Running…')
      fireEvent.click(row(/^Failed\s*Bash/))
      expect(screen.getByLabelText('Bash output')).toHaveTextContent('Exit 2')
      fireEvent.click(row(/^Done\s*Glob/))
      expect(screen.getByLabelText('Glob output')).toHaveTextContent(/^$/)
    })

    it('marks where each turn after the first starts, and what else happened', async () => {
      await renderPanel({
        toolEvents: [...TURN_ONE, divider('d2', 2), call('c3', { turn: 2 }), divider('d3', 2, DividerKind.MarkedDone)],
      })

      expect(screen.getAllByRole('separator').map((element) => element.getAttribute('aria-label'))).toEqual([
        'turn 2 · 11:20',
        'marked done · 11:20',
      ])
      expect(screen.getAllByRole('separator')[0]).toHaveTextContent('turn 2 · 11:20')
    })

    it('shows a compaction as a Compact row, filled in when it finishes, that starts its turn if first', async () => {
      const running = {
        id: 'k1',
        taskId: 't1',
        turn: 2,
        createdAt: AT,
        kind: ToolEventKind.Compaction,
        trigger: CompactionTrigger.Manual,
        state: ToolCallState.Running,
        preTokens: null,
        postTokens: null,
        windowTokens: 200_000,
      } as const
      const { emit } = await renderPanel({ toolEvents: [...TURN_ONE, running] })

      const compact = within(log()).getByRole('group', { name: 'Compact' })
      expect(compact).toHaveTextContent(/^Compact\s*10:44Compacting…$/)
      expect(within(compact).getByLabelText('Running')).toBeInTheDocument()
      expect(compact.parentElement).toHaveAttribute('data-turn-start', '2')
      act(() => {
        emit({
          type: EventType.ToolEventUpdated,
          toolEvent: { ...running, state: ToolCallState.Done, preTokens: 198_000, postTokens: 41_000 },
        })
      })
      expect(within(log()).getByRole('group', { name: 'Compact' })).toHaveTextContent(
        /^Compact198k → 41k tokens10:44Resuming from a summary$/,
      )
      expect(within(within(log()).getByRole('group', { name: 'Compact' })).getByLabelText('Done')).toBeInTheDocument()
    })

    it('nests a subagent’s calls under the call that started it', async () => {
      await renderPanel({
        toolEvents: [
          call('agent', { name: 'Agent', input: { description: 'Find the settings' } }),
          call('grep', { name: 'Grep', input: { pattern: 'THROTTLE' }, parentToolUseId: 'use-agent' }),
        ],
      })

      const group = screen.getByRole('group', { name: 'Agent subagent calls' })
      expect(within(group).getByRole('button')).toHaveTextContent('GrepTHROTTLE')
      expect(tab(/^Tool calls/)).toHaveTextContent('Tool calls 2')
    })

    it('streams new entries and results live', async () => {
      const { emit } = await renderPanel({ toolEvents: [] })

      const running = call('c9', { name: 'Bash', input: { command: 'pytest -q' }, state: ToolCallState.Running })
      act(() => {
        emit({ type: EventType.ToolEventAppended, toolEvent: narration('n9', 1, 'Running the tests.') })
        emit({ type: EventType.ToolEventAppended, toolEvent: { ...running, output: null } })
      })
      expect(log()).toHaveTextContent('Running the tests.')
      expect(row(/^Running\s*Bash\s*pytest -q/)).toHaveTextContent('Running…')
      expect(tab(/^Tool calls/)).toHaveTextContent('Tool calls 1')

      act(() => {
        emit({
          type: EventType.ToolEventUpdated,
          toolEvent: { ...running, state: ToolCallState.Done, output: '14 passed in 3.2s' },
        })
      })
      expect(row(/^Done\s*Bash/)).toHaveTextContent('14 passed in 3.2s')
    })

    it('keeps to the bottom as it grows', async () => {
      const { emit } = await renderPanel()
      const scroller = log()
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 900 })

      act(() => {
        emit({ type: EventType.ToolEventAppended, toolEvent: call('c5', { turn: 1 }) })
      })
      expect(scroller.scrollTop).toBe(900)
    })
  })

  describe('showing a turn the chat asks for', () => {
    const TWO_TURNS: ToolEvent[] = [...TURN_ONE, divider('d2', 2), call('c3', { turn: 2 })]

    it('switches to Tool calls, scrolls to the turn’s divider and highlights it for a moment', async () => {
      const { store } = await renderPanel({ toolEvents: TWO_TURNS })
      vi.useFakeTimers()
      fireEvent.click(tab('Files'))

      act(() => {
        store.getState().focusTurn('t1', 2)
      })
      expect(tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
      const turnTwo = screen.getByRole('separator', { name: 'turn 2 · 11:20' })
      expect(scrollIntoView).toHaveBeenCalledOnce()
      expect(scrollIntoView.mock.contexts[0]).toBe(turnTwo)
      expect(turnTwo).toHaveClass(HIGHLIGHT_CLASS)

      act(() => {
        vi.advanceTimersByTime(FOCUS_HIGHLIGHT_MS)
      })
      expect(turnTwo).not.toHaveClass(HIGHLIGHT_CLASS)
    })

    it('scrolls to turn 1’s first row, which has no divider, and restarts the highlight when asked again', async () => {
      const { store } = await renderPanel({ toolEvents: TWO_TURNS })
      vi.useFakeTimers()
      const firstNote = screen.getByText(/^Looking at how/)

      act(() => {
        store.getState().focusTurn('t1', 1)
      })
      expect(scrollIntoView.mock.contexts[0]).toBe(firstNote)
      act(() => {
        store.getState().focusTurn('t1', 2)
      })
      expect(firstNote).not.toHaveClass(HIGHLIGHT_CLASS)
      expect(screen.getByRole('separator')).toHaveClass(HIGHLIGHT_CLASS)
    })

    it('ignores a request for another task, a turn not in the log, and an old request', async () => {
      const { store } = await renderPanel({ toolEvents: TWO_TURNS })
      fireEvent.click(tab('Files'))

      act(() => {
        store.getState().focusTurn('t2', 1)
      })
      expect(tab('Files')).toHaveAttribute('aria-selected', 'true')

      act(() => {
        store.getState().focusTurn('t1', 9)
      })
      expect(tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
      expect(scrollIntoView).not.toHaveBeenCalled()

      // Selecting the task again doesn't act on the request it already acted on.
      fireEvent.click(tab('Files'))
      await act(() => store.getState().selectTask('t2'))
      await act(() => store.getState().selectTask('t1'))
      expect(tab('Files')).toHaveAttribute('aria-selected', 'true')
    })
  })
})
