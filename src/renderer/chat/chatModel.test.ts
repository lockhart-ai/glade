import { describe, expect, it } from 'vitest'
import {
  CompactionTrigger,
  DividerKind,
  MessageRole,
  QuestionKind,
  QuestionSetState,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
  type DividerEvent,
  type Message,
  type PermissionRequest,
  type QuestionSet,
  type ToolEvent,
} from '../../shared/domain'
import { samplePermissionRequest, sampleTask } from '../store/test-bridge'
import {
  ChatEntryKind,
  chatEntries,
  clockTime,
  COMPACTING_NARRATION,
  compactedLabel,
  currentTurn,
  dayAndTime,
  durationLabel,
  markedDoneLabel,
  questionLead,
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

/** Each entry's message id, or its divider's, question set's or permission request's id. */
function kinds(entries: readonly ChatEntry[]): unknown[] {
  return entries.map((entry) => {
    if ('message' in entry) return entry.message.id
    if ('questionSet' in entry) return entry.questionSet.id
    if ('request' in entry) return entry.request.id
    return 'compaction' in entry ? entry.compaction.id : entry.divider.id
  })
}

function message(id: string, role: MessageRole, turn: number): Message {
  return { id, taskId: 't1', role, body: id, turn, createdAt: 1_000, summary: null, images: [] }
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
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId,
  }
}

function narration(id: string, turn: number, text: string): ToolEvent {
  return { id, taskId: 't1', turn, createdAt: 1_000, kind: ToolEventKind.Narration, text, parentToolUseId: null }
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

  it("is the latest turn divider's turn for a turn the agent started on its own, before it has a message", () => {
    const messages = [message('a', MessageRole.User, 1), message('b', MessageRole.Agent, 1)]
    const resumed = { ...divider, id: 'd3', turn: 3, dividerKind: DividerKind.Resumed }
    expect(currentTurn(messages, [divider, { ...divider, id: 'd2', turn: 2 }, resumed, narration('n', 4, 'x')])).toBe(2)
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

    it('puts a queued message delivered into the resumed turn after the divider, and one delivered before it ahead', () => {
      const restartedAt = resumed('r1', 1).createdAt
      const turn = [
        message('ask', MessageRole.User, 1),
        { ...message('queued-before', MessageRole.User, 1), createdAt: restartedAt - 1 },
        { ...message('queued-after', MessageRole.User, 1), createdAt: restartedAt + 1 },
        message('reply-1', MessageRole.Agent, 1),
      ]
      expect(kinds(chatEntries(task, turn, [resumed('r1', 1)]))).toEqual([
        'ask',
        'queued-before',
        'r1',
        'queued-after',
        'reply-1',
      ])
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

describe('question cards', () => {
  const asked = (id: string, turn: number, createdAt: number): QuestionSet => ({
    id,
    taskId: 't1',
    turn,
    questions: [{ kind: QuestionKind.Pills, prompt: 'Credit?', options: ['Yes', 'No'] }],
    state: QuestionSetState.Open,
    reply: null,
    createdAt,
    closedAt: null,
  })
  const at = <T extends Message | ToolEvent>(entry: T, createdAt: number): T => ({ ...entry, createdAt })
  const ask = (id: string, turn: number, createdAt: number): ToolEvent => ({
    id,
    taskId: 't1',
    turn,
    createdAt,
    kind: ToolEventKind.ToolCall,
    name: 'mcp__glade__ask',
    input: {},
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId: `use-${id}`,
    parentToolUseId: null,
  })

  it("shows each where it was asked: after its turn's earlier messages, before later ones and the reply", () => {
    const messages = [
      message('ask', MessageRole.User, 1),
      at(message('in-words', MessageRole.User, 1), 3_000),
      at(message('reply-1', MessageRole.Agent, 1), 4_000),
      at(message('follow-up', MessageRole.User, 2), 5_000),
    ]
    const sets = [asked('q2', 2, 6_000), asked('q1', 1, 2_000)]
    expect(kinds(chatEntries(task, messages, [], sets))).toEqual([
      'ask',
      'q1',
      'in-words',
      'reply-1',
      'follow-up',
      'q2',
    ])
  })

  it('goes before a divider that came after it, and after one that came before it', () => {
    const resumed: DividerEvent = {
      id: 'r1',
      taskId: 't1',
      turn: 1,
      createdAt: 3_000,
      kind: ToolEventKind.Divider,
      dividerKind: DividerKind.Resumed,
    }
    const messages = [message('ask', MessageRole.User, 1), at(message('reply-1', MessageRole.Agent, 1), 4_000)]
    expect(kinds(chatEntries(task, messages, [resumed], [asked('q1', 1, 2_000)]))).toEqual([
      'ask',
      'q1',
      'r1',
      'reply-1',
    ])
    expect(kinds(chatEntries(task, messages, [resumed], [asked('q1', 1, 3_500)]))).toEqual([
      'ask',
      'r1',
      'q1',
      'reply-1',
    ])
    expect(kinds(chatEntries(task, messages.slice(0, 1), [resumed], [asked('q1', 1, 2_000)]))).toEqual([
      'ask',
      'q1',
      'r1',
    ])
  })

  it("leads with the narration just before the ask call, if nothing came between, and only from the set's turn", () => {
    const set = asked('q1', 2, 5_000)
    const said = at(narration('n1', 2, 'A few choices are yours.'), 4_000)
    expect(questionLead(set, [said, ask('c1', 2, 4_500)])).toBe('A few choices are yours.')
    expect(questionLead(set, [said, at(toolCall('c0', 2), 4_200), ask('c1', 2, 4_500)])).toBeNull()
    expect(questionLead(set, [at(narration('n0', 1, 'Earlier.'), 1_000)])).toBeNull()
    expect(questionLead(set, [at(narration('n2', 2, 'Later.'), 6_000)])).toBeNull()
    expect(questionLead(set, [])).toBeNull()
    const [entry] = chatEntries(task, [], [said], [set])
    expect(entry).toEqual({ kind: ChatEntryKind.Question, questionSet: set, lead: 'A few choices are yours.' })
  })
})

describe('permission cards', () => {
  const at = <T extends Message>(entry: T, createdAt: number): T => ({ ...entry, createdAt })
  const requested = (id: string, turn: number, createdAt: number): PermissionRequest => ({
    ...samplePermissionRequest(id, 't1'),
    turn,
    createdAt,
  })
  const asked = (id: string, turn: number, createdAt: number): QuestionSet => ({
    id,
    taskId: 't1',
    turn,
    questions: [{ kind: QuestionKind.Pills, prompt: 'Credit?', options: ['Yes', 'No'] }],
    state: QuestionSetState.Open,
    reply: null,
    createdAt,
    closedAt: null,
  })

  it("show where they asked, in the order they asked, among the turn's messages and the questions", () => {
    const messages = [
      message('ask', MessageRole.User, 1),
      at(message('queued', MessageRole.User, 1), 3_000),
      at(message('reply-1', MessageRole.Agent, 1), 4_000),
      at(message('follow-up', MessageRole.User, 2), 5_000),
    ]
    const requests = [requested('p3', 2, 6_000), requested('p2', 1, 2_500), requested('p1', 1, 2_000)]
    const entries = chatEntries(task, messages, [], [asked('q1', 1, 2_200)], requests)
    expect(kinds(entries)).toEqual(['ask', 'p1', 'q1', 'p2', 'queued', 'reply-1', 'follow-up', 'p3'])
    expect(entries[1]).toEqual({ kind: ChatEntryKind.Permission, request: requests[2] })
  })

  it('shows with no messages yet, as for a turn the agent started on its own', () => {
    expect(kinds(chatEntries(task, [], [], [], [requested('p1', 1, 2_000)]))).toEqual(['p1'])
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

  it('shows marked done before the first message of a task done before its first turn (a backfill)', () => {
    const backfilled = [
      at(DividerKind.MarkedDone, 'done', 1, 500),
      at(DividerKind.Reopened, 'reopened', 1, 2_000),
      at(DividerKind.Turn, 't1', 1, 2_000),
    ]
    const entries = chatEntries(task, [message('pick-up', MessageRole.User, 1)], backfilled)
    expect(kinds(entries)).toEqual(['done', 'pick-up', 'reopened'])
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

describe('after a compaction', () => {
  const compaction = (id: string, turn: number, createdAt: number, change: Partial<CompactionEvent> = {}) =>
    ({
      id,
      taskId: 't1',
      turn,
      createdAt,
      kind: ToolEventKind.Compaction,
      trigger: CompactionTrigger.Manual,
      state: ToolCallState.Done,
      preTokens: 198_000,
      postTokens: 41_000,
      windowTokens: 200_000,
      ...change,
    }) satisfies CompactionEvent
  const at = (id: string, role: MessageRole, turn: number, createdAt: number): Message => ({
    ...message(id, role, turn),
    createdAt,
  })
  const messages = [
    at('ask', MessageRole.User, 1, 1_000),
    at('reply-1', MessageRole.Agent, 1, 2_000),
    at('next', MessageRole.User, 2, 4_000),
    at('reply-2', MessageRole.Agent, 2, 6_000),
  ]

  it('shows a divider where it happened: after the turn you compacted, or mid-turn before the reply', () => {
    const manual = compaction('manual', 1, 3_000)
    const auto = compaction('auto', 2, 5_000, { trigger: CompactionTrigger.Auto, preTokens: 198_000 })
    const entries = chatEntries(task, messages, [manual, auto])
    expect(kinds(entries)).toEqual(['ask', 'reply-1', 'manual', 'next', 'auto', 'reply-2'])
    expect(entries[2]).toEqual({ kind: ChatEntryKind.Compacted, compaction: manual })
  })

  it('keeps a compaction after the last message at the end', () => {
    expect(kinds(chatEntries(task, messages, [compaction('last', 2, 7_000)])).at(-1)).toBe('last')
  })

  it('shows no divider for a compaction that is running or never finished', () => {
    const events = [
      compaction('running', 2, 7_000, { state: ToolCallState.Running, preTokens: null, postTokens: null }),
      compaction('failed', 2, 7_000, { state: ToolCallState.Error, preTokens: null, postTokens: null }),
    ]
    expect(kinds(chatEntries(task, messages, events))).toEqual(['ask', 'reply-1', 'next', 'reply-2'])
  })

  it('says what it went from and to, and at how full the context was when the SDK did it on its own', () => {
    const label = (change: Partial<CompactionEvent>) =>
      compactedLabel({ kind: ChatEntryKind.Compacted, compaction: compaction('c', 1, 1_000, change) })
    expect(label({})).toBe('Compacted · 198k → 41k')
    expect(label({ postTokens: null })).toBe('Compacted · from 198k')
    expect(label({ trigger: CompactionTrigger.Auto })).toBe('Compacted automatically at 99% · 198k → 41k')
    expect(label({ trigger: CompactionTrigger.Auto, windowTokens: 0, preTokens: null })).toBe(
      'Compacted automatically at 0% · 0k → 41k',
    )
  })

  it('makes the working line say it is compacting while it runs', () => {
    const working = { ...task, activity: TaskActivity.Working }
    const running = compaction('c', 2, 7_000, { state: ToolCallState.Running })
    expect(workingNarration(working, messages, [narration('n', 2, 'Old note'), running])).toBe(COMPACTING_NARRATION)
    expect(workingNarration(working, messages, [running, narration('n', 2, 'New note')])).toBe('New note')
    expect(workingNarration(working, messages, [narration('n', 2, 'Note'), compaction('d', 2, 7_000)])).toBe('Note')
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

  it("leaves out a subagent's notes", () => {
    const events = [
      narration('a', 1, 'Splitting the work'),
      { ...narration('b', 1, 'Reading the API PRs'), parentToolUseId: 'use-agent' },
    ]
    expect(workingNarration(working, messages, events)).toBe('Splitting the work')
  })

  it('is the latest narration of a turn the agent started on its own, which has no message yet', () => {
    const events = [
      divider,
      narration('a', 1, 'Old turn'),
      { ...divider, id: 'd2', turn: 2 },
      narration('b', 2, 'Reading the build output'),
    ]
    expect(workingNarration(working, messages, events)).toBe('Reading the build output')
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
