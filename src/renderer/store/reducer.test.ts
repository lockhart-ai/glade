import { describe, expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import {
  DividerKind,
  QuestionReplyKind,
  QuestionSetState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { noOpenFiles } from '../../shared/files'
import { applyEvent, idFromUiState, withHistory, withOpenedWorkspace } from './reducer'
import { INITIAL_DATA, type GladeData } from './state'
import { sampleMessage, sampleQuestionSet, sampleQueuedMessage, sampleTask, sampleWorkspace } from './test-bridge'

const state: GladeData = Object.freeze({
  ...INITIAL_DATA,
  workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
  tasks: { t1: sampleTask('t1', 'w1') },
})

describe('applyEvent', () => {
  it('leaves the state alone when main asks to open a task, which the store does by selecting it', () => {
    expect(applyEvent(state, { type: EventType.TaskOpenRequested, taskId: 't1' })).toBe(state)
  })

  it('records a uiState.changed entry and the workspace selection it holds', () => {
    const entry = { key: UiStateKey.ActiveWorkspaceId, value: 'w2' }

    const next = applyEvent(state, { type: EventType.UiStateChanged, entry })

    expect(next.uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2' })
    expect(next.selectedWorkspaceId).toBe('w2')
    expect(next.selectedTaskId).toBeNull()
    expect(state.uiState).toEqual({})
  })

  it('records a uiState.changed entry for the selected task, with the empty string as no selection', () => {
    const selected = applyEvent(state, {
      type: EventType.UiStateChanged,
      entry: { key: UiStateKey.SelectedTaskId, value: 't1' },
    })
    expect(selected.selectedTaskId).toBe('t1')

    const cleared = applyEvent(selected, {
      type: EventType.UiStateChanged,
      entry: { key: UiStateKey.SelectedTaskId, value: '' },
    })
    expect(cleared.selectedTaskId).toBeNull()
    expect(cleared.uiState).toEqual({ [UiStateKey.SelectedTaskId]: '' })
  })

  it('replaces an updated workspace in place', () => {
    const renamed = { ...sampleWorkspace('w1'), name: 'Acme Web' }

    const next = applyEvent(state, { type: EventType.WorkspaceUpdated, workspace: renamed })

    expect(next.workspaces).toEqual([renamed, sampleWorkspace('w2')])
    expect(state.workspaces[0]?.name).toBe('Acme API')
  })

  it('appends a new workspace', () => {
    const added = sampleWorkspace('w3')

    expect(applyEvent(state, { type: EventType.WorkspaceUpdated, workspace: added }).workspaces).toEqual([
      sampleWorkspace('w1'),
      sampleWorkspace('w2'),
      added,
    ])
  })

  it('adds or replaces an updated task by id', () => {
    const renamed = { ...sampleTask('t1', 'w1'), title: 'Add caching' }
    const added = sampleTask('t2', 'w2')

    const next = applyEvent(applyEvent(state, { type: EventType.TaskUpdated, task: renamed }), {
      type: EventType.TaskUpdated,
      task: added,
    })

    expect(next.tasks).toEqual({ t1: renamed, t2: added })
    expect(state.tasks).toEqual({ t1: sampleTask('t1', 'w1') })
  })
})

const divider: ToolEvent = {
  kind: ToolEventKind.Divider,
  id: 'e1',
  taskId: 't1',
  turn: 1,
  createdAt: 3_000,
  dividerKind: DividerKind.Turn,
}

const call: ToolCallEvent = {
  kind: ToolEventKind.ToolCall,
  id: 'e2',
  taskId: 't1',
  turn: 1,
  createdAt: 3_000,
  name: 'Bash',
  input: { command: 'npm test' },
  output: null,
  state: ToolCallState.Running,
  finishedAt: null,
  toolUseId: 'toolu_01',
  parentToolUseId: null,
}

describe("a task's logs", () => {
  it('appends a message and a tool event to their task, once each', () => {
    const message = sampleMessage('m1', 't1')
    const events = [
      { type: EventType.MessageAppended, message },
      { type: EventType.MessageAppended, message },
      { type: EventType.ToolEventAppended, toolEvent: divider },
      { type: EventType.ToolEventAppended, toolEvent: divider },
    ] as const

    const next = events.reduce(applyEvent, state)

    expect(next.messages).toEqual({ t1: [message] })
    expect(next.toolEvents).toEqual({ t1: [divider] })
    expect(state.messages).toEqual({})
  })

  it('replaces an updated tool event in place, and leaves one it has not seen to the next load', () => {
    const done = { ...call, state: ToolCallState.Done, output: '12 passed' }
    const loaded = withHistory(state, 't1', {
      messages: [],
      toolEvents: [divider, call],
      queuedMessages: [],
      questionSets: [],
      openFiles: noOpenFiles('t1'),
    })

    expect(applyEvent(loaded, { type: EventType.ToolEventUpdated, toolEvent: done }).toolEvents).toEqual({
      t1: [divider, done],
    })
    expect(applyEvent(state, { type: EventType.ToolEventUpdated, toolEvent: done }).toolEvents).toBe(state.toolEvents)
  })

  it('loads a history, keeping entries that events brought after it was read', () => {
    const early = sampleMessage('m1', 't1')
    const late = sampleMessage('m2', 't1', 'And fix it.')
    const withEvents = [
      { type: EventType.MessageAppended, message: early },
      { type: EventType.MessageAppended, message: late },
      { type: EventType.ToolEventAppended, toolEvent: call },
    ] as const
    const current = withEvents.reduce(applyEvent, state)

    const next = withHistory(current, 't1', {
      messages: [early],
      toolEvents: [divider, call],
      queuedMessages: [],
      questionSets: [],
      openFiles: noOpenFiles('t1'),
    })

    expect(next.messages.t1).toEqual([early, late])
    expect(next.toolEvents.t1).toEqual([divider, call])
    expect(
      withHistory(state, 't2', {
        messages: [],
        toolEvents: [],
        queuedMessages: [],
        questionSets: [],
        openFiles: noOpenFiles('t2'),
      }).messages,
    ).toEqual({ t2: [] })
  })
})

describe("a task's queue", () => {
  it('takes the queue from each change, whole, and from a history load', () => {
    const first = sampleQueuedMessage('q1', 't1')
    const second = sampleQueuedMessage('q2', 't1', 'Then check a sample.')

    const changed = applyEvent(state, { type: EventType.QueueChanged, taskId: 't1', queuedMessages: [first, second] })
    expect(changed.queuedMessages).toEqual({ t1: [first, second] })
    expect(
      applyEvent(changed, { type: EventType.QueueChanged, taskId: 't1', queuedMessages: [] }).queuedMessages,
    ).toEqual({ t1: [] })

    const loaded = withHistory(changed, 't1', {
      messages: [],
      toolEvents: [],
      queuedMessages: [second],
      questionSets: [],
      openFiles: noOpenFiles('t1'),
    })
    expect(loaded.queuedMessages).toEqual({ t1: [second] })
  })
})

describe("a task's questions", () => {
  it('appends an opened set, replaces it when answered or withdrawn, and loads them with the history', () => {
    const open = sampleQuestionSet('s1', 't1')
    const answered = {
      ...open,
      state: QuestionSetState.Answered,
      reply: { kind: QuestionReplyKind.Answers, answers: { 0: 'by-type' } },
      closedAt: 4_000,
    } as const
    const withdrawn = { ...sampleQuestionSet('s2', 't1'), state: QuestionSetState.Withdrawn } as const

    const opened = [
      { type: EventType.QuestionOpened, questionSet: open },
      { type: EventType.QuestionOpened, questionSet: open },
      { type: EventType.QuestionOpened, questionSet: sampleQuestionSet('s2', 't1') },
    ] as const
    const asked = opened.reduce(applyEvent, state)
    expect(asked.questionSets.t1?.map(({ id }) => id)).toEqual(['s1', 's2'])

    const closed = [
      { type: EventType.QuestionAnswered, questionSet: answered },
      { type: EventType.QuestionWithdrawn, questionSet: withdrawn },
    ] as const
    expect(closed.reduce(applyEvent, asked).questionSets.t1).toEqual([answered, withdrawn])

    const empty = { messages: [], toolEvents: [], queuedMessages: [], openFiles: noOpenFiles('t1') }
    expect(withHistory(state, 't1', { ...empty, questionSets: [answered] }).questionSets).toEqual({ t1: [answered] })
  })
})

describe("a task's open files", () => {
  it('takes them from each change, whole, and from a history load', () => {
    const openFiles = { taskId: 't1', paths: ['docs/rate-limits.md'], activePath: 'docs/rate-limits.md' }

    const changed = applyEvent(state, { type: EventType.OpenFilesChanged, openFiles })
    expect(changed.openFiles).toEqual({ t1: openFiles })

    const empty = { messages: [], toolEvents: [], queuedMessages: [], questionSets: [] }
    expect(withHistory(changed, 't1', { ...empty, openFiles: noOpenFiles('t1') }).openFiles).toEqual({
      t1: noOpenFiles('t1'),
    })
  })

  it('records each request to show a file as a new one, even for the same line', () => {
    const shown = { type: EventType.FileShown, taskId: 't1', path: 'docs/rate-limits.md', line: 8 } as const

    const first = applyEvent(state, shown)
    const second = applyEvent(first, shown)

    expect(first.fileFocus).toEqual({ taskId: 't1', path: 'docs/rate-limits.md', line: 8, request: 1 })
    expect(second.fileFocus?.request).toBe(2)
  })
})

describe('withOpenedWorkspace', () => {
  const opened = { ...sampleWorkspace('w2'), lastOpenedAt: 5_000 }

  it('records the workspace as it now is and shows it, deselecting a task in another workspace', () => {
    const next = withOpenedWorkspace({ ...state, selectedTaskId: 't1' }, opened)

    expect(next.workspaces).toEqual([sampleWorkspace('w1'), opened])
    expect(next.selectedWorkspaceId).toBe('w2')
    expect(next.selectedTaskId).toBeNull()
    expect(next.uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2', [UiStateKey.SelectedTaskId]: '' })
  })

  it('keeps a selected task in the same workspace, or none', () => {
    expect(withOpenedWorkspace({ ...state, selectedTaskId: 't1' }, sampleWorkspace('w1')).selectedTaskId).toBe('t1')
    expect(withOpenedWorkspace(state, opened).uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2' })
  })
})

describe('idFromUiState', () => {
  it('reads the empty string as no selection', () => {
    expect(idFromUiState('')).toBeNull()
    expect(idFromUiState('t1')).toBe('t1')
  })
})
