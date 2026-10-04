// The regression guard for #413 (typing lag in a task with a very long history): the chat, the tool log and the
// Subagents tab render again with every change to the task, its logs or the clock, so each of their rows must render
// only when its own data changed. Rows are counted by a function each calls exactly once per render. The Broadcast
// modal's recipients (#489) are held to the same: one row per active task, in every workspace. So is the todo hub
// (P16, #497): a card per todo, and a tile per child of an open one.
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType } from '../shared/bridge'
import {
  MessageRole,
  PermissionRequestState,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherState,
  type Message,
  type NarrationEvent,
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type ToolEvent,
} from '../shared/domain'
import { FolderAccess, SandboxAskKind } from '../shared/sandbox'
import { BroadcastDialog } from './broadcast'
import { attentionLabel, reachText } from './broadcast/broadcastModel'
import { Chat } from './chat'
import { settleFloating } from './components/settleFloating'
import { clockTime } from './chat/chatModel'
import { permissionLinesByToolUse } from './permissions/permissionLines'
import { samplePermissionRequest, sampleTask, sampleWatcher, sampleWorkspace } from './store/test-bridge'
import { storeWrapper, type StoreWrapper } from './store/test-wrapper'
import { ELAPSED_REFRESH_MS, SubagentsTab } from './subagents/SubagentsTab'
import { statusLabel } from './subagents/subagentsModel'
import { TaskList } from './task-list'
import {
  HUB_NOW,
  HubForTask,
  hubAgent,
  hubCommit,
  hubFile,
  hubFiling,
  hubStore,
  hubTodo,
  hubWatcher,
  refOf,
  type HubStore,
} from './todos/test-hub'
import { kindCounts, tileLabel } from './todos/todoHubModel'
import { ChildFilter } from '../shared/todoHub'
import { rowStatus } from './task-list/rowStatus'
import { NOW_REFRESH_MS } from './task-list/useNow'
import { ToolLog } from './tool-log'
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
// Every subagent row shows its status: one `statusLabel` call per render of one.
vi.mock('./subagents/subagentsModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./subagents/subagentsModel')>()
  return { ...original, statusLabel: vi.fn(original.statusLabel) }
})

// Every card of the todo hub counts its children by kind (one `kindCounts` call per render of one), and every tile
// names itself (one `tileLabel` call per render of one).
vi.mock('./todos/todoHubModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./todos/todoHubModel')>()
  return { ...original, kindCounts: vi.fn(original.kindCounts), tileLabel: vi.fn(original.tileLabel) }
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

describe('the Subagents tab, with many subagents', () => {
  const SUBAGENTS = 30

  function agent(index: number, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
    return call(`agent-${String(index)}`, 1, {
      name: 'Agent',
      input: { description: `Review PR ${String(index)}`, prompt: '…' },
      output: 'Looks good.',
      ...overrides,
    })
  }

  /** Thirty subagents, each with a note and a call in its log: all done but the last, which runs. */
  const EVENTS: ToolEvent[] = Array.from({ length: SUBAGENTS }, (_, index) => {
    const last = index === SUBAGENTS - 1
    const subagent = agent(index, last ? { state: ToolCallState.Running, output: null, finishedAt: null } : {})
    return [
      subagent,
      note(`said-${String(index)}`, 1, subagent.toolUseId),
      call(`did-${String(index)}`, 1, { parentToolUseId: subagent.toolUseId }),
    ]
  }).flat()

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(AT + 5000)
    vi.mocked(statusLabel).mockClear()
  })

  it('renders only the running subagent as its elapsed time ticks', () => {
    const { wrapper } = storeWrapper()
    render(<SubagentsTab taskId="t1" events={EVENTS} />, { wrapper })
    expect(renders(statusLabel)).toBe(SUBAGENTS)

    vi.mocked(statusLabel).mockClear()
    act(() => {
      vi.advanceTimersByTime(ELAPSED_REFRESH_MS)
    })
    expect(renders(statusLabel)).toBe(1)
    expect(screen.getByText(/^6s · 1 tool call$/)).toBeDefined()
  })

  it('renders only the subagent whose log grew or changed', () => {
    const { wrapper } = storeWrapper()
    const { rerender } = render(<SubagentsTab taskId="t1" events={EVENTS} />, { wrapper })

    // Another call by the third subagent.
    vi.mocked(statusLabel).mockClear()
    const grown = [...EVENTS, call('did-more', 1, { parentToolUseId: 'use-agent-2' })]
    rerender(<SubagentsTab taskId="t1" events={grown} />)
    expect(renders(statusLabel)).toBe(1)

    // A note of the fifth's becomes another, and a call of the sixth's gets its result.
    vi.mocked(statusLabel).mockClear()
    const changed = grown.map((event) => {
      if (event.id === 'said-4') return { ...event }
      if (event.id === 'did-5') return { ...event, output: 'changed' }
      return event
    })
    rerender(<SubagentsTab taskId="t1" events={changed} />)
    expect(renders(statusLabel)).toBe(2)

    // A row whose kind changed in place (a note where a call was) renders too.
    vi.mocked(statusLabel).mockClear()
    const swapped = changed.map((event) => (event.id === 'did-6' ? note('did-6', 1, 'use-agent-6') : event))
    rerender(<SubagentsTab taskId="t1" events={swapped} />)
    expect(renders(statusLabel)).toBe(1)
    const back = swapped.map((event) =>
      event.id === 'said-7' ? call('said-7', 1, { parentToolUseId: 'use-agent-7' }) : event,
    )
    vi.mocked(statusLabel).mockClear()
    rerender(<SubagentsTab taskId="t1" events={back} />)
    expect(renders(statusLabel)).toBe(1)
  })

  it("renders only the subagent whose call's permission request changed (#459)", () => {
    const { wrapper } = storeWrapper()
    const request: PermissionRequest = {
      ...samplePermissionRequest('p1', 't1'),
      toolUseId: 'use-did-3',
      agentId: 'agent-3',
    }
    const tab = (requests: PermissionRequest[]): React.JSX.Element => (
      <SubagentsTab taskId="t1" events={EVENTS} permissions={permissionLinesByToolUse(requests)} />
    )
    const { rerender } = render(tab([]), { wrapper })

    // The fourth subagent's call waits on a card: that subagent alone.
    vi.mocked(statusLabel).mockClear()
    rerender(tab([request]))
    expect(renders(statusLabel)).toBe(1)

    // The same request in a new list: none. Then it's allowed: that subagent again.
    vi.mocked(statusLabel).mockClear()
    rerender(tab([{ ...request }]))
    expect(renders(statusLabel)).toBe(0)
    rerender(tab([{ ...request, state: PermissionRequestState.Allowed, closedAt: AT }]))
    expect(renders(statusLabel)).toBe(1)
  })

  it('renders a subagent with background work as the clock ticks, and as its watchers change', () => {
    const { wrapper } = storeWrapper()
    const watcher = sampleWatcher('w', 't1', { parentToolUseId: 'use-agent-0' })
    const { rerender } = render(<SubagentsTab taskId="t1" events={EVENTS} watchers={[watcher]} />, { wrapper })

    // The clock: the running subagent, and the one whose watcher's times it shows.
    vi.mocked(statusLabel).mockClear()
    act(() => {
      vi.advanceTimersByTime(ELAPSED_REFRESH_MS)
    })
    expect(renders(statusLabel)).toBe(2)

    // The same watchers in a new list: none.
    vi.mocked(statusLabel).mockClear()
    rerender(<SubagentsTab taskId="t1" events={EVENTS} watchers={[watcher]} />)
    expect(renders(statusLabel)).toBe(0)

    // Its watcher changed, then gone: that subagent each time.
    rerender(<SubagentsTab taskId="t1" events={EVENTS} watchers={[{ ...watcher, wakes: 1 }]} />)
    expect(renders(statusLabel)).toBe(1)
    rerender(<SubagentsTab taskId="t1" events={EVENTS} watchers={[]} />)
    expect(renders(statusLabel)).toBe(2)
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
  /** Under the first todo: 20 subagents (the first of them running), 10 watchers, 10 files and 10 commits. */
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
  const COMMITS = Array.from({ length: 10 }, (_, index) =>
    hubCommit(
      `${String(index).padStart(2, '0')}${'c0ffee'.repeat(7)}`.slice(0, 40),
      `Commit ${String(index)}`,
      70 + index,
    ),
  )
  /** A child of the second todo, which stays closed. */
  const ELSEWHERE = hubWatcher('watch-elsewhere', 5)
  /** The tool log around them: the main agent's own notes and calls, which are no child of any todo. */
  const LOG: ToolEvent[] = [...TOOL_EVENTS, ...AGENTS]

  async function renderHub(): Promise<HubStore> {
    const wrapper = await hubStore({
      todos: TODOS,
      toolEvents: LOG,
      watchers: [...WATCHERS, ELSEWHERE],
      artifacts: FILES,
      commits: COMMITS,
      filings: [
        ...AGENTS.map(({ toolUseId }) => hubFiling(refOf.subagent(toolUseId), '1')),
        ...WATCHERS.map(({ toolUseId }) => hubFiling(refOf.watcher(toolUseId), '1')),
        ...FILES.map(({ path }) => hubFiling(refOf.file(path), '1')),
        ...COMMITS.map((commit) => hubFiling(refOf.commit(commit), '1')),
        hubFiling(refOf.watcher('watch-elsewhere'), '2'),
      ],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })
    render(<HubForTask />, { wrapper: wrapper.wrapper })
    await act(() => wrapper.store.getState().loadTodoHub('t1'))
    // Every todo is a card, and the open one's 50 children are tiles; the closed ones built no list.
    expect(document.querySelectorAll('[data-todo-head]')).toHaveLength(100)
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(50)
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

  it('renders only the tile of the child that was updated: no other tile, and no card', async () => {
    const { fake } = await renderHub()
    const [running] = AGENTS
    if (running === undefined) throw new Error('No subagent')

    // The running subagent says what it's doing now.
    act(() => {
      fake.emit({ type: EventType.ToolEventUpdated, toolEvent: { ...running, progressSummary: 'Reading the diff' } })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })
    expect(screen.getByText('Reading the diff')).toBeInTheDocument()

    // It makes a call of its own, a moment later: its tile is dated by it.
    const later = HUB_NOW + 5_000
    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: call('did-more', 1, { parentToolUseId: running.toolUseId, createdAt: later, finishedAt: later }),
      })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })

    // One watcher reports a line. Main sends every watcher again, each made anew.
    const [first, ...others] = WATCHERS
    act(() => {
      fake.emit({
        type: EventType.WatchersChanged,
        taskId: 't1',
        watchers: [
          { ...first, lastOutput: 'lint pass 38s' } as never,
          ...others.map((each) => ({ ...each })),
          { ...ELSEWHERE },
        ],
      })
    })
    expect(rendered()).toEqual({ cards: 0, tiles: 1 })
    expect(screen.getByText('lint pass 38s')).toBeInTheDocument()

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
        {
          type: EventType.WatchersChanged,
          taskId: 't1',
          watchers: [...WATCHERS, ELSEWHERE].map((each) => ({ ...each })),
        },
        { type: EventType.ArtifactsChanged, taskId: 't1', artifacts: FILES.map((each) => ({ ...each })) },
        { type: EventType.CommitsChanged, taskId: 't1', commits: COMMITS.map((each) => ({ ...each })) },
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
    expect(screen.getAllByText('1m').length).toBeGreaterThan(0)
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

    // A closed todo's watcher ends: its eye goes grey, and its card alone renders.
    act(() => {
      fake.emit({
        type: EventType.WatchersChanged,
        taskId: 't1',
        watchers: [...WATCHERS, { ...ELSEWHERE, state: WatcherState.Finished, endedAt: HUB_NOW }],
      })
    })
    expect(rendered()).toEqual({ cards: 1, tiles: 0 })

    // A child is filed under a closed todo, which builds no list for it.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.watcher('watch-elsewhere'), '3')],
        removed: [],
      })
    })
    expect(rendered()).toEqual({ cards: 2, tiles: 0 })
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
})
