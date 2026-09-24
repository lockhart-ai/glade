import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import {
  CompactionTrigger,
  DividerKind,
  MessageRole,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Message,
  type Task,
  type ToolEvent,
} from '../../shared/domain'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge } from '../store/test-bridge'
import { clockTime } from './chatModel'
import { Chat } from './Chat'

const ASKED_AT = new Date(2026, 8, 23, 10, 42).getTime()
const REPLIED_AT = new Date(2026, 8, 23, 11, 6).getTime()

const ASK: Message = {
  id: 'm1',
  taskId: 't1',
  role: MessageRole.User,
  body: 'Add per-key rate limiting to the public API.',
  turn: 1,
  createdAt: ASKED_AT,
  summary: null,
}
const REPLY: Message = {
  id: 'm2',
  taskId: 't1',
  role: MessageRole.Agent,
  body: 'Tests pass.\n\nShould **/search** get a tighter limit of `60`?',
  turn: 1,
  createdAt: REPLIED_AT,
  summary: null,
}

const PREAMBLE = 'Looking at how the API views are set up.'
const TOOL_OUTPUT = 'class ThrottledViewSet: pass'

function toolCall(id: string, turn: number): ToolEvent {
  return {
    id,
    taskId: 't1',
    turn,
    createdAt: ASKED_AT,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: { file_path: 'api/views.py' },
    output: TOOL_OUTPUT,
    state: ToolCallState.Done,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
  }
}

function narration(id: string, turn: number, text: string): ToolEvent {
  return { id, taskId: 't1', turn, createdAt: ASKED_AT, kind: ToolEventKind.Narration, text }
}

const TURN_ONE: ToolEvent[] = [narration('n1', 1, PREAMBLE), toolCall('c1', 1), toolCall('c2', 1), toolCall('c3', 1)]

interface Setup {
  readonly task?: Partial<Task>
  readonly messages?: Message[]
  readonly toolEvents?: ToolEvent[]
  readonly selected?: boolean
}

async function renderChat({ task = {}, messages = [], toolEvents = [], selected = true }: Setup = {}): Promise<
  FakeBridge & { store: GladeStore }
> {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [{ ...sampleTask('t1', 'w1'), ...task }],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
    ],
    messages,
    toolEvents,
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <Chat />
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store }
}

function conversation(): HTMLElement {
  return screen.getByRole('log', { name: 'Conversation' })
}

describe('Chat', () => {
  it('asks a task with no messages what the agent should do, and where it will work', async () => {
    await renderChat()

    expect(screen.getByRole('heading', { name: 'What should the agent do?' })).toBeInTheDocument()
    expect(conversation()).toHaveTextContent(
      'Describe it in your own words. The agent names the task and writes its objective from your first message. ' +
        'It works in the workspace root, /code/w1.',
    )
  })

  it('shows the workspace root from the home folder as ~', async () => {
    const { store } = await renderChat()

    act(() => {
      store.setState({ workspaces: [{ ...sampleWorkspace('w1'), rootPath: '/Users/sam/code/api' }] })
    })
    expect(conversation()).toHaveTextContent('It works in the workspace root, ~/code/api.')
  })

  it('drops the prompt once the first message is in', async () => {
    const { emit } = await renderChat()

    act(() => {
      emit({ type: EventType.MessageAppended, message: ASK })
    })
    expect(screen.queryByRole('heading', { name: 'What should the agent do?' })).toBeNull()
    expect(screen.getByRole('article', { name: 'You' })).toHaveTextContent(ASK.body)
  })

  it('shows nothing when no task is selected', async () => {
    await renderChat({ selected: false, messages: [ASK] })

    expect(conversation()).toHaveTextContent(/^$/)
  })

  it('shows your message on the right and the agent’s reply as Markdown, each with its time', async () => {
    await renderChat({ messages: [ASK, REPLY], toolEvents: TURN_ONE })

    const you = screen.getByRole('article', { name: 'You' })
    expect(you).toHaveTextContent(ASK.body)
    expect(you).toHaveTextContent(`you · ${clockTime(ASKED_AT)}`)
    expect(clockTime(ASKED_AT)).toBe('10:42')

    const agent = screen.getByRole('article', { name: 'Agent' })
    expect(agent).toHaveTextContent(`agent · ${clockTime(REPLIED_AT)}`)
    expect(within(agent).getByText('/search').tagName).toBe('STRONG')
    expect(within(agent).getByText('60').tagName).toBe('CODE')
  })

  it('keeps your message as you wrote it, not as Markdown', async () => {
    await renderChat({ messages: [{ ...ASK, body: 'Use **bold**\nand a <b>tag</b>' }] })

    const you = screen.getByRole('article', { name: 'You' })
    expect(you).toHaveTextContent('Use **bold** and a <b>tag</b>')
    expect(you.querySelector('strong, b')).toBeNull()
  })

  it('never shows the preamble or tool output in the chat', async () => {
    const { emit } = await renderChat({ messages: [ASK, REPLY], toolEvents: TURN_ONE })

    expect(conversation()).not.toHaveTextContent(PREAMBLE)
    expect(conversation()).not.toHaveTextContent(TOOL_OUTPUT)
    expect(conversation()).not.toHaveTextContent('api/views.py')

    act(() => {
      emit({ type: EventType.ToolEventAppended, toolEvent: narration('n2', 1, 'Running the tests.') })
      emit({ type: EventType.ToolEventAppended, toolEvent: toolCall('c4', 1) })
    })
    expect(conversation()).not.toHaveTextContent('Running the tests.')
    expect(conversation()).not.toHaveTextContent(TOOL_OUTPUT)
    expect(screen.getAllByRole('article')).toHaveLength(2)
  })

  it('marks where Glade restarted and resumed a turn, saying it is resuming while the turn runs', async () => {
    const resumedAt = new Date(2026, 8, 23, 14, 26).getTime()
    const resumed: ToolEvent = {
      id: 'r1',
      taskId: 't1',
      turn: 1,
      createdAt: resumedAt,
      kind: ToolEventKind.Divider,
      dividerKind: DividerKind.Resumed,
    }
    const { emit } = await renderChat({
      task: { activity: TaskActivity.Working },
      messages: [ASK],
      toolEvents: [resumed],
    })

    const divider = within(conversation()).getByRole('separator', { name: 'Glade restarted' })
    expect(divider).toHaveTextContent('Glade restarted · 14:26 · resuming')

    act(() => {
      emit({ type: EventType.MessageAppended, message: REPLY })
      emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Waiting } })
    })
    expect(divider).toHaveTextContent(/^Glade restarted · 14:26$/)
  })

  it('marks where the task was marked done and where your message reopened it', async () => {
    const divider = (id: string, dividerKind: DividerKind, turn: number, createdAt: number): ToolEvent => ({
      id,
      taskId: 't1',
      turn,
      createdAt,
      kind: ToolEventKind.Divider,
      dividerKind,
    })
    const reopen: Message = { ...ASK, id: 'm3', body: 'Pro keys get 180 a minute.', turn: 2 }
    await renderChat({
      task: { activity: TaskActivity.Working },
      messages: [ASK, REPLY, reopen],
      toolEvents: [
        divider('d1', DividerKind.MarkedDone, 1, new Date(2026, 8, 23, 11, 26).getTime()),
        divider('d2', DividerKind.Reopened, 2, new Date(2026, 8, 25, 9, 14).getTime()),
        divider('d3', DividerKind.Turn, 2, new Date(2026, 8, 25, 9, 14).getTime()),
      ],
    })

    const items = [...conversation().querySelectorAll('article, [role="separator"]')].map((item) =>
      item.getAttribute('aria-label'),
    )
    expect(items).toEqual(['You', 'Agent', 'Marked done', 'You', 'Reopened'])
    expect(within(conversation()).getByRole('separator', { name: 'Marked done' })).toHaveTextContent(
      'Marked done · Sep 23, 11:26',
    )
    expect(within(conversation()).getByRole('separator', { name: 'Reopened' })).toHaveTextContent(
      /^Reopened by your message$/,
    )
  })

  it('says it is compacting while it compacts, then marks where it compacted, and never shows /compact', async () => {
    const running = {
      id: 'k1',
      taskId: 't1',
      turn: 1,
      createdAt: REPLIED_AT + 60_000,
      kind: ToolEventKind.Compaction,
      trigger: CompactionTrigger.Manual,
      state: ToolCallState.Running,
      preTokens: null,
      postTokens: null,
      windowTokens: 200_000,
    } as const
    const { emit } = await renderChat({
      task: { activity: TaskActivity.Working },
      messages: [ASK, REPLY],
      toolEvents: [...TURN_ONE, running],
    })

    expect(screen.getByRole('status')).toHaveTextContent('Working · Compacting the context')
    expect(within(conversation()).queryByRole('separator')).toBeNull()

    act(() => {
      emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...running, state: ToolCallState.Done, preTokens: 198_000, postTokens: 41_000 },
      })
      emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Waiting } })
    })

    const items = [...conversation().querySelectorAll('article, [role="separator"]')].map((item) =>
      item.getAttribute('aria-label'),
    )
    expect(items).toEqual(['You', 'Agent', 'Compacted'])
    expect(within(conversation()).getByRole('separator', { name: 'Compacted' })).toHaveTextContent(
      /^Compacted · 198k → 41k$/,
    )
    expect(conversation()).not.toHaveTextContent('/compact')
  })

  it('highlights the latest reply as a question while the agent waits on you', async () => {
    const { emit } = await renderChat({ messages: [ASK, REPLY] })
    const reply = (): Element | null => screen.getByRole('article', { name: 'Agent' }).firstElementChild

    expect(reply()?.className).toMatch(/question/)

    act(() => {
      emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working } })
    })
    expect(reply()?.className).not.toMatch(/question/)
  })

  describe('the working line', () => {
    const working = { activity: TaskActivity.Working }
    const turnTwo: Message = { ...ASK, id: 'm3', body: 'Use 60 for /search.', turn: 2 }

    it('shows the turn’s latest narration while the agent works, and goes when it stops', async () => {
      const { emit } = await renderChat({ task: working, messages: [ASK, REPLY, turnTwo], toolEvents: TURN_ONE })

      expect(screen.getByRole('status')).toHaveTextContent(/^Working$/)

      act(() => {
        emit({ type: EventType.ToolEventAppended, toolEvent: narration('n2', 2, 'Setting the /search limit.') })
      })
      expect(screen.getByRole('status')).toHaveTextContent('Working · Setting the /search limit.')

      act(() => {
        emit({ type: EventType.ToolEventAppended, toolEvent: narration('n3', 2, 'Running the tests.') })
      })
      expect(screen.getByRole('status')).toHaveTextContent('Working · Running the tests.')

      act(() => {
        emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Waiting } })
      })
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('shows instead of the new-task prompt on a first turn', async () => {
      await renderChat({ task: working })

      expect(screen.getByRole('status')).toHaveTextContent('Working')
      expect(screen.queryByRole('heading', { name: 'What should the agent do?' })).toBeNull()
    })
  })

  describe('the tool-call chip', () => {
    it("counts the reply's turn's tool calls and asks the tool log to show that turn", async () => {
      const turnTwo: Message[] = [
        { ...ASK, id: 'm3', turn: 2 },
        { ...REPLY, id: 'm4', turn: 2 },
      ]
      const { store } = await renderChat({
        messages: [ASK, REPLY, ...turnTwo],
        toolEvents: [...TURN_ONE, toolCall('c5', 2)],
      })

      const chips = screen.getAllByRole('button')
      expect(chips.map((chip) => chip.textContent)).toEqual(['3 tool calls', '1 tool call'])
      fireEvent.click(screen.getByRole('button', { name: '1 tool call' }))
      expect(store.getState().toolLogFocus).toEqual({ taskId: 't1', turn: 2, request: 1 })

      fireEvent.click(screen.getByRole('button', { name: '3 tool calls' }))
      expect(store.getState().toolLogFocus).toEqual({ taskId: 't1', turn: 1, request: 2 })
    })

    it('is left out for a turn without tool calls', async () => {
      await renderChat({ messages: [ASK, REPLY] })

      expect(within(screen.getByRole('article', { name: 'Agent' })).queryByRole('button')).toBeNull()
    })
  })

  describe('the turn summary', () => {
    const summary = { durationMs: (24 * 60 + 10) * 1000, filesChanged: 4, linesAdded: 61, linesRemoved: 3 }

    it('shows how long the turn ran and what it changed, beside the tool-call chip', async () => {
      await renderChat({ messages: [ASK, { ...REPLY, summary }], toolEvents: TURN_ONE })

      const line = screen.getByRole('note', { name: 'Turn summary' })
      expect(line).toHaveTextContent('Finished in 24m 10s · 4 files +61 −3')
      expect(line.previousElementSibling).toBe(screen.getByRole('button', { name: '3 tool calls' }))
      // The counts are spans of their own, coloured teal and pink.
      expect(within(line).getByText('+61').tagName).toBe('SPAN')
      expect(within(line).getByText('−3').tagName).toBe('SPAN')
    })

    it('shows on its own without tool calls, leaving out the files when none changed', async () => {
      const quick = { durationMs: 8_000, filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
      await renderChat({ messages: [ASK, { ...REPLY, summary: quick }] })

      expect(screen.getByRole('note', { name: 'Turn summary' })).toHaveTextContent(/^Finished in 8s$/)
      expect(screen.queryByRole('button')).toBeNull()
    })

    it('is left out for a reply without one, or with nothing to say', async () => {
      const empty = { durationMs: null, filesChanged: 0, linesAdded: 0, linesRemoved: 0 }
      await renderChat({
        messages: [ASK, REPLY, { ...ASK, id: 'm3', turn: 2 }, { ...REPLY, id: 'm4', summary: empty }],
      })

      expect(screen.queryByRole('note', { name: 'Turn summary' })).toBeNull()
    })
  })

  it('sticks to the bottom as messages arrive, unless you have scrolled up', async () => {
    const { emit } = await renderChat({ task: { activity: TaskActivity.Working }, messages: [ASK] })
    const scroller = conversation()
    const layOut = (scrollHeight: number): void => {
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 })
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: scrollHeight })
    }

    layOut(1000)
    act(() => {
      emit({ type: EventType.ToolEventAppended, toolEvent: narration('n1', 1, 'Reading the views.') })
    })
    expect(scroller.scrollTop).toBe(1000)

    scroller.scrollTop = 200
    fireEvent.scroll(scroller)
    layOut(1300)
    act(() => {
      emit({ type: EventType.MessageAppended, message: REPLY })
    })
    expect(scroller.scrollTop).toBe(200)
  })
})
