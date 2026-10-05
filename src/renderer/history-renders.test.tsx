// The regression guard for #413 (typing lag in a task with a very long history): the chat, the tool log and the
// Subagents tab render again with every change to the task, its logs or the clock, so each of their rows must render
// only when its own data changed. Rows are counted by a function each calls exactly once per render. The Broadcast
// modal's recipients (#489) are held to the same: one row per active task, in every workspace. So is the todo hub
// (P16, #497): a card per todo, and a tile per child of an open one. The links a todo's text names (#500) are worked
// out when the task's links or its todos change, and at no other time. And so is the Agents tab (P16, #536): a tab per
// agent in its strip, and the list of the one agent showing.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageLevel, UsageLimitKind, type UsageReading } from '../shared/account'
import { EventType } from '../shared/bridge'
import {
  MessageRole,
  PermissionRequestState,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherKind,
  WatcherState,
  type Message,
  type NarrationEvent,
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../shared/domain'
import { FolderAccess, SandboxAskKind } from '../shared/sandbox'
import { AgentsTab } from './agents'
import { agentCallResult, agentDotLabel, agentStateLine } from './agents/agentsModel'
import { endedSummary, pinnedMetaLine, pinnedStatus, watchingTitle } from './agents/agentWatchersModel'
import { BroadcastDialog } from './broadcast'
import { attentionLabel, reachText } from './broadcast/broadcastModel'
import { Chat } from './chat'
import { settleFloating } from './components/settleFloating'
import { clockTime } from './chat/chatModel'
import { permissionLinesByToolUse } from './permissions/permissionLines'
import { samplePermissionRequest, sampleTask, sampleWatcher, sampleWorkspace } from './store/test-bridge'
import { storeWrapper, type StoreWrapper } from './store/test-wrapper'
import { TaskList } from './task-list'
import {
  HUB_NOW,
  HubForTask,
  hubAgent,
  hubCommit,
  hubFile,
  hubFiling,
  hubLink,
  hubStore,
  hubTodo,
  hubWatcher,
  refOf,
  type HubStore,
} from './todos/test-hub'
import { kindCounts, tileLabel } from './todos/todoHubModel'
import { linkReferences, namedBy, todoSegments } from './todos/todoLinks'
import { ChildFilter } from '../shared/todoHub'
import { rowStatus } from './task-list/rowStatus'
import { NOW_REFRESH_MS } from './task-list/useNow'
import { ToolLog } from './tool-log'
import { resultSummary } from './tool-log/toolLogModel'
import { UsageMeter } from './usage-meter'
import { usageMeterState } from './usage-meter/usageMeterModel'
import { setHomeFolder } from '../shared/homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/me')

// Every chat entry and tool log row shows its time: one `clockTime` call per render of one.
vi.mock('./chat/chatModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./chat/chatModel')>()
  return { ...original, clockTime: vi.fn(original.clockTime) }
})
// Every task row's status line works out what it says: one `rowStatus` call per render of one.
vi.mock('./task-list/rowStatus', async (importOriginal) => {
  const original = await importOriginal<typeof import('./task-list/rowStatus')>()
  return { ...original, rowStatus: vi.fn(original.rowStatus) }
})
// Every recipient row of the Broadcast modal says where its task stands: one `attentionLabel` call per render of one.
// The line above them says how many there are: one `reachText` call per render of the modal's content.
vi.mock('./broadcast/broadcastModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./broadcast/broadcastModel')>()
  return { ...original, attentionLabel: vi.fn(original.attentionLabel), reachText: vi.fn(original.reachText) }
})
// The usage meter works out what its row says: one `usageMeterState` call per render of the meter.
vi.mock('./usage-meter/usageMeterModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./usage-meter/usageMeterModel')>()
  return { ...original, usageMeterState: vi.fn(original.usageMeterState) }
})
// The Agents tab: every subagent's tab names its dot (one `agentDotLabel` call per render of one), every subagent's
// `Agent` call says how it's doing under it (one `agentCallResult` call per render of that line), and the line under
// the strip says the subagent's state (one `agentStateLine` call per render of it).
vi.mock('./agents/agentsModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agents/agentsModel')>()
  return {
    ...original,
    agentDotLabel: vi.fn(original.agentDotLabel),
    agentCallResult: vi.fn(original.agentCallResult),
    agentStateLine: vi.fn(original.agentStateLine),
  }
})

// Watchers in the Agents tab (#537): every pinned card says how often it woke the agent (one `pinnedMetaLine` call per
// render of one) and its state, which ticks by itself (one `pinnedStatus` call per render of it); every ended watcher's
// row says how it went (one `endedSummary` call per render of one); and an agent's tab with an eye names it (one
// `watchingTitle` call per render of one).
vi.mock('./agents/agentWatchersModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./agents/agentWatchersModel')>()
  return {
    ...original,
    pinnedMetaLine: vi.fn(original.pinnedMetaLine),
    pinnedStatus: vi.fn(original.pinnedStatus),
    endedSummary: vi.fn(original.endedSummary),
    watchingTitle: vi.fn(original.watchingTitle),
  }
})
// Every tool call's row says what it came to: one `resultSummary` call per render of one. (The clock's `clockTime`
// counts a pinned watcher's times too, so it can't count the rows above one.)
vi.mock('./tool-log/toolLogModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./tool-log/toolLogModel')>()
  return { ...original, resultSummary: vi.fn(original.resultSummary) }
})

// Every card of the todo hub counts its children by kind (one `kindCounts` call per render of one), and every tile
// names itself (one `tileLabel` call per render of one).
vi.mock('./todos/todoHubModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./todos/todoHubModel')>()
  return { ...original, kindCounts: vi.fn(original.kindCounts), tileLabel: vi.fn(original.tileLabel) }
})

// What a todo's text names (#500): the hub works out what the task's todos may name (one `linkReferences` call per
// time), then which of it each todo names (one `namedBy` call per todo), and a card reads its title and its status
// line for their links (one `todoSegments` call per line).
vi.mock('./todos/todoLinks', async (importOriginal) => {
  const original = await importOriginal<typeof import('./todos/todoLinks')>()
  return {
    ...original,
    linkReferences: vi.fn(original.linkReferences),
    namedBy: vi.fn(original.namedBy),
    todoSegments: vi.fn(original.todoSegments),
  }
})

const AT = new Date(2026, 8, 23, 13, 8).getTime()
/** A long history, as far as a unit test needs: enough rows that rendering them all again couldn't pass for one. */
const TURNS = 40

function message(turn: number, role: MessageRole): Message {
  return {
    id: `${role}-${String(turn)}`,
    taskId: 't1',
    role,
    body: role === MessageRole.User ? `Go ahead with part ${String(turn)}.` : `Part **${String(turn)}** is \`done\`.`,
    turn,
    createdAt: AT,
    summary: null,
    images: [],
    pastedBlocks: [],
    files: [],
    broadcast: false,
  }
}

function call(id: string, turn: number, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id,
    taskId: 't1',
    turn,
    createdAt: AT,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: { file_path: 'api/views.py' },
    output: 'class ThrottledViewSet: pass',
    state: ToolCallState.Done,
    finishedAt: AT + 1000,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

function note(id: string, turn: number, parentToolUseId: string | null = null): NarrationEvent {
  return { id, taskId: 't1', turn, createdAt: AT, kind: ToolEventKind.Narration, text: 'Checking.', parentToolUseId }
}

const MESSAGES = Array.from({ length: TURNS }, (_, index) => [
  message(index + 1, MessageRole.User),
  message(index + 1, MessageRole.Agent),
]).flat()
const TOOL_EVENTS: ToolEvent[] = Array.from({ length: TURNS }, (_, index) => [
  note(`note-${String(index + 1)}`, index + 1),
  call(`call-${String(index + 1)}`, index + 1),
]).flat()

function renders(counter: unknown): number {
  return vi.mocked(counter as () => unknown).mock.calls.length
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the chat, with a long history', () => {
  async function renderChat(permissionRequests: PermissionRequest[] = []): Promise<StoreWrapper> {
    const wrapper = storeWrapper({
      workspaces: [sampleWorkspace('w1')],
      tasks: [sampleTask('t1', 'w1')],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
      messages: [...MESSAGES],
      toolEvents: [...TOOL_EVENTS],
      permissionRequests,
    })
    render(<Chat />, { wrapper: wrapper.wrapper })
    await act(() => wrapper.store.getState().hydrate())
    await screen.findByText(`Go ahead with part ${String(TURNS)}.`)
    vi.mocked(clockTime).mockClear()
    return wrapper
  }

  it('renders none of its entries again when the task changes', async () => {
    const { fake } = await renderChat()
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Running the tests.' } })
    })
    expect(renders(clockTime)).toBe(0)
  })

  it('renders only the reply whose turn gained a tool call when the tool log grows', async () => {
    const { fake } = await renderChat()
    // A note changes no entry.
    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: note('late-note', TURNS) })
    })
    expect(renders(clockTime)).toBe(0)
    // A call adds to its turn's tool-call chip: that reply alone renders again.
    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('late-call', TURNS) })
    })
    expect(renders(clockTime)).toBe(1)
    expect(screen.getByRole('button', { name: /2 tool calls/ })).toBeDefined()
  })

  it("renders only a subagent's permission card again when the tool log grows, since the log names the subagent", async () => {
    const own = samplePermissionRequest('own', 't1')
    const subagents = { ...samplePermissionRequest('theirs', 't1'), agentId: 'agent-7' }
    const { fake } = await renderChat([own, subagents])
    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: note('late-note', TURNS) })
    })
    expect(renders(clockTime)).toBe(1)
  })
})

describe('the tool log, with a long history', () => {
  beforeEach(() => {
    vi.mocked(clockTime).mockClear()
  })

  it('renders only the row that was added or changed', () => {
    const { wrapper } = storeWrapper()
    const { rerender } = render(<ToolLog taskId="t1" events={TOOL_EVENTS} />, { wrapper })
    expect(renders(clockTime)).toBe(TOOL_EVENTS.length)

    vi.mocked(clockTime).mockClear()
    const running = call('late-call', TURNS, { state: ToolCallState.Running, output: null, finishedAt: null })
    rerender(<ToolLog taskId="t1" events={[...TOOL_EVENTS, running]} />)
    expect(renders(clockTime)).toBe(1)
    expect(document.querySelector('[data-state="running"]')).not.toBeNull()

    vi.mocked(clockTime).mockClear()
    rerender(<ToolLog taskId="t1" events={[...TOOL_EVENTS, { ...running, state: ToolCallState.Done, output: 'ok' }]} />)
    expect(renders(clockTime)).toBe(1)
    expect(document.querySelector('[data-state="running"]')).toBeNull()

    // Under another workspace root, the calls show their arguments anew; the notes have none.
    vi.mocked(clockTime).mockClear()
    rerender(<ToolLog taskId="t1" events={TOOL_EVENTS} rootPath="/Users/sample/code/api" />)
    expect(renders(clockTime)).toBe(TURNS)
  })

  it('renders only the row whose permission request opened, was answered or was withdrawn (#459)', () => {
    const { wrapper } = storeWrapper()
    /** A request about the call of a turn. */
    const about = (turn: number, patch: Partial<PermissionRequest> = {}): PermissionRequest => ({
      ...samplePermissionRequest(`p-${String(turn)}`, 't1'),
      toolUseId: `use-call-${String(turn)}`,
      ...patch,
    })
    const log = (requests: PermissionRequest[]): React.JSX.Element => (
      <ToolLog taskId="t1" events={TOOL_EVENTS} permissions={permissionLinesByToolUse(requests)} />
    )
    // Every tenth call was asked about and allowed, long ago.
    const old = Array.from({ length: TURNS / 10 }, (_, index) =>
      about((index + 1) * 10, { state: PermissionRequestState.Allowed, closedAt: AT }),
    )
    const { rerender } = render(log(old), { wrapper })
    expect(document.querySelectorAll('[data-permission]')).toHaveLength(old.length)

    // A request opens for another call: its row alone.
    vi.mocked(clockTime).mockClear()
    rerender(log([...old, about(7)]))
    expect(renders(clockTime)).toBe(1)
    expect(document.querySelectorAll('[data-permission="waiting"]')).toHaveLength(1)

    // The same requests, in a list made anew, as every other event to the task brings: none.
    vi.mocked(clockTime).mockClear()
    rerender(log([...old.map((request) => ({ ...request })), about(7)]))
    expect(renders(clockTime)).toBe(0)

    // It's denied with a note: its row alone.
    vi.mocked(clockTime).mockClear()
    const denied = about(7, { state: PermissionRequestState.Denied, denyNote: 'Not yet', closedAt: AT })
    rerender(log([...old, denied]))
    expect(renders(clockTime)).toBe(1)
    expect(document.querySelector('[data-permission="denied"]')).toHaveTextContent('Denied: “Not yet”')

    // Two more open at once, and one of them is withdrawn: two rows, then one.
    vi.mocked(clockTime).mockClear()
    rerender(log([...old, denied, about(8), about(9)]))
    expect(renders(clockTime)).toBe(2)
    vi.mocked(clockTime).mockClear()
    rerender(log([...old, denied, about(8), about(9, { state: PermissionRequestState.Withdrawn, closedAt: AT })]))
    expect(renders(clockTime)).toBe(1)

    // A request about a call that isn't in the log changes no row.
    vi.mocked(clockTime).mockClear()
    rerender(
      log([
        ...old,
        denied,
        about(8),
        about(9, { state: PermissionRequestState.Withdrawn, closedAt: AT }),
        about(TURNS + 1),
      ]),
    )
    expect(renders(clockTime)).toBe(0)
  })
})

describe('the task list, with many tasks', () => {
  const TASKS = 60
  const tasks = Array.from({ length: TASKS }, (_, index) => ({
    ...sampleTask(`t${String(index)}`, 'w1', `Task ${String(index)}`),
    sessionId: `session-${String(index)}`,
    status: `Working on part ${String(index)}`,
  }))

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(AT)
  })

  it('renders only the status line of the row whose task starts or stops waiting on a permission', async () => {
    const { wrapper, store, fake } = storeWrapper({
      tasks,
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
    })
    await act(() => store.getState().hydrate())
    render(<TaskList workspaceId="w1" />, { wrapper })
    expect(renders(rowStatus)).toBe(TASKS)
    const [first] = tasks
    if (first === undefined) throw new Error('No task')

    // One task's agent asks for a folder: its row's line changes, led by the shield, and no other row's renders.
    vi.mocked(rowStatus).mockClear()
    const asking = {
      ...first,
      awaitingPermission: true,
      permissionAsk: { kind: SandboxAskKind.Folder, path: '/Users/me/code/acme-web', access: FolderAccess.Read },
    } as const
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: asking })
    })
    expect(renders(rowStatus)).toBe(1)
    expect(screen.getByText('Waiting on you: read ~/code/acme-web')).toBeInTheDocument()
    expect(screen.getAllByRole('img', { name: 'Permission' })).toHaveLength(1)

    // A change that leaves its line as it was (it's read) renders none, and nor does the clock ticking.
    vi.mocked(rowStatus).mockClear()
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...asking, unread: true } })
    })
    act(() => {
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    expect(renders(rowStatus)).toBe(0)

    // Answered: that row's line alone goes back to its status.
    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: first })
    })
    expect(renders(rowStatus)).toBe(1)
    expect(screen.queryByRole('img', { name: 'Permission' })).toBeNull()
  })

  it('renders only the usage meter under it when a new usage reading arrives, once a reading (#530)', async () => {
    const { wrapper, store, fake } = storeWrapper({
      tasks,
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
    })
    await act(() => store.getState().hydrate())
    render(
      <>
        <TaskList workspaceId="w1" />
        <UsageMeter />
      </>,
      { wrapper },
    )
    const session: UsageReading = {
      limit: { kind: UsageLimitKind.Session },
      utilization: 1,
      resetsAt: AT + 3_600_000,
      level: UsageLevel.Limited,
      readAt: AT,
    }
    /** The account running on extra usage, with `spent` cents of it spent. */
    const reading = (spent: number): UsageReading[] => [
      session,
      {
        limit: { kind: UsageLimitKind.ExtraUsage },
        utilization: null,
        resetsAt: null,
        level: UsageLevel.Within,
        readAt: AT,
        extraUsage: { available: true, spend: { spent, cap: null, currency: 'CAD', decimalPlaces: 2 } },
      },
    ]
    const meter = screen.getByRole('button', { name: 'Usage' })

    // Each turn's end reads usage again, with more spent: the meter's line follows, and no task's row renders.
    vi.mocked(rowStatus).mockClear()
    vi.mocked(usageMeterState).mockClear()
    for (const [index, spent] of [1234, 1299, 1310].entries()) {
      act(() => {
        fake.emit({ type: EventType.AccountChanged, status: { account: null, usage: reading(spent) } })
      })
      expect(meter).toHaveTextContent(`Extra usageCA$${(spent / 100).toFixed(2)}spent`)
      expect(renders(usageMeterState)).toBe(index + 1)
    }
    expect(renders(rowStatus)).toBe(0)
  })
})

describe('the Broadcast modal, with 60 active tasks in 8 workspaces', () => {
  const WORKSPACES = Array.from({ length: 8 }, (_, index) =>
    sampleWorkspace(`w${String(index + 1)}`, `Workspace ${String(index + 1)}`),
  )
  const TASKS = Array.from({ length: 60 }, (_, index) => ({
    ...sampleTask(`b${String(index + 1)}`, `w${String((index % 8) + 1)}`, `Task ${String(index + 1)}`),
    updatedAt: 10_000 - index,
    // Each has run: a broadcast doesn't reach a task that has never been given anything.
    sessionId: `session-${String(index + 1)}`,
  }))

  async function renderModal(): Promise<StoreWrapper> {
    const wrapper = storeWrapper({ workspaces: WORKSPACES, tasks: TASKS.map((task) => ({ ...task })), messages: [] })
    render(<BroadcastDialog />, { wrapper: wrapper.wrapper })
    await act(() => wrapper.store.getState().hydrate())
    act(() => {
      wrapper.store.getState().openBroadcast()
    })
    await settleFloating()
    // Every recipient's row rendered once to open it, and the line that counts them once.
    expect(renders(attentionLabel)).toBe(60)
    expect(screen.getByText(/Goes to/)).toHaveTextContent('Goes to 60 active tasks in 8 workspaces.')
    vi.mocked(attentionLabel).mockClear()
    vi.mocked(reachText).mockClear()
    return wrapper
  }

  beforeEach(() => {
    vi.mocked(attentionLabel).mockClear()
    vi.mocked(reachText).mockClear()
  })

  it('renders nothing as you type: not a row, not the line that counts them', async () => {
    await renderModal()
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Broadcast message' })

    for (const text of ['I', 'Is', 'Is anyone restarting Docker?']) {
      act(() => {
        fireEvent.change(field, { target: { value: text } })
        fireEvent.input(field, { target: { value: text } })
      })
    }

    expect(field).toHaveValue('Is anyone restarting Docker?')
    expect(renders(attentionLabel)).toBe(0)
    expect(renders(reachText)).toBe(0)
  })

  it('renders only the row of the task that changed', async () => {
    const { fake } = await renderModal()
    const [first] = TASKS

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...first, activity: TaskActivity.Working } as Task })
    })

    expect(renders(attentionLabel)).toBe(1)
    expect(renders(reachText)).toBe(0)
    expect(screen.getAllByText('working')).toHaveLength(1)
  })

  it('renders no row when a task changes in a way its row doesn’t show, or its logs grow', async () => {
    const { fake } = await renderModal()
    const [first] = TASKS

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...first, status: 'Running the tests.' } as Task })
      fake.emit({ type: EventType.MessageAppended, message: message(1, MessageRole.User) })
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: note('late-note', 1) })
    })

    expect(renders(attentionLabel)).toBe(0)
    expect(renders(reachText)).toBe(0)
  })

  it('renders only the rows a batch from main changed, once each', async () => {
    const { fake } = await renderModal()

    // A broadcast started a turn in ten of them: one batch, with each one's message and its change to working.
    act(() => {
      fake.emitBatch(
        TASKS.slice(0, 10).flatMap((task) => [
          { type: EventType.MessageAppended, message: { ...message(1, MessageRole.User), taskId: task.id } },
          { type: EventType.TaskUpdated, task: { ...task, activity: TaskActivity.Working } },
        ]),
      )
    })

    expect(renders(attentionLabel)).toBe(10)
    expect(renders(reachText)).toBe(0)
  })

  it('renders the line that counts them, and no other row, when a task is marked done', async () => {
    const { fake } = await renderModal()
    const last = TASKS.at(-1)

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...last, state: TaskState.Done, doneAt: 20_000 } as Task })
    })

    expect(screen.getByText(/Goes to/)).toHaveTextContent('Goes to 59 active tasks in 8 workspaces.')
    expect(renders(reachText)).toBe(1)
    expect(renders(attentionLabel)).toBe(0)
  })
})

describe('the todo hub, with 100 todos and 50 children under one (P16, #497)', () => {
  const TODOS = Array.from({ length: 100 }, (_, index) => hubTodo(String(index + 1), `Step ${String(index + 1)}`))
  /**
   * Working on the first todo: 20 subagents (the first of them running). They and the task's 10 watchers are what's
   * going on, which no todo shows (#535); under the todo are the 10 files and 40 commits it produced.
   */
  const AGENTS = Array.from({ length: 20 }, (_, index) =>
    hubAgent(
      `agent-${String(index)}`,
      `kitten-${String(index)}`,
      index,
      index === 0 ? {} : { state: ToolCallState.Done, output: 'Done.', finishedAt: HUB_NOW - index * 60_000 },
    ),
  )
  const WATCHERS = Array.from({ length: 10 }, (_, index) => hubWatcher(`watch-${String(index)}`, 30 + index))
  const FILES = Array.from({ length: 10 }, (_, index) =>
    hubFile(`docs/part-${String(index)}.md`, `Part ${String(index)}`, 50 + index),
  )
  /** The first 20 each made by one of the subagents, and under the todo because it works on it; the rest filed there. */
  const COMMITS = Array.from({ length: 40 }, (_, index) =>
    hubCommit(
      `${String(index).padStart(2, '0')}${'c0ffee'.repeat(7)}`.slice(0, 40),
      `Commit ${String(index)}`,
      70 + index,
      index < AGENTS.length ? { subagentToolUseId: `agent-${String(index)}` } : {},
    ),
  )
  /** A child of the second todo, which stays closed. */
  const ELSEWHERE = hubCommit('e'.repeat(40), 'Elsewhere', 5)
  /** The tool log around them: the main agent's own notes and calls, which are no child of any todo. */
  const LOG: ToolEvent[] = [...TOOL_EVENTS, ...AGENTS]

  async function renderHub(): Promise<HubStore> {
    const wrapper = await hubStore({
      todos: TODOS,
      toolEvents: LOG,
      watchers: WATCHERS,
      artifacts: FILES,
      commits: [...COMMITS, ELSEWHERE],
      filings: [
        ...AGENTS.map(({ toolUseId }) => hubFiling(refOf.subagent(toolUseId), '1')),
        ...FILES.map(({ path }) => hubFiling(refOf.file(path), '1')),
        ...COMMITS.slice(AGENTS.length).map((commit) => hubFiling(refOf.commit(commit), '1')),
        hubFiling(refOf.commit(ELSEWHERE), '2'),
      ],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })
    render(<HubForTask />, { wrapper: wrapper.wrapper })
    await act(() => wrapper.store.getState().loadTodoHub('t1'))
    // Every todo is a card, and the open one's 50 children are tiles; the closed ones built no list. No subagent or
    // watcher is a tile, and nothing no todo has makes a group.
    expect(document.querySelectorAll('[data-todo-head]')).toHaveLength(100)
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(50)
    expect(document.querySelectorAll('[role="group"][data-kind="commit"]')).toHaveLength(40)
    vi.mocked(kindCounts).mockClear()
    vi.mocked(tileLabel).mockClear()
    return wrapper
  }

  /** How many cards and tiles rendered since the last look, which starts the count again. */
  function rendered(): { cards: number; tiles: number } {
    const counts = { cards: renders(kindCounts), tiles: renders(tileLabel) }
    vi.mocked(kindCounts).mockClear()
    vi.mocked(tileLabel).mockClear()
    return counts
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(HUB_NOW)
    vi.mocked(kindCounts).mockClear()
    vi.mocked(tileLabel).mockClear()
  })

  it('renders nothing for what’s going on: a subagent’s every step, a watcher’s every line, one starting or ending (#535)', async () => {
    const { fake } = await renderHub()
    const [running] = AGENTS
    if (running === undefined) throw new Error('No subagent')

    // The running subagent says what it's doing now, then makes a call of its own.
    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...running, progressSummary: 'Reading the diff' } })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })
    const later = HUB_NOW + 5_000
    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: call('did-more', 1, { parentToolUseId: running.toolUseId, createdAt: later, finishedAt: later }),
      })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })

    // It finishes: nothing under its todo was live, so nothing there changes.
    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...running, state: ToolCallState.Done, output: 'Done.', finishedAt: later },
      })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })

    // One watcher reports a line and another ends. Main sends every watcher again, each made anew.
    const [first, second, ...others] = WATCHERS
    act(() => {
      fake.emit({
        type: EventType.WatchersChanged,
        taskId: 't1',
        watchers: [
          { ...first, lastOutput: 'lint pass 38s' } as never,
          { ...second, state: WatcherState.Finished, endedAt: HUB_NOW } as never,
          ...others.map((each) => ({ ...each })),
        ],
      })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })

    // Another subagent starts, for a closed todo, and Glade records which: still nothing, until it commits.
    act(() => {
      fake.emitBatch([
        { type: EventType.ToolEventAppended, toolEvent: hubAgent('agent-new', 'kitten-new', 0) },
        {
          type: EventType.FilingsChanged,
          taskId: 't1',
          filed: [hubFiling(refOf.subagent('agent-new'), '3')],
          removed: [],
        },
      ])
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(50)
    expect(document.querySelectorAll('[data-live]')).toHaveLength(0)
  })

  it('renders only the tile of the child that was updated: no other tile, and no card', async () => {
    const { fake } = await renderHub()

    // One file is renamed. Main sends every artifact again.
    const [file, ...files] = FILES
    act(() => {
      fake.emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: [{ ...file, title: 'Part one' } as never, ...files.map((each) => ({ ...each }))],
      })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })
  })

  it('renders only the commit’s tile that opens to its files, and none when another commit is made or time passes (#499)', async () => {
    const { fake } = await renderHub()

    fireEvent.click(screen.getByRole('group', { name: 'Change: Commit 0' }))
    await act(() => Promise.resolve())
    // Opened, then its files read (here: that they can't be).
    expect(rendered()).toEqual({ cards: 0, tiles: 2 })
    expect(screen.getByRole('status')).toHaveTextContent(/^Its files can’t be read/)

    // A new commit is filed under a closed todo, and main sends every commit again: no tile, and that todo's card.
    const made = hubCommit('f'.repeat(40), 'Another', 0)
    act(() => {
      fake.emitBatch([
        { type: EventType.CommitsChanged, taskId: 't1', commits: [made, ...COMMITS.map((each) => ({ ...each }))] },
        { type: EventType.FilingsChanged, taskId: 't1', filed: [hubFiling(refOf.commit(made), '2')], removed: [] },
      ])
    })
    expect(rendered()).toEqual({ cards: 1, tiles: 0 })

    // An hour passes: the open tile's age moves on by itself, and no tile renders, the open one included.
    expect(screen.getByRole('group', { name: 'Change: Commit 0' })).toHaveTextContent('+12 −3 · 1h')
    act(() => {
      vi.setSystemTime(HUB_NOW + 60 * 60_000)
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })
    expect(screen.getByRole('group', { name: 'Change: Commit 0' })).toHaveTextContent('+12 −3 · 2h')
  })

  it('renders nothing when the task changes in a way no child shows: its log grows, its lists arrive anew, the clock ticks', async () => {
    const { fake } = await renderHub()

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: note('late-note', TURNS) })
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('late-call', TURNS) })
      fake.emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Running the tests.' } })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })

    // The same watchers, artifacts and commits, each list and each of them made anew, as every event from main is.
    act(() => {
      fake.emitBatch([
        { type: EventType.WatchersChanged, taskId: 't1', watchers: WATCHERS.map((each) => ({ ...each })) },
        { type: EventType.ArtifactsChanged, taskId: 't1', artifacts: FILES.map((each) => ({ ...each })) },
        {
          type: EventType.CommitsChanged,
          taskId: 't1',
          commits: [...COMMITS, ELSEWHERE].map((each) => ({ ...each })),
        },
        {
          type: EventType.TodosChanged,
          taskId: 't1',
          todos: { items: TODOS.map((each) => ({ ...each })), updatedAt: HUB_NOW },
        },
      ])
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })

    // A minute passes: every age that moved on moved by itself.
    act(() => {
      vi.setSystemTime(HUB_NOW + 60_000)
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 0 })
    expect(screen.getAllByText('51m').length).toBeGreaterThan(0)
  })

  it('renders only the card of the todo that changed, and none of its tiles', async () => {
    const { fake } = await renderHub()

    // The open todo's status line changes.
    const [first, ...rest] = TODOS
    act(() => {
      fake.emit({
        type: EventType.TodosChanged,
        taskId: 't1',
        todos: { items: [{ ...first, note: 'Reviewing' } as never, ...rest], updatedAt: HUB_NOW },
      })
    })
    expect(rendered()).toEqual({ cards: 1, tiles: 0 })

    // A closed todo gets a second commit: its count changes, and its card alone renders.
    const made = hubCommit('f'.repeat(40), 'Elsewhere again', 0)
    act(() => {
      fake.emitBatch([
        { type: EventType.CommitsChanged, taskId: 't1', commits: [made, ...COMMITS, ELSEWHERE] },
        { type: EventType.FilingsChanged, taskId: 't1', filed: [hubFiling(refOf.commit(made), '2')], removed: [] },
      ])
    })
    expect(rendered()).toEqual({ cards: 1, tiles: 0 })

    // A child is moved from one closed todo to another, neither of which builds a list for it.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.commit(ELSEWHERE), '3')],
        removed: [],
      })
    })
    expect(rendered()).toEqual({ cards: 2, tiles: 0 })

    // The subagent that made one of the open todo's commits is given another todo: the commit goes with it, so both
    // cards render, and no tile that stays.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.subagent('agent-5'), '4', HUB_NOW + 1)],
        removed: [],
      })
    })
    expect(rendered()).toEqual({ cards: 2, tiles: 0 })
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(49)
  })

  it('renders one card when a todo is opened or filtered, with the tiles it then shows, and when a child moves in', async () => {
    const { fake } = await renderHub()

    // Another todo is opened: its card, and its one tile.
    fireEvent.click(document.querySelectorAll('[data-todo-head]')[1] as HTMLElement)
    expect(rendered()).toEqual({ cards: 1, tiles: 1 })

    // The big one is filtered to its files: its card, and no tile again (the ten it keeps are the tiles they were).
    fireEvent.click(screen.getByRole('button', { name: '10 files' }))
    expect(rendered()).toEqual({ cards: 1, tiles: 0 })
    expect(document.querySelectorAll('[role="group"][data-kind="file"]')).toHaveLength(10)

    // A file moves from the big todo to the second: two cards, and its tile where it now is.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.file('docs/part-0.md'), '2', HUB_NOW + 1)],
        removed: [],
      })
    })
    expect(rendered()).toEqual({ cards: 2, tiles: 1 })
  })

  it('renders only the tiles whose outline changed as the Files tab shows another file, and none for a tile’s menu (#498)', async () => {
    const { fake } = await renderHub()
    const paths = FILES.map(({ path }) => path)

    // The Files tab shows one of the todo's files: its tile alone takes the outline.
    act(() => {
      fake.emit({ type: EventType.OpenFilesChanged, openFiles: { taskId: 't1', paths, activePath: paths[0] ?? null } })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })
    expect(document.querySelectorAll('[role="group"][aria-current]')).toHaveLength(1)

    // Then another: the tile that lost the outline, and the one that took it.
    act(() => {
      fake.emit({ type: EventType.OpenFilesChanged, openFiles: { taskId: 't1', paths, activePath: paths[1] ?? null } })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 2 })

    // A file that's no child of the todo: only the tile that lost the outline.
    act(() => {
      fake.emit({ type: EventType.OpenFilesChanged, openFiles: { taskId: 't1', paths, activePath: 'README.md' } })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })

    // A tile's context menu opens, and closes: the list keeps the one menu, and only the tile it's for renders, to
    // keep its buttons showing while the menu is open, and to let them go again.
    fireEvent.contextMenu(screen.getByRole('group', { name: 'File: Part 3' }))
    await act(() => Promise.resolve())
    const menu = screen.getByRole('menu', { name: 'Artifact actions' })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })
    fireEvent.keyDown(menu, { key: 'Escape' })
    await act(() => Promise.resolve())
    expect(screen.queryByRole('menu')).toBeNull()
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })
  })

  describe('the links a todo’s text names (#500)', () => {
    const PR_511 = hubLink('https://github.com/acme/api/pull/511', 'Return Retry-After on 429s', 1)
    /** The todos, with the third's status line naming PR #511. */
    const NAMING = TODOS.map((todo, index) => (index === 2 ? { ...todo, note: 'Watching CI on PR #511' } : todo))

    /**
     * How often the hub worked out what the task's todos may name (`lookups`) and which of it a todo names (`todos`),
     * and how many titles and status lines were read for their links (`lines`), since the last look.
     */
    function read(): { lookups: number; todos: number; lines: number } {
      const counts = { lookups: renders(linkReferences), todos: renders(namedBy), lines: renders(todoSegments) }
      vi.mocked(linkReferences).mockClear()
      vi.mocked(namedBy).mockClear()
      vi.mocked(todoSegments).mockClear()
      return counts
    }

    /** The hub, with the third todo naming a PR the task doesn't have as a link yet. */
    async function renderNaming(): Promise<HubStore> {
      const wrapper = await renderHub()
      // As it first showed: what the task may name worked out once, and each todo's title read once.
      expect(read()).toEqual({ lookups: 1, todos: 0, lines: 100 })
      act(() => {
        wrapper.fake.emit({ type: EventType.TodosChanged, taskId: 't1', todos: { items: NAMING, updatedAt: HUB_NOW } })
      })
      // Its card alone, and its new status line alone: a task with nothing to name reads no todo for what it names.
      expect(rendered()).toEqual({ cards: 1, tiles: 0 })
      expect(read()).toEqual({ lookups: 0, todos: 0, lines: 1 })
      expect(screen.queryByRole('link', { name: 'PR #511' })).toBeNull()
      return wrapper
    }

    it('renders only the card that names a link when it’s added, and when it’s removed', async () => {
      const { fake } = await renderNaming()

      // The task gets the PR, filed under the second todo: that card for its new child, and the third for its link.
      act(() => {
        fake.emitBatch([
          { type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [...FILES, PR_511] },
          {
            type: EventType.FilingsChanged,
            taskId: 't1',
            filed: [hubFiling(refOf.link(PR_511.url), '2')],
            removed: [],
          },
        ])
      })
      expect(rendered()).toEqual({ cards: 2, tiles: 0 })
      // What the task may name once, each todo once, and the two lines of the one card that names it.
      expect(read()).toEqual({ lookups: 1, todos: 100, lines: 2 })
      expect(screen.getByRole('link', { name: 'PR #511' })).toHaveAttribute('href', PR_511.url)

      // And loses it: the same two cards.
      act(() => {
        fake.emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: FILES })
      })
      expect(rendered()).toEqual({ cards: 2, tiles: 0 })
      expect(read()).toEqual({ lookups: 1, todos: 0, lines: 2 })
      expect(screen.queryByRole('link', { name: 'PR #511' })).toBeNull()
    })

    it('reads nothing again when the task changes in a way that leaves its links and its todos as they were', async () => {
      const { fake } = await renderNaming()
      act(() => {
        fake.emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [...FILES, PR_511] })
      })
      // (Filed under no todo, the PR is the placeholder group's first child: its card, and the third's.)
      expect(rendered()).toEqual({ cards: 2, tiles: 0 })
      expect(read()).toEqual({ lookups: 1, todos: 100, lines: 2 })

      // The log grows, a subagent and a watcher report, the task's status changes, and a minute passes.
      const [running] = AGENTS
      if (running === undefined) throw new Error('No subagent')
      act(() => {
        fake.emit({ type: EventType.ToolEventAppended, toolEvent: note('late-note', TURNS) })
        fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...running, progressSummary: 'Reading the diff' } })
        fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: WATCHERS.map((each) => ({ ...each })) })
        fake.emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Running the tests.' } })
        vi.setSystemTime(HUB_NOW + 60_000)
        vi.advanceTimersByTime(NOW_REFRESH_MS)
      })
      expect(rendered()).toEqual({ cards: 0, tiles: 0 })
      expect(read()).toEqual({ lookups: 0, todos: 0, lines: 0 })

      // A file is renamed, so main sends every artifact again, each made anew: the links are the ones they were.
      const [file, ...files] = FILES
      act(() => {
        fake.emit({
          type: EventType.ArtifactsChanged,
          taskId: 't1',
          artifacts: [{ ...file, title: 'Part one' } as never, ...files.map((each) => ({ ...each })), { ...PR_511 }],
        })
      })
      expect(rendered()).toEqual({ cards: 0, tiles: 1 })
      expect(read()).toEqual({ lookups: 0, todos: 0, lines: 0 })

      // A todo is opened, and one is filtered: neither reads its text again.
      fireEvent.click(document.querySelectorAll('[data-todo-head]')[1] as HTMLElement)
      fireEvent.click(screen.getByRole('button', { name: '10 files' }))
      expect(rendered()).toEqual({ cards: 2, tiles: 1 })
      expect(read()).toEqual({ lookups: 0, todos: 0, lines: 0 })

      // The todo list arrives again, every item made anew and none changed: each is read for what it names, by the
      // hub, and no card renders.
      act(() => {
        fake.emit({
          type: EventType.TodosChanged,
          taskId: 't1',
          todos: { items: NAMING.map((each) => ({ ...each })), updatedAt: HUB_NOW },
        })
      })
      expect(rendered()).toEqual({ cards: 0, tiles: 0 })
      expect(read()).toEqual({ lookups: 0, todos: 100, lines: 0 })
      expect(screen.getByRole('link', { name: 'PR #511' })).toBeInTheDocument()
    })
  })
})

describe('the Agents tab, with 50 subagents and a 2,000-call list (P16, #536)', () => {
  const SUBAGENTS = 50
  const RUNNING = 10
  const MAIN_CALLS = 2000

  /** Fifty subagents, the last ten still running, each with a note and a call of its own. */
  const AGENTS = Array.from({ length: SUBAGENTS }, (_, index) =>
    hubAgent(
      `agent-${String(index)}`,
      `review-${String(index)}`,
      60 - index,
      index < SUBAGENTS - RUNNING ? { state: ToolCallState.Done, output: 'Looks good.', finishedAt: HUB_NOW } : {},
    ),
  )
  const EVENTS: ToolEvent[] = [
    ...Array.from({ length: MAIN_CALLS }, (_, index) => call(`main-${String(index)}`, 1)),
    ...AGENTS.flatMap((agent) => [
      agent,
      note(`said-${agent.toolUseId}`, 1, agent.toolUseId),
      call(`did-${agent.toolUseId}`, 1, { parentToolUseId: agent.toolUseId }),
    ]),
  ]
  const agent = (index: number): ToolCallEvent => {
    const found = AGENTS[index]
    if (found === undefined) throw new Error('No such subagent')
    return found
  }
  const tab = (name: string): HTMLElement => screen.getByRole('tab', { name: new RegExp(`${name}$`) })

  async function renderAgents(): Promise<HubStore> {
    const wrapper = await hubStore({
      todos: [hubTodo('1', 'Review every PR')],
      toolEvents: EVENTS,
      filings: AGENTS.map(({ toolUseId }) => hubFiling(refOf.subagent(toolUseId), '1')),
    })
    render(<AgentsTab taskId="t1" />, { wrapper: wrapper.wrapper })
    await act(() => Promise.resolve())
    // A tab per agent, and Main's list alone: its own calls, and one row per subagent it started.
    expect(screen.getAllByRole('tab')).toHaveLength(SUBAGENTS + 1)
    expect(rendered()).toEqual({ tabs: SUBAGENTS, rows: MAIN_CALLS + SUBAGENTS, times: SUBAGENTS, line: 0 })
    return wrapper
  }

  /** How many tabs, rows, live times and lines rendered since the last look, which starts the count again. */
  function rendered(): { tabs: number; rows: number; times: number; line: number } {
    const counts = {
      tabs: renders(agentDotLabel),
      rows: renders(clockTime),
      times: renders(agentCallResult),
      line: renders(agentStateLine),
    }
    for (const counter of [agentDotLabel, clockTime, agentCallResult, agentStateLine]) vi.mocked(counter).mockClear()
    return counts
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(HUB_NOW)
    for (const counter of [agentDotLabel, clockTime, agentCallResult, agentStateLine]) vi.mocked(counter).mockClear()
  })

  it('renders nothing when an agent you aren’t looking at works: not a tab, not a row of the list showing', async () => {
    const { fake } = await renderAgents()

    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: call('late-3', 1, { parentToolUseId: agent(3).toolUseId }),
      })
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: note('late-note-49', 1, agent(49).toolUseId) })
      fake.emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Running the tests.' } })
    })
    expect(rendered()).toEqual({ tabs: 0, rows: 0, times: 0, line: 0 })

    // On a subagent's tab, what Main and the others do renders nothing either.
    fireEvent.click(tab('review-49'))
    rendered()
    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('late-main', 1) })
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...agent(48), progressSummary: 'Reading the diff' },
      })
    })
    expect(rendered()).toEqual({ tabs: 0, rows: 0, times: 0, line: 0 })
  })

  it('renders only the row that was added or changed in the list showing', async () => {
    const { fake } = await renderAgents()
    const running = call('late-main', 1, { state: ToolCallState.Running, output: null, finishedAt: null })

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: running })
    })
    expect(rendered()).toEqual({ tabs: 0, rows: 1, times: 0, line: 0 })

    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...running, state: ToolCallState.Done, output: 'ok' },
      })
    })
    expect(rendered()).toEqual({ tabs: 0, rows: 1, times: 0, line: 0 })
  })

  it('renders only its Agent call’s row when a running subagent says what it’s doing now (#537)', async () => {
    const { fake } = await renderAgents()

    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...agent(48), progressSummary: 'Reading the diff' },
      })
    })
    expect(rendered()).toEqual({ tabs: 0, rows: 1, times: 1, line: 0 })
    expect(screen.getByText('Reading the diff')).toBeInTheDocument()
  })

  it('renders the two tabs that changed when another agent is picked, and the new list: not the strip', async () => {
    await renderAgents()

    fireEvent.click(tab('review-49'))
    // Main's tab has no dot to count: the subagent's is the one counted. Its list is its note and its call.
    expect(rendered()).toEqual({ tabs: 1, rows: 2, times: 0, line: 1 })

    fireEvent.click(tab('review-7'))
    expect(rendered()).toEqual({ tabs: 2, rows: 2, times: 0, line: 1 })
    expect(screen.getAllByRole('tab')).toHaveLength(SUBAGENTS + 1)
  })

  it('renders one tab when a subagent finishes, is woken or starts, as it moves, and no row of another’s list', async () => {
    const { fake } = await renderAgents()
    fireEvent.click(tab('review-48'))
    rendered()

    act(() => {
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: { ...agent(49), state: ToolCallState.Done, output: 'Looks good.', finishedAt: HUB_NOW },
      })
    })
    expect(rendered()).toEqual({ tabs: 1, rows: 0, times: 0, line: 0 })
    expect(tab('review-49')).not.toHaveAttribute('data-running')

    // Woken after it finished (#395).
    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...agent(0), state: ToolCallState.Running } })
    })
    expect(rendered()).toEqual({ tabs: 1, rows: 0, times: 0, line: 0 })

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: hubAgent('agent-new', 'review-new', 0) })
    })
    expect(rendered()).toEqual({ tabs: 1, rows: 0, times: 0, line: 0 })
    expect(screen.getAllByRole('tab')).toHaveLength(SUBAGENTS + 2)
  })

  it('renders only the times as the clock ticks: no tab, and no row', async () => {
    await renderAgents()

    act(() => {
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    // Each running subagent's call counts its own time, in Main's list.
    expect(rendered()).toEqual({ tabs: 0, rows: 0, times: RUNNING, line: 0 })

    // On a running subagent's tab, the line under the strip is the one thing that ticks.
    fireEvent.click(tab('review-49'))
    rendered()
    act(() => {
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    expect(rendered()).toEqual({ tabs: 0, rows: 0, times: 0, line: 1 })
  })
})

describe('watchers in the Agents tab, five pinned under a 2,000-call list (P16, #537)', () => {
  const MAIN_CALLS = 2000
  const ENDED = 20
  const MINUTE = 60_000

  const FINISHED = hubAgent('agent-done', 'review-done', 50, {
    state: ToolCallState.Done,
    output: 'Looks good.',
    finishedAt: HUB_NOW,
  })
  const RUNNING = hubAgent('agent-running', 'review-running', 40)

  function watcher(id: string, minutes: number, fields: Partial<Watcher> = {}): Watcher {
    return sampleWatcher(id, 't1', {
      toolUseId: `use-start-${id}`,
      label: `Watch ${id}`,
      startedAt: HUB_NOW - minutes * MINUTE,
      ...fields,
    })
  }

  /** What Main has pinned: three watches whose process runs, a wakeup and a cron job. */
  const PINNED: Watcher[] = [
    watcher('ci', 30, { lastOutput: 'lint pass' }),
    watcher('tests', 28, { kind: WatcherKind.Command, recurring: false }),
    watcher('deploy', 26),
    watcher('preview', 10, {
      kind: WatcherKind.Wakeup,
      state: WatcherState.Scheduled,
      recurring: false,
      nextDueAt: HUB_NOW + 20 * MINUTE,
    }),
    watcher('queue', 90, { kind: WatcherKind.Cron, state: WatcherState.Scheduled, nextDueAt: HUB_NOW + 30 * MINUTE }),
  ]
  /** Twenty that ended, through Main's history. */
  const OLD: Watcher[] = Array.from({ length: ENDED }, (_, index) =>
    watcher(`old-${String(index)}`, 300 - index, {
      state: WatcherState.Finished,
      outcome: 'It ended.',
      endedAt: HUB_NOW - (290 - index) * MINUTE,
    }),
  )
  /** One a running subagent started. */
  const THEIRS = watcher('theirs', 12, { parentToolUseId: RUNNING.toolUseId })
  const WATCHERS = [...OLD, ...PINNED, THEIRS]

  const EVENTS: ToolEvent[] = [
    ...Array.from({ length: MAIN_CALLS }, (_, index) => call(`main-${String(index)}`, 1)),
    // The calls that started Main's watchers: none is a row.
    ...[...OLD, ...PINNED].map(({ id }) => call(`start-${id}`, 1, { name: 'Monitor' })),
    FINISHED,
    RUNNING,
    call('theirs-read', 1, { parentToolUseId: RUNNING.toolUseId }),
    call(`start-${THEIRS.id}`, 1, { name: 'Monitor', parentToolUseId: RUNNING.toolUseId }),
  ]

  const COUNTERS = [resultSummary, endedSummary, pinnedMetaLine, pinnedStatus, watchingTitle, agentDotLabel]

  interface Rendered {
    /** Tool calls' rows. */
    readonly calls: number
    /** Ended watchers' rows. */
    readonly ended: number
    /** Pinned cards. */
    readonly cards: number
    /** Pinned cards' states, which tick. */
    readonly states: number
    /** Tabs with an eye. */
    readonly eyes: number
    /** Subagents' tabs. */
    readonly tabs: number
  }

  const NOTHING: Rendered = { calls: 0, ended: 0, cards: 0, states: 0, eyes: 0, tabs: 0 }

  /** What rendered since the last look, which starts the count again. */
  function rendered(): Rendered {
    const counts = {
      calls: renders(resultSummary),
      ended: renders(endedSummary),
      cards: renders(pinnedMetaLine),
      states: renders(pinnedStatus),
      eyes: renders(watchingTitle),
      tabs: renders(agentDotLabel),
    }
    for (const counter of COUNTERS) vi.mocked(counter).mockClear()
    return counts
  }

  async function renderAgents(): Promise<HubStore> {
    const wrapper = await hubStore({ toolEvents: EVENTS, watchers: WATCHERS })
    render(<AgentsTab taskId="t1" />, { wrapper: wrapper.wrapper })
    await act(() => Promise.resolve())
    expect(screen.getByRole('group', { name: 'Watching' }).querySelectorAll('[data-kind]')).toHaveLength(PINNED.length)
    expect(rendered()).toEqual({
      calls: MAIN_CALLS,
      ended: ENDED,
      cards: PINNED.length,
      states: PINNED.length,
      // Main's, and the running subagent's.
      eyes: 2,
      tabs: 2,
    })
    return wrapper
  }

  /** Main sends the task's watchers anew, each made again, as it does with every change to one of them. */
  function send(fake: HubStore['fake'], change: (watcher: Watcher) => Watcher = (watcher) => watcher): void {
    act(() => {
      fake.emit({
        type: EventType.WatchersChanged,
        taskId: 't1',
        watchers: WATCHERS.map((each) => ({ ...change(each) })),
      })
    })
  }

  const only = (id: string, fields: Partial<Watcher>) => (each: Watcher) =>
    each.id === id ? { ...each, ...fields } : each

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(HUB_NOW)
    for (const counter of COUNTERS) vi.mocked(counter).mockClear()
  })

  it('renders only the card of the watcher that reported a line or woke the agent: no row above it, and no tab', async () => {
    const { fake } = await renderAgents()

    send(fake, only('ci', { lastOutput: 'unit-tests running' }))
    expect(rendered()).toEqual({ ...NOTHING, cards: 1, states: 1 })
    expect(screen.getByText('unit-tests running')).toBeInTheDocument()

    send(fake, only('ci', { lastOutput: 'unit-tests running', wakes: 1, lastWokeAt: HUB_NOW }))
    expect(rendered()).toEqual({ ...NOTHING, cards: 1, states: 1 })

    // A job fires: its count and when it's next due, on its own card.
    send(fake, (each) =>
      each.id === 'ci'
        ? { ...each, lastOutput: 'unit-tests running', wakes: 1, lastWokeAt: HUB_NOW }
        : each.id === 'queue'
          ? { ...each, wakes: 1, lastWokeAt: HUB_NOW, nextDueAt: HUB_NOW + 60 * MINUTE }
          : each,
    )
    expect(rendered()).toEqual({ ...NOTHING, cards: 1, states: 1 })
  })

  it('renders nothing when main sends the watchers again as they were', async () => {
    const { fake } = await renderAgents()

    send(fake)
    send(fake)
    expect(rendered()).toEqual(NOTHING)
  })

  it('renders only each card’s state as the clock ticks: no card, no row and no tab', async () => {
    await renderAgents()

    act(() => {
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })
    expect(rendered()).toEqual({ ...NOTHING, states: PINNED.length })
  })

  it('renders the row of a watcher that ended and its tab’s eye: not the rows around it, and not the other cards', async () => {
    const { fake } = await renderAgents()

    send(fake, only('ci', { state: WatcherState.Finished, outcome: 'It ended.', endedAt: HUB_NOW }))

    expect(rendered()).toEqual({ ...NOTHING, ended: 1, eyes: 1 })
    expect(screen.getByRole('group', { name: 'Watching' }).querySelectorAll('[data-kind]')).toHaveLength(4)
    expect(document.querySelectorAll('[data-watcher]')).toHaveLength(ENDED + 1)
  })

  it('renders the card of a watcher that started and its tab’s eye, with the row of its call gone and no other', async () => {
    const { fake } = await renderAgents()
    const started = call('start-late', 1, { name: 'Monitor', state: ToolCallState.Running, output: null })

    // Its call is a row until the SDK says it started a watcher.
    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: started })
    })
    expect(rendered()).toEqual({ ...NOTHING, calls: 1 })

    act(() => {
      fake.emit({
        type: EventType.WatchersChanged,
        taskId: 't1',
        watchers: [...WATCHERS, watcher('late', 0)].map((each) => ({ ...each })),
      })
    })
    expect(rendered()).toEqual({ ...NOTHING, cards: 1, states: 1, eyes: 1 })
    expect(screen.getByTitle('6 watching')).toBeInTheDocument()
  })

  it('renders only the tab of an agent you aren’t looking at when its watcher starts or ends, and nothing as it reports', async () => {
    const { fake } = await renderAgents()

    send(fake, only('theirs', { lastOutput: 'tick', wakes: 3, lastWokeAt: HUB_NOW }))
    expect(rendered()).toEqual(NOTHING)

    // It ends: the eye leaves its tab, and Main's list and cards are as they were.
    const ended = only('theirs', {
      state: WatcherState.Stopped,
      outcome: 'Ended with its subagent.',
      endedAt: HUB_NOW,
    })
    send(fake, ended)
    expect(rendered()).toEqual({ ...NOTHING, tabs: 1 })

    // On its tab, Main's watchers changing renders nothing but Main's eye, when what it counts changes.
    fireEvent.click(screen.getByTitle('review-running'))
    rendered()
    send(fake, (each) => only('ci', { lastOutput: 'unit-tests running', wakes: 2 })(ended(each)))
    expect(rendered()).toEqual(NOTHING)
    send(fake, (each) =>
      only('ci', { state: WatcherState.Finished, outcome: 'It ended.', endedAt: HUB_NOW })(ended(each)),
    )
    expect(rendered()).toEqual({ ...NOTHING, eyes: 1 })
  })

  it('renders nothing of the watchers when an agent works or the task changes', async () => {
    const { fake } = await renderAgents()

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: call('late-main', 1) })
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: call('late-theirs', 1, { parentToolUseId: RUNNING.toolUseId }),
      })
      fake.emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Watching the checks.' } })
    })
    expect(rendered()).toEqual({ ...NOTHING, calls: 1 })
  })
})
