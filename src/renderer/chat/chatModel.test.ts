import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type DividerEvent,
  type Message,
  type ToolEvent,
} from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import {
  ChatEntryKind,
  chatEntries,
  clockTime,
  currentTurn,
  dayAndTime,
  durationLabel,
  markedDoneLabel,
  REOPENED_LABEL,
  ReplyStyle,
  restartLabel,
  summaryLine,
  type ChatEntry,
  toolCallLabel,
  toolCallsByTurn,
  workingNarration,
} from './chatModel'

const task = sampleTask('t1', 'w1')

/** Each entry's message id, or its divider's id. */
function kinds(entries: readonly ChatEntry[]): unknown[] {
  return entries.map((entry) => ('message' in entry ? entry.message.id : entry.divider.id))
}

function message(id: string, role: MessageRole, turn: number): Message {
  return { id, taskId: 't1', role, body: id, turn, createdAt: 1_000, summary: null }
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
    expect(entries.map((entry) => 'message' in entry && entry.message.id)).toEqual([
      'ask',
      'reply-1',
      'follow-up',
      'reply-2',
    ])
    expect(entries[1]).toMatchObject({ kind: ChatEntryKind.Agent, toolCalls: 2, style: ReplyStyle.Plain })
    expect(entries[3]).toMatchObject({ kind: ChatEntryKind.Agent, toolCalls: 0 })
    expect(entries[0]).toEqual({ kind: ChatEntryKind.User, message: messages[0] })
  })

  it('styles the latest reply as a question only while the active task waits on you', () => {
    const style = (activity: TaskActivity, state = TaskState.Active): unknown =>
      chatEntries({ ...task, activity, state }, messages, toolEvents).map((entry) =>
        entry.kind === ChatEntryKind.Agent ? entry.style : null,
      )

    expect(style(TaskActivity.Waiting)).toEqual([null, ReplyStyle.Plain, null, ReplyStyle.Question])
    expect(style(TaskActivity.Error)).toEqual([null, ReplyStyle.Plain, null, ReplyStyle.Plain])
    expect(style(TaskActivity.Waiting, TaskState.Done)).toEqual([null, ReplyStyle.Plain, null, ReplyStyle.Plain])
  })

  it('has no question once you have answered', () => {
    const answered = [...messages, message('answer', MessageRole.User, 3)]
    const entries = chatEntries(task, answered, toolEvents)
    expect(entries.some((entry) => entry.kind === ChatEntryKind.Agent && entry.style === ReplyStyle.Question)).toBe(
      false,
    )
  })

  describe('after a restart', () => {
    const resumed = (id: string, turn: number): DividerEvent => ({
      id,
      taskId: 't1',
      turn,
      createdAt: new Date(2026, 8, 23, 14, 26).getTime(),
      kind: ToolEventKind.Divider,
      dividerKind: DividerKind.Resumed,
    })

    it("shows a divider for each resumed turn, after the turn's message and before its reply", () => {
      const events = [...toolEvents, divider, resumed('r1', 1), resumed('r2', 2)]
      expect(kinds(chatEntries(task, messages, events))).toEqual(['ask', 'r1', 'reply-1', 'follow-up', 'r2', 'reply-2'])
    })

    it('keeps a divider for a turn with no reply yet at the end, saying it is resuming while the turn runs', () => {
      const running = messages.slice(0, 3)
      const events = [resumed('r1', 1), resumed('r2', 2)]
      const working = chatEntries({ ...task, activity: TaskActivity.Working }, running, events)
      expect(kinds(working)).toEqual(['ask', 'r1', 'reply-1', 'follow-up', 'r2'])

      const labels = (entries: readonly ChatEntry[]): string[] =>
        entries.flatMap((entry) => (entry.kind === ChatEntryKind.Restarted ? [restartLabel(entry)] : []))
      expect(labels(working)).toEqual(['Glade restarted · 14:26', 'Glade restarted · 14:26 · resuming'])
      expect(labels(chatEntries(task, running, events))).toEqual(['Glade restarted · 14:26', 'Glade restarted · 14:26'])
    })
  })
})

describe('after a reopen', () => {
  const doneAt = new Date(2026, 8, 23, 11, 26).getTime()
  const at = (dividerKind: DividerKind, id: string, turn: number, createdAt = doneAt): DividerEvent => ({
    id,
    taskId: 't1',
    turn,
    createdAt,
    kind: ToolEventKind.Divider,
    dividerKind,
  })
  const messages = [
    message('ask', MessageRole.User, 1),
    message('reply-1', MessageRole.Agent, 1),
    message('reopen', MessageRole.User, 2),
    message('reply-2', MessageRole.Agent, 2),
  ]
  const events = [
    at(DividerKind.Turn, 't1', 1),
    at(DividerKind.MarkedDone, 'done', 1),
    at(DividerKind.Reopened, 'reopened', 2, doneAt + 86_400_000),
    at(DividerKind.Turn, 't2', 2),
  ]

  it('shows marked done before the reopening message, and reopened after it and before its reply', () => {
    const entries = chatEntries(task, messages, events)
    expect(kinds(entries)).toEqual(['ask', 'reply-1', 'done', 'reopen', 'reopened', 'reply-2'])
    expect(entries[2]).toEqual({ kind: ChatEntryKind.MarkedDone, divider: events[1] })
    expect(entries[4]).toEqual({ kind: ChatEntryKind.Reopened, divider: events[2] })
  })

  it('keeps both dividers after the reopening message while its turn runs', () => {
    const working = chatEntries({ ...task, activity: TaskActivity.Working }, messages.slice(0, 3), events)
    expect(kinds(working)).toEqual(['ask', 'reply-1', 'done', 'reopen', 'reopened'])
  })

  it('says when the task was marked done, with its day', () => {
    const [entry] = chatEntries(task, [], [at(DividerKind.MarkedDone, 'done', 1)])
    expect(entry?.kind === ChatEntryKind.MarkedDone && markedDoneLabel(entry)).toBe('Marked done · Sep 23, 11:26')
    expect(REOPENED_LABEL).toBe('Reopened by your message')
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

  it('shows how long a turn ran, to the nearest second', () => {
    expect(durationLabel(0)).toBe('0s')
    expect(durationLabel(8_400)).toBe('8s')
    expect(durationLabel(59_499)).toBe('59s')
    expect(durationLabel(59_500)).toBe('1m 0s')
    expect(durationLabel((24 * 60 + 10) * 1000)).toBe('24m 10s')
    expect(durationLabel(3_599_000)).toBe('59m 59s')
    expect(durationLabel((62 * 60 + 30) * 1000)).toBe('1h 2m')
    expect(durationLabel(26 * 3_600_000)).toBe('26h 0m')
  })

  it('summarizes a turn: its duration, and the files and lines it changed when it changed any', () => {
    const changed = { durationMs: (24 * 60 + 10) * 1000, filesChanged: 4, linesAdded: 61, linesRemoved: 3 }
    expect(summaryLine(changed)).toEqual({
      text: 'Finished in 24m 10s · 4 files',
      lines: { added: '+61', removed: '−3' },
    })
    expect(summaryLine({ ...changed, filesChanged: 1, linesAdded: 2, linesRemoved: 0 })).toEqual({
      text: 'Finished in 24m 10s · 1 file',
      lines: { added: '+2', removed: '−0' },
    })
    expect(summaryLine({ durationMs: 8_000, filesChanged: 0, linesAdded: 0, linesRemoved: 0 })).toEqual({
      text: 'Finished in 8s',
      lines: null,
    })
    expect(summaryLine({ ...changed, durationMs: null })).toEqual({
      text: '4 files',
      lines: { added: '+61', removed: '−3' },
    })
    expect(summaryLine({ durationMs: null, filesChanged: 0, linesAdded: 0, linesRemoved: 0 })).toBeNull()
  })

  it('shows a day and time', () => {
    expect(dayAndTime(new Date(2026, 8, 25, 9, 14).getTime())).toBe('Sep 25, 09:14')
  })

  it('shows 24-hour local time', () => {
    expect(clockTime(new Date(2026, 8, 23, 9, 5).getTime())).toBe('09:05')
    expect(clockTime(new Date(2026, 8, 23, 14, 42).getTime())).toBe('14:42')
  })
})
