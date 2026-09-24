import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type Message,
  type ToolEvent,
} from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import {
  chatEntries,
  clockTime,
  currentTurn,
  ReplyStyle,
  toolCallLabel,
  toolCallsByTurn,
  workingNarration,
} from './chatModel'

const task = sampleTask('t1', 'w1')

function message(id: string, role: MessageRole, turn: number): Message {
  return { id, taskId: 't1', role, body: id, turn, createdAt: 1_000 }
}

function toolCall(id: string, turn: number, parentToolUseId: string | null = null): ToolEvent {
  return {
    id,
    taskId: 't1',
    turn,
    createdAt: 1_000,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: {},
    output: null,
    state: ToolCallState.Done,
    toolUseId: `use-${id}`,
    parentToolUseId,
  }
}

function narration(id: string, turn: number, text: string): ToolEvent {
  return { id, taskId: 't1', turn, createdAt: 1_000, kind: ToolEventKind.Narration, text }
}

const divider: ToolEvent = {
  id: 'd1',
  taskId: 't1',
  turn: 1,
  createdAt: 1_000,
  kind: ToolEventKind.Divider,
  dividerKind: DividerKind.Turn,
}

describe('currentTurn', () => {
  it("is the latest message's turn, or 0 before any", () => {
    expect(currentTurn([])).toBe(0)
    expect(currentTurn([message('a', MessageRole.User, 1), message('b', MessageRole.User, 2)])).toBe(2)
  })
})

describe('toolCallsByTurn', () => {
  it("counts each turn's top-level tool calls, not subagents' calls, narration or dividers", () => {
    const counts = toolCallsByTurn([
      divider,
      toolCall('a', 1),
      narration('n', 1, 'Looking'),
      toolCall('b', 1),
      toolCall('c', 1, 'use-b'),
      toolCall('d', 2),
    ])
    expect([...counts]).toEqual([
      [1, 2],
      [2, 1],
    ])
  })
})

describe('chatEntries', () => {
  const messages = [
    message('ask', MessageRole.User, 1),
    message('reply-1', MessageRole.Agent, 1),
    message('follow-up', MessageRole.User, 2),
    message('reply-2', MessageRole.Agent, 2),
  ]
  const toolEvents = [toolCall('a', 1), toolCall('b', 1), narration('n', 2, 'Checking')]

  it('keeps every message in order, with each reply’s tool calls', () => {
    const entries = chatEntries(task, messages, toolEvents)
    expect(entries.map((entry) => entry.message.id)).toEqual(['ask', 'reply-1', 'follow-up', 'reply-2'])
    expect(entries[1]).toMatchObject({ role: MessageRole.Agent, toolCalls: 2, style: ReplyStyle.Plain })
    expect(entries[3]).toMatchObject({ role: MessageRole.Agent, toolCalls: 0 })
    expect(entries[0]).toEqual({ role: MessageRole.User, message: messages[0] })
  })

  it('styles the latest reply as a question only while the active task waits on you', () => {
    const style = (activity: TaskActivity, state = TaskState.Active): unknown =>
      chatEntries({ ...task, activity, state }, messages, toolEvents).map((entry) =>
        entry.role === MessageRole.Agent ? entry.style : null,
      )

    expect(style(TaskActivity.Waiting)).toEqual([null, ReplyStyle.Plain, null, ReplyStyle.Question])
    expect(style(TaskActivity.Error)).toEqual([null, ReplyStyle.Plain, null, ReplyStyle.Plain])
    expect(style(TaskActivity.Waiting, TaskState.Done)).toEqual([null, ReplyStyle.Plain, null, ReplyStyle.Plain])
  })

  it('has no question once you have answered', () => {
    const answered = [...messages, message('answer', MessageRole.User, 3)]
    const entries = chatEntries(task, answered, toolEvents)
    expect(entries.some((entry) => entry.role === MessageRole.Agent && entry.style === ReplyStyle.Question)).toBe(false)
  })
})

describe('workingNarration', () => {
  const messages = [message('ask', MessageRole.User, 1), message('reply', MessageRole.Agent, 1)]
  const working = { ...task, activity: TaskActivity.Working }

  it('is null unless the task is working', () => {
    expect(workingNarration(task, messages, [narration('n', 1, 'Reading')])).toBeNull()
  })

  it("is the current turn's latest narration", () => {
    const next = [...messages, message('again', MessageRole.User, 2)]
    const events = [narration('a', 1, 'Old turn'), narration('b', 2, 'Reading the views'), toolCall('c', 2)]
    expect(workingNarration(working, next, events)).toBe('Reading the views')
    expect(workingNarration(working, next, [...events, narration('d', 2, 'Running the tests')])).toBe(
      'Running the tests',
    )
  })

  it('is empty before the turn has any narration', () => {
    const next = [...messages, message('again', MessageRole.User, 2)]
    expect(workingNarration(working, next, [narration('a', 1, 'Old turn')])).toBe('')
  })
})

describe('labels', () => {
  it('counts tool calls', () => {
    expect(toolCallLabel(1)).toBe('1 tool call')
    expect(toolCallLabel(7)).toBe('7 tool calls')
  })

  it('shows 24-hour local time', () => {
    expect(clockTime(new Date(2026, 8, 23, 9, 5).getTime())).toBe('09:05')
    expect(clockTime(new Date(2026, 8, 23, 14, 42).getTime())).toBe('14:42')
  })
})
