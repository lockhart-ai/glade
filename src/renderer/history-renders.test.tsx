// The regression guard for #413 (typing lag in a task with a very long history): the chat, the tool log and the
// Subagents tab render again with every change to the task, its logs or the clock, so each of their rows must render
// only when its own data changed. Rows are counted by a function each calls exactly once per render.
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType } from '../shared/bridge'
import {
  MessageRole,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Message,
  type NarrationEvent,
  type PermissionRequest,
  type ToolCallEvent,
  type ToolEvent,
} from '../shared/domain'
import { Chat } from './chat'
import { clockTime } from './chat/chatModel'
import { samplePermissionRequest, sampleTask, sampleWatcher, sampleWorkspace } from './store/test-bridge'
import { storeWrapper, type StoreWrapper } from './store/test-wrapper'
import { ELAPSED_REFRESH_MS, SubagentsTab } from './subagents/SubagentsTab'
import { statusLabel } from './subagents/subagentsModel'
import { ToolLog } from './tool-log'

// Every chat entry and tool log row shows its time: one `clockTime` call per render of one.
vi.mock('./chat/chatModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./chat/chatModel')>()
  return { ...original, clockTime: vi.fn(original.clockTime) }
})
// Every subagent row shows its status: one `statusLabel` call per render of one.
vi.mock('./subagents/subagentsModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./subagents/subagentsModel')>()
  return { ...original, statusLabel: vi.fn(original.statusLabel) }
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
