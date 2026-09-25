import { describe, expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import { appCommand, AppCommandId } from '../../shared/commands'
import {
  DividerKind,
  PermissionRequestState,
  QuestionReplyKind,
  QuestionSetState,
  TodoState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Artifact,
  type TaskHandoff,
  type TodoList,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { noOpenFiles } from '../../shared/files'
import { applyEvent, idFromUiState, withHistory, withOpenedWorkspace } from './reducer'
import { INITIAL_DATA, type GladeData } from './state'
import {
  sampleMessage,
  samplePermissionRequest,
  sampleQuestionSet,
  sampleQueuedMessage,
  sampleTask,
  sampleTerminalTab,
  sampleWorkspace,
} from './test-bridge'

const state: GladeData = Object.freeze({
  ...INITIAL_DATA,
  workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
  tasks: { t1: sampleTask('t1', 'w1') },
})

describe('applyEvent', () => {
  it('leaves the state alone when main asks to open a task, which the store does by selecting it', () => {
    expect(applyEvent(state, { type: EventType.TaskOpenRequested, taskId: 't1' })).toBe(state)
  })

  it('leaves the state alone for a menu bar command, which the window runs', () => {
    expect(applyEvent(state, { type: EventType.MenuCommand, command: appCommand(AppCommandId.NewTask) })).toBe(state)
  })

  it('forgets a removed workspace, its tasks and the confirmation that named it', () => {
    const asking = { ...state, removingWorkspaceId: 'w1', messages: { t1: [sampleMessage('m1', 't1')] } }

    const next = applyEvent(asking, { type: EventType.WorkspaceRemoved, workspaceId: 'w1' })

    expect(next.workspaces.map(({ id }) => id)).toEqual(['w2'])
    expect(next.tasks).toEqual({})
    expect(next.messages).toEqual({})
    expect(next.removingWorkspaceId).toBeNull()
    expect(applyEvent(asking, { type: EventType.WorkspaceRemoved, workspaceId: 'w2' }).removingWorkspaceId).toBe('w1')
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

describe('a deleted task', () => {
  it('is forgotten with everything the store keeps for it, and the intents that name it', () => {
    const loaded: GladeData = {
      ...state,
      tasks: { t1: sampleTask('t1', 'w1'), t2: sampleTask('t2', 'w1') },
      messages: { t1: [sampleMessage('m1', 't1')], t2: [sampleMessage('m2', 't2')] },
      toolEvents: { t1: [] },
      queuedMessages: { t1: [sampleQueuedMessage('q1', 't1')] },
      questionSets: { t1: [sampleQuestionSet('s1', 't1')] },
      permissionRequests: { t1: [samplePermissionRequest('p1', 't1')] },
      todos: { t1: null },
      openFiles: { t1: { taskId: 't1', paths: ['README.md'], activePath: 'README.md' } },
      artifacts: { t1: [{ taskId: 't1', path: 'README.md', title: 'Readme', addedAt: 1, updatedAt: 1 }] },
      handoffs: { t1: { taskId: 't1', body: '## Where it got to', addedAt: 1 } },
      inputDrafts: { t1: { text: 'Half a thought', images: [] } },
      toolLogFocus: { taskId: 't1', turn: 1, request: 1 },
      fileFocus: { taskId: 't1', path: 'README.md', line: null, request: 1 },
      renamingTaskId: 't1',
      deletingTaskId: 't1',
    }

    const next = applyEvent(loaded, { type: EventType.TaskDeleted, taskId: 't1' })

    expect(next).toEqual({
      ...loaded,
      tasks: { t2: sampleTask('t2', 'w1') },
      messages: { t2: [sampleMessage('m2', 't2')] },
      toolEvents: {},
      queuedMessages: {},
      questionSets: {},
      permissionRequests: {},
      todos: {},
      openFiles: {},
      artifacts: {},
      handoffs: {},
      inputDrafts: {},
      toolLogFocus: null,
      fileFocus: null,
      renamingTaskId: null,
      deletingTaskId: null,
    })
  })

  it('leaves what belongs to other tasks as it is', () => {
    const loaded: GladeData = {
      ...state,
      toolLogFocus: { taskId: 't1', turn: 1, request: 1 },
      renamingTaskId: 't1',
      deletingTaskId: 't1',
    }

    const next = applyEvent(loaded, { type: EventType.TaskDeleted, taskId: 't9' })

    expect(next).toEqual(loaded)
    expect(next.tasks).toBe(loaded.tasks)
    expect(next.messages).toBe(loaded.messages)
  })
})

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
      permissionRequests: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
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
      permissionRequests: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
    })

    expect(next.messages.t1).toEqual([early, late])
    expect(next.toolEvents.t1).toEqual([divider, call])
    expect(
      withHistory(state, 't2', {
        messages: [],
        toolEvents: [],
        queuedMessages: [],
        questionSets: [],
        permissionRequests: [],
        openFiles: noOpenFiles('t2'),
        todos: null,
        artifacts: [],
        handoff: null,
        watchers: [],
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
      permissionRequests: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
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

    const empty = {
      messages: [],
      toolEvents: [],
      queuedMessages: [],
      permissionRequests: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
    }
    expect(withHistory(state, 't1', { ...empty, questionSets: [answered] }).questionSets).toEqual({ t1: [answered] })
  })
})

describe("a task's permission requests", () => {
  it('appends an opened request, replaces it when answered or withdrawn, and loads them with the history', () => {
    const open = samplePermissionRequest('p1', 't1')
    const denied = {
      ...open,
      state: PermissionRequestState.Denied,
      denyNote: 'Not on main',
      closedAt: 4_000,
    } as const
    const withdrawn = { ...samplePermissionRequest('p2', 't1'), state: PermissionRequestState.Withdrawn } as const

    const opened = [
      { type: EventType.PermissionOpened, permissionRequest: open },
      { type: EventType.PermissionOpened, permissionRequest: open },
      { type: EventType.PermissionOpened, permissionRequest: samplePermissionRequest('p2', 't1') },
    ] as const
    const asked = opened.reduce(applyEvent, state)
    expect(asked.permissionRequests.t1?.map(({ id }) => id)).toEqual(['p1', 'p2'])

    const closed = [
      { type: EventType.PermissionAnswered, permissionRequest: denied },
      { type: EventType.PermissionWithdrawn, permissionRequest: withdrawn },
    ] as const
    expect(closed.reduce(applyEvent, asked).permissionRequests.t1).toEqual([denied, withdrawn])

    // One a window never heard open waits for the next history load.
    const unknown = { ...samplePermissionRequest('p3', 't2'), state: PermissionRequestState.Allowed }
    expect(applyEvent(state, { type: EventType.PermissionAnswered, permissionRequest: unknown })).toEqual(state)

    const empty = {
      messages: [],
      toolEvents: [],
      queuedMessages: [],
      questionSets: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
    }
    // A request opened while the history loaded stays, after the loaded ones.
    const loaded = withHistory(asked, 't1', { ...empty, permissionRequests: [denied] })
    expect(loaded.permissionRequests.t1?.map(({ id, state: closedState }) => [id, closedState])).toEqual([
      ['p1', PermissionRequestState.Denied],
      ['p2', PermissionRequestState.Open],
    ])
  })
})

describe("a task's open files", () => {
  it('takes them from each change, whole, and from a history load', () => {
    const openFiles = { taskId: 't1', paths: ['docs/rate-limits.md'], activePath: 'docs/rate-limits.md' }

    const changed = applyEvent(state, { type: EventType.OpenFilesChanged, openFiles })
    expect(changed.openFiles).toEqual({ t1: openFiles })

    const empty = {
      messages: [],
      toolEvents: [],
      queuedMessages: [],
      questionSets: [],
      permissionRequests: [],
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
    }
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

describe("a task's artifacts", () => {
  const artifact = (path: string, updatedAt: number): Artifact => ({
    taskId: 't1',
    path,
    title: path,
    addedAt: 1,
    updatedAt,
  })
  const history = (artifacts: readonly Artifact[]) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    openFiles: noOpenFiles('t1'),
    todos: null,
    artifacts,
    handoff: null,
    watchers: [],
  })

  it('takes the whole list from each change, and from a history load unless a change brought a newer one', () => {
    const changed = applyEvent(state, {
      type: EventType.ArtifactsChanged,
      taskId: 't1',
      artifacts: [artifact('a.md', 5), artifact('b.md', 9)],
    })
    expect(changed.artifacts.t1?.map(({ path }) => path)).toEqual(['a.md', 'b.md'])

    expect(withHistory(changed, 't1', history([artifact('a.md', 5)])).artifacts.t1).toHaveLength(2)
    expect(withHistory(changed, 't1', history([artifact('a.md', 12)])).artifacts.t1).toEqual([artifact('a.md', 12)])
    expect(withHistory(state, 't1', history([])).artifacts).toEqual({ t1: [] })
  })
})

describe("a task's handoff note", () => {
  const note = (body: string, addedAt: number): TaskHandoff => ({ taskId: 't1', body, addedAt })
  const history = (handoff: TaskHandoff | null) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    openFiles: noOpenFiles('t1'),
    todos: null,
    artifacts: [],
    handoff,
    watchers: [],
  })

  it('takes the note from each change, and a cleared one as none', () => {
    const changed = applyEvent(state, { type: EventType.HandoffChanged, taskId: 't1', handoff: note('Next', 5) })
    expect(changed.handoffs).toEqual({ t1: note('Next', 5) })
    expect(applyEvent(changed, { type: EventType.HandoffChanged, taskId: 't1', handoff: null }).handoffs).toEqual({
      t1: null,
    })
  })

  it('loads the note with the history, unless a change already brought one set after it', () => {
    expect(withHistory(state, 't1', history(note('Loaded', 5))).handoffs).toEqual({ t1: note('Loaded', 5) })
    expect(withHistory(state, 't1', history(null)).handoffs).toEqual({ t1: null })

    const changed = applyEvent(state, { type: EventType.HandoffChanged, taskId: 't1', handoff: note('Newer', 9) })
    expect(withHistory(changed, 't1', history(note('Loaded', 5))).handoffs.t1).toEqual(note('Newer', 9))
    expect(withHistory(changed, 't1', history(note('Loaded', 12))).handoffs.t1).toEqual(note('Loaded', 12))
    expect(withHistory(changed, 't1', history(null)).handoffs.t1).toBeNull()
  })
})

describe("a task's todo list", () => {
  const list = (text: string, updatedAt: number): TodoList => ({
    items: [{ text, state: TodoState.Todo, note: null }],
    updatedAt,
  })
  const history = (todos: TodoList | null) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    openFiles: noOpenFiles('t1'),
    todos,
    artifacts: [],
    handoff: null,
    watchers: [],
  })

  it('takes the list from each change, whole', () => {
    const changed = applyEvent(state, { type: EventType.TodosChanged, taskId: 't1', todos: list('Copy', 5_000) })
    expect(changed.todos).toEqual({ t1: list('Copy', 5_000) })
    expect(applyEvent(changed, { type: EventType.TodosChanged, taskId: 't1', todos: null }).todos).toEqual({ t1: null })
  })

  it('loads the list with the history, unless a change already brought a newer one', () => {
    expect(withHistory(state, 't1', history(list('Copy', 5_000))).todos).toEqual({ t1: list('Copy', 5_000) })
    expect(withHistory(state, 't1', history(null)).todos).toEqual({ t1: null })

    const changed = applyEvent(state, { type: EventType.TodosChanged, taskId: 't1', todos: list('Check', 6_000) })
    expect(withHistory(changed, 't1', history(list('Copy', 5_000))).todos).toEqual({ t1: list('Check', 6_000) })
    expect(withHistory(changed, 't1', history(null)).todos).toEqual({ t1: list('Check', 6_000) })
    expect(withHistory(changed, 't1', history(list('Ship', 6_000))).todos).toEqual({ t1: list('Ship', 6_000) })

    const cleared = applyEvent(state, { type: EventType.TodosChanged, taskId: 't1', todos: null })
    expect(withHistory(cleared, 't1', history(list('Copy', 5_000))).todos).toEqual({ t1: list('Copy', 5_000) })
  })
})

describe('withOpenedWorkspace', () => {
  const opened = { ...sampleWorkspace('w2'), lastOpenedAt: 5_000 }

  it('records the workspace as it now is and shows it, with no task selected when main selected none', () => {
    const next = withOpenedWorkspace({ ...state, selectedTaskId: 't1' }, opened, null)

    expect(next.workspaces).toEqual([sampleWorkspace('w1'), opened])
    expect(next.selectedWorkspaceId).toBe('w2')
    expect(next.selectedTaskId).toBeNull()
    expect(next.uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2', [UiStateKey.SelectedTaskId]: '' })
  })

  it('selects the task main restored', () => {
    const next = withOpenedWorkspace({ ...state, selectedTaskId: 't1' }, opened, 't2')

    expect(next.selectedTaskId).toBe('t2')
    expect(next.uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2', [UiStateKey.SelectedTaskId]: 't2' })
  })

  it('leaves a selection that is already right alone', () => {
    expect(withOpenedWorkspace({ ...state, selectedTaskId: 't1' }, sampleWorkspace('w1'), 't1').uiState).toEqual({
      [UiStateKey.ActiveWorkspaceId]: 'w1',
    })
    expect(withOpenedWorkspace(state, opened, null).uiState).toEqual({ [UiStateKey.ActiveWorkspaceId]: 'w2' })
  })
})

describe('the terminal', () => {
  it('takes the tabs from each change, whole', () => {
    const tabs = [sampleTerminalTab('a', { running: true })]
    expect(applyEvent(state, { type: EventType.TerminalTabsChanged, tabs }).terminalTabs).toBe(tabs)
  })

  it('leaves a tab’s output and clearing to its terminal, out of the store', () => {
    expect(applyEvent(state, { type: EventType.TerminalOutput, tabId: 'a', offset: 0, data: '$ ' })).toBe(state)
    expect(applyEvent(state, { type: EventType.TerminalCleared, tabId: 'a' })).toBe(state)
  })
})

describe('idFromUiState', () => {
  it('reads the empty string as no selection', () => {
    expect(idFromUiState('')).toBeNull()
    expect(idFromUiState('t1')).toBe('t1')
  })
})
