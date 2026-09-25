import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import {
  CompactionTrigger,
  DividerKind,
  FileContentKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Artifact,
  type DividerEvent,
  type NarrationEvent,
  type OpenFiles,
  type TodoList,
  type ToolCallEvent,
  type ToolEvent,
  type UiStateEntry,
} from '../../shared/domain'
import { requestClose } from '../commands/closeRequest'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
import { FOCUS_HIGHLIGHT_MS, HIGHLIGHT_CLASS } from '../tool-log/ToolLog'
import { MIN_PANEL_WIDTH } from './panelModel'
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
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    ...overrides,
  }
}

function narration(id: string, turn: number, text: string): NarrationEvent {
  return { id, taskId: 't1', turn, createdAt: AT - 60_000, kind: ToolEventKind.Narration, text, parentToolUseId: null }
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
  /** More stored UI state, e.g. the panel's tab or width. */
  readonly uiState?: UiStateEntry[]
  readonly openFiles?: OpenFiles[]
  readonly todos?: Readonly<Record<string, TodoList>>
  readonly artifacts?: readonly Artifact[]
}

async function renderPanel({
  toolEvents = TURN_ONE,
  selected = true,
  uiState = [],
  openFiles = [],
  todos,
  artifacts = [],
}: Setup = {}): Promise<FakeBridge & { store: GladeStore }> {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
      ...uiState,
    ],
    toolEvents,
    openFiles,
    artifacts,
    ...(todos === undefined ? {} : { todos }),
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <TaskPanel />
      </ToastProvider>
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
  it('shows the tab bar, with Tool calls selected and counted', async () => {
    await renderPanel()

    expect(screen.getAllByRole('tab').map((element) => element.textContent)).toEqual([
      'Tool calls 2',
      'Files',
      'Todos',
      'Artifacts',
      'Subagents',
    ])
    expect(tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
  })

  it('keeps the tab you pick in UI state', async () => {
    const { invoke, store } = await renderPanel()

    fireEvent.click(tab('Todos'))
    expect(tab('Todos')).toHaveAttribute('aria-selected', 'true')
    expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBe('todos')
    expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.RightPanelTab, value: 'todos' })

    // Picking the tab that's already selected writes nothing.
    invoke.mockClear()
    fireEvent.click(tab('Todos'))
    expect(invoke).not.toHaveBeenCalled()
  })

  it('opens on the stored tab, the same for every task', async () => {
    const { store } = await renderPanel({ uiState: [{ key: UiStateKey.RightPanelTab, value: 'artifacts' }] })

    expect(tab('Artifacts')).toHaveAttribute('aria-selected', 'true')
    await act(() => store.getState().selectTask('t2'))
    expect(tab('Artifacts')).toHaveAttribute('aria-selected', 'true')
  })

  it('collapses with its collapse button, and shows nothing while collapsed', async () => {
    const { store } = await renderPanel()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse side panel' }))
    expect(store.getState().uiState[UiStateKey.RightPanelCollapsed]).toBe('true')
    expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull()

    act(() => {
      void store.getState().setUiState({ key: UiStateKey.RightPanelCollapsed, value: 'false' })
    })
    expect(screen.getByRole('complementary', { name: 'Task panel' })).toBeInTheDocument()
  })

  it('takes its width from UI state, and keeps the width you resize it to', async () => {
    const { invoke, store } = await renderPanel({ uiState: [{ key: UiStateKey.RightPanelWidth, value: '600' }] })
    const slot = screen.getByTestId('right-panel')
    expect(slot.style.getPropertyValue('--right-panel-width')).toBe('600px')

    // Focused, → narrows the panel a step; jsdom lays nothing out, so there's only room for its minimum width.
    const handle = screen.getByRole('separator', { name: 'Resize panel' })
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(store.getState().uiState[UiStateKey.RightPanelWidth]).toBe(String(MIN_PANEL_WIDTH))
    expect(slot.style.getPropertyValue('--right-panel-width')).toBe(`${String(MIN_PANEL_WIDTH)}px`)

    // A key press that leaves the width where it is writes nothing.
    invoke.mockClear()
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(invoke).not.toHaveBeenCalled()
  })

  it('shows an empty state on Todos and Artifacts while they have nothing', async () => {
    await renderPanel()

    for (const [name, empty] of [
      ['Todos', 'No todos yet.'],
      ['Artifacts', 'No artifacts yet.'],
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
    expect(tab(/^Tool calls/)).toHaveTextContent(/^Tool calls$/)
  })

  it('shows nothing in the log, and no counts, when no task is selected', async () => {
    await renderPanel({ selected: false })
    expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement()
    expect(tab(/^Tool calls/)).toHaveTextContent(/^Tool calls$/)
  })

  describe('the Todos tab', () => {
    const list = (done: number, total: number): TodoList => ({
      items: Array.from({ length: total }, (_, index) => ({
        text: `Step ${String(index + 1)}`,
        state: index < done ? TodoState.Done : index === done ? TodoState.Doing : TodoState.Todo,
        note: index === done ? 'Working on it' : null,
      })),
      updatedAt: Date.now(),
    })

    it("counts the selected task's done todos in the tab, and shows its list", async () => {
      await renderPanel({ todos: { t1: list(3, 7) }, uiState: [{ key: UiStateKey.RightPanelTab, value: 'todos' }] })

      expect(tab(/^Todos/)).toHaveTextContent('Todos 3/7')
      expect(screen.getByRole('tabpanel')).toHaveTextContent('3 of 7 done')
      expect(within(screen.getByRole('list', { name: 'Todos' })).getAllByRole('listitem')).toHaveLength(7)
    })

    it('follows the list as the agent changes it, and shows the task you pick', async () => {
      const { emit, store } = await renderPanel({ uiState: [{ key: UiStateKey.RightPanelTab, value: 'todos' }] })
      expect(tab(/^Todos/)).toHaveTextContent(/^Todos$/)
      expect(screen.getByRole('tabpanel')).toHaveTextContent('No todos yet.')

      act(() => {
        emit({ type: EventType.TodosChanged, taskId: 't1', todos: list(1, 4) })
      })
      expect(tab(/^Todos/)).toHaveTextContent('Todos 1/4')
      expect(screen.getByRole('tabpanel')).toHaveTextContent('1 of 4 done')

      await act(() => store.getState().selectTask('t2'))
      expect(tab(/^Todos/)).toHaveTextContent(/^Todos$/)
      expect(screen.getByRole('tabpanel')).toHaveTextContent('No todos yet.')
    })

    it('shows nothing without a task', async () => {
      await renderPanel({ selected: false, uiState: [{ key: UiStateKey.RightPanelTab, value: 'todos' }] })
      expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement()
    })
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

    it('shows a call a pause cut off in purple, and one a quit cut off like a finished call', async () => {
      await renderPanel({
        toolEvents: [
          call('c1', {
            name: 'Bash',
            input: { command: 'python copy.py' },
            state: ToolCallState.Interrupted,
            output: 'Glade quit before this tool call finished.',
          }),
          call('c2', {
            name: 'Bash',
            input: { command: 'python copy.py --resume' },
            state: ToolCallState.Paused,
            output: 'The task paused before this tool call finished.',
          }),
        ],
      })

      const interrupted = row(/^Interrupted\s*Bash/)
      expect(interrupted).toHaveTextContent(/Interrupted$/)
      expect(within(interrupted).getByRole('img', { name: 'Interrupted' })).toHaveAttribute('data-state', 'done')
      expect(interrupted.parentElement).toHaveAttribute('data-state', ToolCallState.Interrupted)
      expect(interrupted.parentElement?.className).not.toMatch(/error/)
      fireEvent.click(interrupted)
      expect(screen.getByLabelText('Bash output')).toHaveTextContent('Glade quit before this tool call finished.')

      const paused = row(/^Paused\s*Bash/)
      expect(paused).toHaveTextContent(/Paused$/)
      expect(within(paused).getByRole('img', { name: 'Paused' })).toHaveAttribute('data-state', 'waiting')
      expect(paused.parentElement?.className).toMatch(/paused/)
    })

    it('shows inline code and emphasis in the agent’s notes, and nothing that loads or links', async () => {
      await renderPanel({
        toolEvents: [
          narration(
            'n1',
            1,
            'The project uses `django-storages` for *static* files. See [the docs](https://example.com) ![logo](https://example.com/x.png)',
          ),
        ],
      })

      const note = within(log()).getByText(/The project uses/)
      expect(within(note).getByText('django-storages').tagName).toBe('CODE')
      expect(within(note).getByText('static').tagName).toBe('EM')
      expect(note).toHaveTextContent('The project uses django-storages for static files. See the docs logo 10:43')
      expect(note.querySelector('a, img')).toBeNull()
    })

    it('marks where each turn after the first starts, and what else happened', async () => {
      await renderPanel({
        toolEvents: [...TURN_ONE, divider('d2', 2), call('c3', { turn: 2 }), divider('d3', 2, DividerKind.MarkedDone)],
      })

      expect(
        within(log())
          .getAllByRole('separator')
          .map((element) => element.getAttribute('aria-label')),
      ).toEqual(['turn 2 · 11:20', 'marked done · 11:20'])
      expect(within(log()).getAllByRole('separator')[0]).toHaveTextContent('turn 2 · 11:20')
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

    it('leaves a subagent’s calls out of the log: its Agent call is one row, and they’re in the Subagents tab', async () => {
      await renderPanel({
        toolEvents: [
          call('agent', { name: 'Agent', input: { description: 'Find the settings' }, output: 'In api/settings.py.' }),
          call('grep', { name: 'Grep', input: { pattern: 'THROTTLE' }, parentToolUseId: 'use-agent' }),
          { ...narration('said', 1, 'Looking for the throttle settings.'), parentToolUseId: 'use-agent' },
        ],
      })

      expect(
        within(log())
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['AgentFind the settings10:44In api/settings.py.'])
      expect(log()).not.toHaveTextContent('THROTTLE')
      expect(log()).not.toHaveTextContent('Looking for the throttle settings.')
      expect(screen.queryByRole('group', { name: 'Agent subagent calls' })).toBeNull()
      expect(tab(/^Tool calls/)).toHaveTextContent('Tool calls 1')

      fireEvent.click(tab(/^Subagents/))
      fireEvent.click(
        within(screen.getByRole('group', { name: 'Find the settings' })).getAllByRole('button')[0] ?? log(),
      )
      const subagentLog = screen.getByRole('log', { name: 'Find the settings log' })
      expect(subagentLog).toHaveTextContent('Looking for the throttle settings.')
      expect(within(subagentLog).getByRole('button')).toHaveTextContent('GrepTHROTTLE')
    })

    it('keeps nested and interleaved subagents’ calls, and a failing one, out of the log, live', async () => {
      const { emit } = await renderPanel({ toolEvents: [] })
      const events: ToolEvent[] = [
        call('outer', { name: 'Agent', input: { description: 'API changes' }, state: ToolCallState.Running }),
        call('other', { name: 'Agent', input: { description: 'Dashboard changes' }, state: ToolCallState.Running }),
        call('o1', { name: 'Bash', input: { command: 'gh pr list' }, parentToolUseId: 'use-outer' }),
        call('x1', {
          name: 'Bash',
          input: { command: 'redis-cli info' },
          state: ToolCallState.Error,
          output: 'Connection refused',
          parentToolUseId: 'use-other',
        }),
        call('inner', { name: 'Agent', input: { description: 'Read PR 1402' }, parentToolUseId: 'use-outer' }),
        call('i1', { name: 'Grep', input: { pattern: 'ratelimit' }, parentToolUseId: 'use-inner' }),
        call('own', { name: 'Grep', input: { pattern: 'CHANGELOG' }, output: 'CHANGELOG.md' }),
        call('x2', { name: 'Read', input: { file_path: `${ROOT}/web/charts.ts` }, parentToolUseId: 'use-other' }),
      ]
      act(() => {
        for (const toolEvent of events) emit({ type: EventType.ToolEventAppended, toolEvent })
      })

      expect(
        within(log())
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual([
        'AgentAPI changes10:44Running…',
        'AgentDashboard changes10:44Running…',
        'GrepCHANGELOG10:44CHANGELOG.md',
      ])
      expect(log()).not.toHaveTextContent(/gh pr list|redis-cli|Connection refused|ratelimit|charts\.ts|PR 1402/)
      expect(tab(/^Tool calls/)).toHaveTextContent('Tool calls 3')
      expect(tab(/^Subagents/)).toHaveTextContent('Subagents 3')

      fireEvent.click(tab(/^Subagents/))
      const open = (name: string): HTMLElement => {
        fireEvent.click(within(screen.getByRole('group', { name })).getAllByRole('button')[0] ?? log())
        return screen.getByRole('log', { name: `${name} log` })
      }
      const calls = (element: HTMLElement): string[] =>
        within(element)
          .getAllByRole('button')
          .map((button) => button.textContent)
      // Each subagent lists its own calls, in order; the nested one's sit under its Agent call, and in its own entry.
      expect(calls(open('API changes'))).toEqual([
        'Bashgh pr list10:44',
        'AgentRead PR 140210:44',
        'Grepratelimit10:44',
      ])
      expect(calls(open('Read PR 1402'))).toEqual(['Grepratelimit10:44'])
      const dashboard = open('Dashboard changes')
      expect(calls(dashboard)).toEqual(['Bashredis-cli info10:44', 'Readweb/charts.ts10:44'])
      expect(within(dashboard).getByLabelText('Failed')).toBeInTheDocument()
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

  describe('the Subagents tab', () => {
    const agent = (id: string, description: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent =>
      call(id, { name: 'Agent', input: { description }, state: ToolCallState.Running, output: null, ...overrides })

    it('counts nothing and says so when the task has no subagents', async () => {
      await renderPanel({ uiState: [{ key: UiStateKey.RightPanelTab, value: 'subagents' }] })
      expect(tab(/^Subagents/)).toHaveTextContent(/^Subagents$/)
      expect(screen.getByRole('tabpanel')).toHaveTextContent('No subagents yet.')
    })

    it('shows nothing without a task', async () => {
      await renderPanel({ selected: false, uiState: [{ key: UiStateKey.RightPanelTab, value: 'subagents' }] })
      expect(screen.getByRole('tabpanel')).toBeEmptyDOMElement()
    })

    it('lists the task’s subagents and follows them live', async () => {
      const { emit } = await renderPanel({
        toolEvents: [agent('api', 'API changes'), agent('links', 'Check links')],
        uiState: [{ key: UiStateKey.RightPanelTab, value: 'subagents' }],
      })
      const tally = (): HTMLElement => screen.getByRole('group', { name: 'Subagents by status' })
      expect(tab(/^Subagents/)).toHaveTextContent('Subagents 2')
      expect(tally()).toHaveTextContent('2 running')

      act(() => {
        emit({
          type: EventType.ToolEventAppended,
          toolEvent: call('bash', {
            name: 'Bash',
            input: { command: 'gh pr list' },
            state: ToolCallState.Running,
            output: null,
            parentToolUseId: 'use-api',
          }),
        })
        emit({
          type: EventType.ToolEventUpdated,
          toolEvent: agent('links', 'Check links', { state: ToolCallState.Done, output: 'Fixed both links.' }),
        })
      })
      expect(tally()).toHaveTextContent('1 running1 done')
      const api = screen.getByRole('group', { name: 'API changes' })
      expect(api).toHaveTextContent('Bashgh pr list')
      expect(api).toHaveTextContent('1 tool call')
      expect(screen.getByRole('group', { name: 'Check links' })).toHaveTextContent('Fixed both links.')
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
      expect(within(log()).getByRole('separator')).toHaveClass(HIGHLIGHT_CLASS)
    })

    it('opens the panel when it was collapsed, and keeps Tool calls as the tab', async () => {
      const { store } = await renderPanel({
        toolEvents: TWO_TURNS,
        uiState: [
          { key: UiStateKey.RightPanelCollapsed, value: 'true' },
          { key: UiStateKey.RightPanelTab, value: 'files' },
        ],
      })
      expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull()

      act(() => {
        store.getState().focusTurn('t1', 2)
      })
      expect(store.getState().uiState).toMatchObject({
        [UiStateKey.RightPanelCollapsed]: 'false',
        [UiStateKey.RightPanelTab]: 'tool-calls',
      })
      expect(tab(/^Tool calls/)).toHaveAttribute('aria-selected', 'true')
      expect(scrollIntoView.mock.contexts[0]).toBe(within(log()).getByRole('separator', { name: 'turn 2 · 11:20' }))
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

  describe('Artifacts', () => {
    const artifact = (path: string, title: string): Artifact => ({
      taskId: 't1',
      path,
      title,
      addedAt: AT,
      updatedAt: AT,
    })

    it('counts the task’s artifacts in the tab, keeps up with the agent, and shows their cards', async () => {
      const { emit } = await renderPanel({
        artifacts: [artifact('docs/releases/2.4.md', 'Release notes 2.4')],
        uiState: [{ key: UiStateKey.RightPanelTab, value: 'artifacts' }],
      })

      expect(tab(/^Artifacts/)).toHaveTextContent('Artifacts 1')
      expect(screen.getByRole('listitem', { name: 'Release notes 2.4' })).toBeInTheDocument()

      act(() => {
        emit({
          type: EventType.ArtifactsChanged,
          taskId: 't1',
          artifacts: [artifact('docs/releases/2.4.md', 'Release notes 2.4'), artifact('out/email.txt', 'Email')],
        })
      })
      expect(tab(/^Artifacts/)).toHaveTextContent('Artifacts 2')
      await waitFor(() => {
        expect(screen.getByRole('listitem', { name: 'Email' })).toHaveTextContent('Text · missing')
      })
    })
  })

  describe('Files', () => {
    const OPEN: OpenFiles = { taskId: 't1', paths: ['api/views.py', 'README.md'], activePath: 'api/views.py' }
    const FILES_TAB = { key: UiStateKey.RightPanelTab, value: 'files' }

    it('counts the files open, and shows the Files tab', async () => {
      await renderPanel({ openFiles: [OPEN], uiState: [FILES_TAB] })

      expect(tab(/^Files/)).toHaveTextContent('Files 2')
      expect(screen.getByRole('group', { name: 'Open files' })).toBeInTheDocument()
    })

    it('closes the file showing on Close (⌘W) while the focus is in the panel, keeping the focus there', async () => {
      const { invoke } = await renderPanel({ openFiles: [OPEN], uiState: [FILES_TAB] })
      const close = screen.getByRole('button', { name: 'Close views.py' })
      close.focus()

      expect(requestClose()).toBe(true)

      expect(invoke).toHaveBeenCalledWith(CommandName.FilesClose, { taskId: 't1', path: 'api/views.py' })
      await waitFor(() => {
        expect(screen.getByRole('tabpanel')).toHaveFocus()
      })
      expect(tab(/^Files/)).toHaveTextContent('Files 1')
    })

    it('leaves the focus where it is when it stays in the panel', async () => {
      await renderPanel({ openFiles: [OPEN], uiState: [FILES_TAB] })
      const list = screen.getByRole('button', { name: 'All files in this task' })
      list.focus()

      requestClose()

      await waitFor(() => {
        expect(tab(/^Files/)).toHaveTextContent('Files 1')
      })
      expect(list).toHaveFocus()
    })

    it('opens at Files, collapsed or not, when the agent shows a file, and marks its line', async () => {
      const lines = Array.from({ length: 12 }, (_, index) => `line ${String(index + 1)}`).join('\n')
      const fake = fakeBridge({
        workspaces: [sampleWorkspace('w1')],
        tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w1')],
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
          { key: UiStateKey.RightPanelCollapsed, value: 'true' },
        ],
        toolEvents: TURN_ONE,
        openFiles: [OPEN],
        files: { 'api/views.py': { kind: FileContentKind.Text, text: lines, truncated: false, size: lines.length } },
      })
      const store = createGladeStore(fake.bridge)
      render(
        <GladeStoreProvider store={store}>
          <ToastProvider>
            <TaskPanel />
          </ToastProvider>
        </GladeStoreProvider>,
      )
      await act(() => store.getState().hydrate())

      // Another task's file changes nothing here.
      act(() => {
        fake.emit({ type: EventType.FileShown, taskId: 't2', path: 'api/views.py', line: 3 })
      })
      expect(screen.queryByRole('complementary', { name: 'Task panel' })).toBeNull()

      act(() => {
        fake.emit({ type: EventType.FileShown, taskId: 't1', path: 'api/views.py', line: 9 })
      })
      expect(tab(/^Files/)).toHaveAttribute('aria-selected', 'true')
      await waitFor(() => {
        expect(screen.getByTestId('source').querySelector('[data-line="9"]')).toHaveAttribute('data-focused', 'true')
      })
    })

    it('leaves Close (⌘W) to the window on another tab, with no file open, or with the focus outside it', async () => {
      const { invoke } = await renderPanel({ openFiles: [OPEN, { taskId: 't2', paths: [], activePath: null }] })
      const panel = screen.getByRole('complementary', { name: 'Task panel' })
      const press = (): boolean => {
        screen.getByRole('tab', { name: /^Tool calls/ }).focus()
        return requestClose()
      }

      expect(press()).toBe(false)
      fireEvent.click(tab(/^Files/))
      ;(document.activeElement as HTMLElement | null)?.blur()
      expect(requestClose()).toBe(false)
      expect(panel.contains(document.activeElement)).toBe(false)
      fireEvent.click(screen.getByRole('button', { name: 'Close views.py' }))
      await waitFor(() => {
        expect(screen.queryByRole('button', { name: 'Close views.py' })).toBeNull()
      })
      fireEvent.click(screen.getByRole('button', { name: 'Close README.md' }))
      await waitFor(() => {
        expect(screen.getByText('No file open.')).toBeInTheDocument()
      })
      screen.getByRole('tabpanel').focus()
      expect(requestClose()).toBe(false)
      expect(invoke.mock.calls.filter(([command]) => command === CommandName.FilesClose)).toHaveLength(2)
    })
  })
})
