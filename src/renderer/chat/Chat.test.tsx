import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  AgentErrorKind,
  CompactionTrigger,
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionRequestState,
  QuestionSetState,
  TaskErrorSource,
  TaskState,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Message,
  type PermissionRequest,
  type QuestionSet,
  type Task,
  type TaskError,
  type TaskHandoff,
  type ToolEvent,
} from '../../shared/domain'
import { imageDataUrl, type ImageData } from '../../shared/images'
import { GIF, PNG } from '../../shared/test-images'
import { ToastProvider } from '../components'
import { IMAGE_LABEL } from '../images/StoredImage'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  samplePermissionRequest,
  sampleQuestionSet,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
} from '../store/test-bridge'
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
  images: [],
}
const REPLY: Message = {
  id: 'm2',
  taskId: 't1',
  role: MessageRole.Agent,
  body: 'Tests pass.\n\nShould **/search** get a tighter limit of `60`?',
  turn: 1,
  createdAt: REPLIED_AT,
  summary: null,
  images: [],
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
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
  }
}

function narration(id: string, turn: number, text: string): ToolEvent {
  return { id, taskId: 't1', turn, createdAt: ASKED_AT, kind: ToolEventKind.Narration, text, parentToolUseId: null }
}

const TURN_ONE: ToolEvent[] = [narration('n1', 1, PREAMBLE), toolCall('c1', 1), toolCall('c2', 1), toolCall('c3', 1)]

interface Setup {
  readonly task?: Partial<Task>
  readonly messages?: Message[]
  readonly toolEvents?: ToolEvent[]
  readonly questionSets?: QuestionSet[]
  readonly permissionRequests?: PermissionRequest[]
  readonly selected?: boolean
  /** Where the fake main records what the menus copy. */
  readonly copied?: string[]
  /** The stored images, by id. */
  readonly images?: Record<string, ImageData>
  /** The task's handoff note; none when left out. */
  readonly handoff?: TaskHandoff
}

async function renderChat({
  task = {},
  messages = [],
  toolEvents = [],
  questionSets = [],
  permissionRequests = [],
  selected = true,
  copied,
  images = {},
  handoff,
}: Setup = {}): Promise<FakeBridge & { store: GladeStore }> {
  const fake = fakeBridge({
    workspaces: [sampleWorkspace('w1')],
    tasks: [{ ...sampleTask('t1', 'w1'), ...task }],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: selected ? 't1' : '' },
    ],
    messages,
    toolEvents,
    questionSets,
    permissionRequests,
    images,
    ...(copied === undefined ? {} : { copied }),
    ...(handoff === undefined ? {} : { handoffs: { t1: handoff } }),
  })
  const store = createGladeStore(fake.bridge)
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <Chat />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  await act(() => store.getState().hydrate())
  return { ...fake, store }
}

function conversation(): HTMLElement {
  return screen.getByRole('log', { name: 'Conversation' })
}

describe('Chat', () => {
  it("shows the agent's questions as a card after your message, led by what it said just before asking", async () => {
    const set = { ...sampleQuestionSet('q1', 't1'), createdAt: REPLIED_AT }
    await renderChat({
      task: { activity: TaskActivity.Waiting, asking: true },
      messages: [ASK],
      toolEvents: [{ ...narration('n1', 1, 'A few choices are **yours**.'), createdAt: REPLIED_AT }],
      questionSets: [set],
    })

    const card = within(conversation()).getByRole('form', { name: 'Questions from the agent' })
    expect(card).toHaveTextContent('2 questions before I finish')
    const group = card.parentElement ?? card
    expect(group).toHaveTextContent(`A few choices are yours.2 questions before I finish`)
    expect(group).toHaveTextContent(`agent · ${clockTime(REPLIED_AT)}`)
    expect(within(group).getByText('yours').tagName).toBe('STRONG')
  })

  it('asks a task with no messages what the agent should do, and where it will work', async () => {
    await renderChat()

    expect(screen.getByRole('heading', { name: 'What should the agent do?' })).toBeInTheDocument()
    expect(conversation()).toHaveTextContent(
      'Describe it in your own words. The agent names the task and writes its objective from your first message. ' +
        'It works in the workspace root, /code/w1.',
    )
  })

  it("shows a backfilled task's handoff note at the top, in place of what to write", async () => {
    const handoff = { taskId: 't1', body: '## Where it got to\n\nThe v2 handlers are live.', addedAt: ASKED_AT }
    await renderChat({ task: { state: TaskState.Done }, handoff })

    const card = within(conversation()).getByRole('region', { name: 'Backfilled' })
    expect(card).toHaveTextContent('handoff from earlier notes, added Sep 23')
    expect(within(card).getByRole('heading', { name: 'Where it got to' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'What should the agent do?' })).toBeNull()
  })

  it('keeps the handoff note above the conversation, and follows it as the control API changes it', async () => {
    const handoff = { taskId: 't1', body: 'The v2 handlers are live.', addedAt: ASKED_AT }
    const { emit } = await renderChat({ messages: [ASK, REPLY], handoff })

    const thread = conversation().firstElementChild
    expect(thread?.firstElementChild).toBe(screen.getByRole('region', { name: 'Backfilled' }))
    expect(screen.getByRole('article', { name: 'You' })).toHaveTextContent(ASK.body)

    act(() => {
      emit({ type: EventType.HandoffChanged, taskId: 't1', handoff: { ...handoff, body: 'Subscriptions next.' } })
    })
    expect(screen.getByRole('region', { name: 'Backfilled' })).toHaveTextContent('Subscriptions next.')

    act(() => {
      emit({ type: EventType.HandoffChanged, taskId: 't1', handoff: null })
    })
    expect(screen.queryByRole('region', { name: 'Backfilled' })).toBeNull()
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

  it('shows the images pasted into your message as thumbnails above its text, in order', async () => {
    const images = [
      { id: 'i1', mediaType: PNG.mediaType },
      { id: 'i2', mediaType: GIF.mediaType },
    ]
    await renderChat({ messages: [{ ...ASK, images }, REPLY], images: { i1: PNG, i2: GIF } })
    await act(() => Promise.resolve())

    const you = screen.getByRole('article', { name: 'You' })
    expect(
      within(you)
        .getAllByRole('img', { name: IMAGE_LABEL })
        .map((image) => image.getAttribute('src')),
    ).toEqual([imageDataUrl(PNG), imageDataUrl(GIF)])
    expect(you).toHaveTextContent(ASK.body)
    expect(within(screen.getByRole('article', { name: 'Agent' })).queryByRole('img')).toBeNull()
  })

  it('shows a message that is only images without an empty bubble', async () => {
    await renderChat({
      messages: [{ ...ASK, body: '', images: [{ id: 'i1', mediaType: PNG.mediaType }] }],
      images: { i1: PNG },
    })
    await act(() => Promise.resolve())

    const you = screen.getByRole('article', { name: 'You' })
    expect(within(you).getByRole('img', { name: IMAGE_LABEL })).toHaveAttribute('src', imageDataUrl(PNG))
    expect(you).toHaveTextContent(`you · ${clockTime(ASKED_AT)}`)
    expect(you.children).toHaveLength(2)
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

    it('says which retry is running while a failed API request is retried', async () => {
      const retrying = { attempt: 2, maxRetries: 10, since: ASKED_AT }
      const { emit } = await renderChat({ task: { ...working, retrying }, messages: [ASK], toolEvents: TURN_ONE })

      expect(screen.getByRole('status')).toHaveTextContent(/^Retrying \(2 of 10\)…$/)

      act(() => {
        emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), ...working } })
      })
      expect(screen.getByRole('status')).toHaveTextContent(`Working · ${PREAMBLE}`)
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

  describe('the paused line', () => {
    const resumesAt = new Date(2099, 8, 23, 11, 42).getTime()

    it('says when a usage limit pause resumes, after the conversation, and shows no error card', async () => {
      const pause = { reason: PauseReason.UsageLimit, since: ASKED_AT, resumesAt, checks: 0, details: 'Limit.' }
      await renderChat({ task: { activity: TaskActivity.Paused, pause }, messages: [ASK] })

      const line = screen.getByRole('status', { name: 'Paused' })
      expect(line).toHaveTextContent(/^Paused · resumes at Sep 23 11:42$/)
      expect(line.previousElementSibling).toBe(screen.getByRole('article', { name: 'You' }))
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('says an offline pause resumes when the network is back, and goes once the task resumes', async () => {
      const pause = { reason: PauseReason.Offline, since: ASKED_AT, resumesAt, checks: 2, details: 'Connection error.' }
      const { emit } = await renderChat({ task: { activity: TaskActivity.Paused, pause }, messages: [ASK] })
      expect(screen.getByRole('status', { name: 'Paused' })).toHaveTextContent(
        'Paused · resumes when the network is back',
      )

      act(() => {
        emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working } })
      })
      expect(screen.queryByRole('status', { name: 'Paused' })).toBeNull()
    })
  })

  describe('the error card', () => {
    const OVERLOADED: TaskError = {
      kind: AgentErrorKind.Transient,
      source: TaskErrorSource.Api,
      status: 529,
      code: 'overloaded',
      details: 'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      retries: 3,
      retryingMs: 120_000,
    }
    const stopped = { activity: TaskActivity.Error, error: OVERLOADED }

    function card(): HTMLElement {
      return screen.getByRole('alert')
    }

    it('says the agent stopped, what happened, and that nothing is lost, after the conversation', async () => {
      await renderChat({ task: stopped, messages: [ASK], toolEvents: TURN_ONE })

      expect(within(card()).getByText('The agent stopped')).toBeInTheDocument()
      expect(card()).toHaveTextContent(
        'The API returned 529 overloaded. Glade retried 3 times over 2 minutes, then paused the task. ' +
          'Nothing is lost: the chat, tool log and files are as they were.',
      )
      expect(within(card()).getByText('529 overloaded').tagName).toBe('SPAN')
      expect(card().previousElementSibling).toBe(screen.getByRole('article', { name: 'You' }))
      expect(screen.queryByRole('status')).toBeNull()
    })

    it('shows only while an error stops an active task', async () => {
      const { emit } = await renderChat({ task: { ...stopped, state: TaskState.Done }, messages: [ASK] })
      expect(screen.queryByRole('alert')).toBeNull()

      act(() => {
        emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), ...stopped } })
      })
      expect(card()).toBeInTheDocument()

      act(() => {
        emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working } })
      })
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('says less, and has no details, for an error it knows nothing about', async () => {
      await renderChat({ task: { activity: TaskActivity.Error, error: null }, messages: [ASK] })

      expect(card()).toHaveTextContent('The agent stopped on an error. Glade paused the task. Nothing is lost')
      expect(within(card()).queryByRole('button', { name: 'Show details' })).toBeNull()
    })

    it('retries the turn', async () => {
      const { invoke } = await renderChat({ task: stopped, messages: [ASK] })

      fireEvent.click(within(card()).getByRole('button', { name: 'Retry' }))

      expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksRetry, { id: 't1' })
      expect(await screen.findByRole('status')).toHaveTextContent('Working')
      expect(screen.queryByRole('alert')).toBeNull()
    })

    it('retries with the model you pick', async () => {
      const { invoke } = await renderChat({ task: stopped, messages: [ASK] })

      const button = within(card()).getByRole('button', { name: 'Retry with another model' })
      expect(button).toHaveAttribute('aria-expanded', 'false')
      fireEvent.click(button)
      expect(button).toHaveAttribute('aria-expanded', 'true')
      fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Sonnet 5' }))

      expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksRetry, { id: 't1', model: 'claude-sonnet-5' })
      expect(await screen.findByRole('status')).toHaveTextContent('Working')
    })

    it('closes the model menu without retrying', async () => {
      const { invoke } = await renderChat({ task: stopped, messages: [ASK] })
      fireEvent.click(within(card()).getByRole('button', { name: 'Retry with another model' }))
      await screen.findByRole('menu')

      fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

      expect(screen.queryByRole('menu')).toBeNull()
      expect(invoke).not.toHaveBeenCalledWith(CommandName.TasksRetry, expect.anything())
    })

    it('shows and hides the raw error', async () => {
      await renderChat({ task: stopped, messages: [ASK] })

      fireEvent.click(within(card()).getByRole('button', { name: 'Show details' }))
      expect(screen.getByLabelText('Error details')).toHaveTextContent(OVERLOADED.details)

      fireEvent.click(within(card()).getByRole('button', { name: 'Hide details' }))
      expect(screen.queryByLabelText('Error details')).toBeNull()
    })

    it('says so when the retry could not start', async () => {
      const { invoke } = await renderChat({ task: stopped, messages: [ASK] })
      invoke.mockRejectedValueOnce(bridgeError(BridgeErrorCode.Busy, 'The agent is working'))

      fireEvent.click(within(card()).getByRole('button', { name: 'Retry' }))

      expect(await screen.findByText('Couldn’t retry: The agent is working')).toBeInTheDocument()
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

describe('an agent reply’s context menu', () => {
  // jsdom lays nothing out, so it has no innerText: the reply's text content stands in for it.
  const innerText = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'innerText')
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get(this: HTMLElement) {
        return this.textContent
      },
    })
  })
  afterAll(() => {
    if (innerText === undefined) Reflect.deleteProperty(HTMLElement.prototype, 'innerText')
    else Object.defineProperty(HTMLElement.prototype, 'innerText', innerText)
  })

  function reply(): HTMLElement {
    return within(conversation()).getByRole('article', { name: 'Agent' })
  }

  async function choose(label: string): Promise<void> {
    fireEvent.contextMenu(reply())
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))
    await act(() => Promise.resolve())
  }

  it('copies the reply as it reads, or as Markdown', async () => {
    const copied: string[] = []
    await renderChat({ messages: [ASK, REPLY], toolEvents: TURN_ONE, copied })

    fireEvent.contextMenu(reply())
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual([
      'Copy⌘C',
      'Copy as Markdown',
      'Quote in reply',
      "Show this turn's tool calls",
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: /^Copy⌘C/ }))
    await choose('Copy as Markdown')

    expect(copied).toEqual(['Tests pass.\nShould /search get a tighter limit of 60?', REPLY.body])
  })

  it('quotes the reply in yours, and shows its turn in the tool log', async () => {
    const { store } = await renderChat({ messages: [ASK, REPLY], toolEvents: TURN_ONE })

    await choose('Quote in reply')
    expect(store.getState().inputInsertion).toEqual({
      taskId: 't1',
      text: '> Tests pass.\n>\n> Should **/search** get a tighter limit of `60`?\n\n',
      request: 1,
    })

    await choose("Show this turn's tool calls")
    expect(store.getState().toolLogFocus).toEqual({ taskId: 't1', turn: 1, request: 1 })
  })

  it('opens on ⇧F10 while the reply has the focus, and has no tool calls to show for a turn without any', async () => {
    await renderChat({ messages: [ASK, REPLY] })

    reply().focus()
    fireEvent.keyDown(reply(), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())

    expect(screen.getByRole('menu', { name: 'Reply actions' })).toHaveTextContent(
      /^Copy⌘CCopy as MarkdownQuote in reply$/,
    )
  })
})

/**
 * #248: some replies showed as bare text. Only the latest reply while the agent waited on you had a card (the purple
 * question card); every other reply, and what the agent said before asking, had none. Every shape of turn the chat
 * knows must put each piece of the agent's text on a card.
 */
describe('every agent reply is on a card', () => {
  const at = (hour: number, minute = 0): number => new Date(2026, 8, 23, hour, minute).getTime()
  const user = (id: string, turn: number, createdAt: number): Message => ({ ...ASK, id, turn, createdAt })
  const agent = (id: string, turn: number, createdAt: number, body = `Reply ${id}.`): Message => ({
    ...REPLY,
    id,
    turn,
    createdAt,
    body,
  })
  const divider = (id: string, dividerKind: DividerKind, turn: number, createdAt: number): ToolEvent => ({
    id,
    taskId: 't1',
    turn,
    createdAt,
    kind: ToolEventKind.Divider,
    dividerKind,
  })

  /** The element each agent reply's text is rendered on, in chat order. */
  function replyBodies(): Element[] {
    return within(conversation())
      .getAllByRole('article', { name: 'Agent' })
      .map((article) => article.firstElementChild)
      .filter((body): body is Element => body !== null)
  }

  /** Checks every reply is on a card: the purple one for `question` (the latest while waiting), the neutral otherwise. */
  function expectAllCarded(count: number, question: number | null = null): void {
    const bodies = replyBodies()
    expect(bodies).toHaveLength(count)
    bodies.forEach((body, index) => {
      expect(body.className).toMatch(/card/)
      if (index === question) expect(body.className).toMatch(/question/)
      else expect(body.className).not.toMatch(/question/)
    })
  }

  it('an earlier reply, not only the latest one while the agent waits on you', async () => {
    await renderChat({
      messages: [user('u1', 1, at(9)), agent('a1', 1, at(10)), user('u2', 2, at(11)), agent('a2', 2, at(12))],
    })
    expectAllCarded(2, 1)
  })

  it.each<[string, Partial<Task>]>([
    ['working', { activity: TaskActivity.Working }],
    ['stopped by an error', { activity: TaskActivity.Error }],
    ['done', { state: TaskState.Done }],
    [
      'paused',
      {
        activity: TaskActivity.Paused,
        pause: { reason: PauseReason.UsageLimit, since: at(10), resumesAt: at(13), checks: 0, details: 'Limit.' },
      },
    ],
  ])('the latest reply while the task is %s', async (_, task) => {
    await renderChat({ task, messages: [user('u1', 1, at(9)), agent('a1', 1, at(10))] })
    expectAllCarded(1)
  })

  it('a reply in a turn the agent started itself, with no message from you', async () => {
    await renderChat({
      messages: [user('u1', 1, at(9)), agent('a1', 1, at(10)), agent('a2', 2, at(11))],
      toolEvents: [divider('d1', DividerKind.Turn, 2, at(10, 30)), toolCall('c1', 2)],
    })
    expectAllCarded(2, 1)
  })

  it('a reply in a turn resumed after Glade restarted', async () => {
    await renderChat({
      task: { state: TaskState.Done },
      messages: [user('u1', 1, at(9)), agent('a1', 1, at(11))],
      toolEvents: [divider('r1', DividerKind.Resumed, 1, at(10))],
    })
    expect(within(conversation()).getByRole('separator', { name: 'Glade restarted' })).toBeInTheDocument()
    expectAllCarded(1)
  })

  it('replies on both sides of a reopening, and after a compaction', async () => {
    const compaction: ToolEvent = {
      id: 'k1',
      taskId: 't1',
      turn: 2,
      createdAt: at(12, 30),
      kind: ToolEventKind.Compaction,
      trigger: CompactionTrigger.Manual,
      state: ToolCallState.Done,
      preTokens: 198_000,
      postTokens: 41_000,
      windowTokens: 200_000,
    }
    await renderChat({
      messages: [user('u1', 1, at(9)), agent('a1', 1, at(10)), user('u2', 2, at(12)), agent('a2', 2, at(13))],
      toolEvents: [
        divider('d1', DividerKind.MarkedDone, 1, at(11)),
        divider('d2', DividerKind.Reopened, 2, at(12)),
        divider('d3', DividerKind.Turn, 2, at(12)),
        compaction,
      ],
    })
    expect(within(conversation()).getByRole('separator', { name: 'Compacted' })).toBeInTheDocument()
    expectAllCarded(2, 1)
  })

  it("a backfilled or imported task's replies, below its handoff note", async () => {
    await renderChat({
      task: { importedAt: at(8) },
      messages: [agent('a1', 1, at(9)), user('u1', 2, at(10)), agent('a2', 2, at(11))],
      handoff: { taskId: 't1', body: 'The v2 handlers are live.', addedAt: at(8) },
    })
    expectAllCarded(2, 1)
  })

  it('replies split around a question card and a permission card, and an empty reply', async () => {
    const set = { ...sampleQuestionSet('q1', 't1'), createdAt: at(10), state: QuestionSetState.Answered }
    const request = {
      ...samplePermissionRequest('p1', 't1'),
      turn: 2,
      createdAt: at(12),
      state: PermissionRequestState.Allowed,
    }
    await renderChat({
      task: { state: TaskState.Done },
      messages: [user('u1', 1, at(9)), agent('a1', 1, at(11)), user('u2', 2, at(11, 30)), agent('a2', 2, at(13), '')],
      questionSets: [set],
      permissionRequests: [request],
    })
    expectAllCarded(2)
  })

  it('what the agent said just before asking', async () => {
    await renderChat({
      task: { asking: true },
      messages: [user('u1', 1, at(9))],
      toolEvents: [{ ...narration('n1', 1, 'A few choices are yours.'), createdAt: at(10) }],
      questionSets: [{ ...sampleQuestionSet('q1', 't1'), createdAt: at(10) }],
    })
    const lead = within(conversation()).getByText('A few choices are yours.').closest('div')
    expect(lead?.className).toMatch(/card/)
    expect(lead?.className).not.toMatch(/question/)
  })

  it('all of them again after a relaunch', async () => {
    const messages = [
      user('u1', 1, at(9)),
      agent('a1', 1, at(10)),
      agent('a2', 2, at(11)),
      user('u2', 3, at(12)),
      agent('a3', 3, at(14)),
    ]
    const toolEvents = [divider('d1', DividerKind.Turn, 2, at(10, 30)), divider('r1', DividerKind.Resumed, 3, at(13))]
    const { bridge } = await renderChat({ messages, toolEvents })
    expectAllCarded(3, 2)
    cleanup()

    // The app starts over from what main saved: a new store, hydrated from the same data.
    const store = createGladeStore(bridge)
    render(
      <GladeStoreProvider store={store}>
        <ToastProvider>
          <Chat />
        </ToastProvider>
      </GladeStoreProvider>,
    )
    await act(() => store.getState().hydrate())
    expectAllCarded(3, 2)
  })
})
