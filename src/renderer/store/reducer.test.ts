import { describe, expect, it } from 'vitest'
import { EventType } from '../../shared/bridge'
import { appCommand, AppCommandId } from '../../shared/commands'
import {
  ArtifactKind,
  DividerKind,
  PermissionMarkKind,
  PermissionRequestState,
  type PermissionMark,
  QuestionReplyKind,
  QuestionSetState,
  TodoState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherState,
  type Artifact,
  type TaskCommit,
  type TaskHandoff,
  type TodoList,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import { noOpenFiles } from '../../shared/files'
import { EMPTY_MENU_BAR_SNAPSHOT } from '../../shared/menuBar'
import { ChildFilter, ChildKind, FilingSource, UNFILED_TODO_ID, type Filing } from '../../shared/todoHub'
import {
  FolderAccess,
  SandboxAskKind,
  SandboxGrantKind,
  SandboxGrantScope,
  type SandboxFolderAsk,
} from '../../shared/sandbox'
import {
  applyEvent,
  idFromUiState,
  withHistory,
  withLiveWatchers,
  withOpenedWorkspace,
  withRunningSubagents,
  withTodoHub,
} from './reducer'
import { INITIAL_DATA, type GladeData } from './state'
import {
  sampleMessage,
  samplePermissionRequest,
  sampleQuestionSet,
  sampleQueuedMessage,
  sampleTask,
  sampleTerminalTab,
  sampleWatcher,
  sampleCommit,
  sampleWorkspace,
} from './test-bridge'

const state: GladeData = Object.freeze({
  ...INITIAL_DATA,
  workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
  tasks: { t1: sampleTask('t1', 'w1') },
})

describe('applyEvent', () => {
  it('leaves the state alone when main asks to open a task, which the store does by selecting it', () => {
    expect(applyEvent(state, { type: EventType.TaskOpenRequested, taskId: 't1', subagentId: null })).toBe(state)
  })

  it('leaves the state alone for a menu bar command, which the window runs', () => {
    expect(applyEvent(state, { type: EventType.MenuCommand, command: appCommand(AppCommandId.NewTask) })).toBe(state)
  })

  it("leaves the state alone for what's in flight, which only the menu bar popover is sent", () => {
    expect(applyEvent(state, { type: EventType.MenuBarChanged, snapshot: EMPTY_MENU_BAR_SNAPSHOT })).toBe(state)
  })

  it('keeps a scope’s sandbox grants as main broadcasts them, leaving the other scopes’ lists as they were (#451)', () => {
    const glade = [{ kind: SandboxGrantKind.Domain, domain: 'pypi.org' }] as const
    const listed = { ...state, sandboxGrants: { glade } }
    const granted = [
      { kind: SandboxGrantKind.Folder, path: '/Users/sam/code/acme-web', access: FolderAccess.ReadWrite },
    ] as const

    const next = applyEvent(listed, {
      type: EventType.SandboxGrantsChanged,
      target: { scope: SandboxGrantScope.Workspace, workspaceId: 'w1' },
      grants: granted,
    })

    expect(next.sandboxGrants).toEqual({ glade, 'workspace:w1': granted })
    // The untouched scope's list is the same array, so its rows don't redraw.
    expect(next.sandboxGrants.glade).toBe(glade)
    const emptied = applyEvent(next, {
      type: EventType.SandboxGrantsChanged,
      target: { scope: SandboxGrantScope.Glade },
      grants: [],
    })
    expect(emptied.sandboxGrants).toEqual({ glade: [], 'workspace:w1': granted })
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
  progressSummary: null,
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
      artifacts: {
        t1: [
          {
            kind: ArtifactKind.File,
            taskId: 't1',
            path: 'README.md',
            title: 'Readme',
            addedAt: 1,
            updatedAt: 1,
            modifiedAt: 1,
            missing: false,
          },
        ],
      },
      artifactsVersion: { t1: 1 },
      handoffs: { t1: { taskId: 't1', body: '## Where it got to', addedAt: 1 } },
      watchers: { t1: [sampleWatcher('w1', 't1')] },
      commits: { t1: [sampleCommit('c1', 't1')] },
      inputDrafts: { t1: { text: 'Half a thought', images: [], pastedBlocks: [], files: [] } },
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
      artifactsVersion: {},
      handoffs: {},
      watchers: {},
      commits: {},
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
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
    })

    expect(applyEvent(loaded, { type: EventType.ToolEventUpdated, toolEvent: done }).toolEvents).toEqual({
      t1: [divider, done],
    })
    expect(applyEvent(state, { type: EventType.ToolEventUpdated, toolEvent: done }).toolEvents).toBe(state.toolEvents)
  })

  it('evicts a tool event a refusal-fallback retry superseded, and is a no-op for a task with no log yet', () => {
    const loaded = withHistory(state, 't1', {
      messages: [],
      toolEvents: [divider, call],
      queuedMessages: [],
      questionSets: [],
      permissionRequests: [],
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
    })

    expect(
      applyEvent(loaded, { type: EventType.ToolEventRemoved, taskId: 't1', toolEventId: call.id }).toolEvents,
    ).toEqual({ t1: [divider] })
    const untouched = applyEvent(state, { type: EventType.ToolEventRemoved, taskId: 't9', toolEventId: 'gone' })
    expect(untouched.toolEvents).toBe(state.toolEvents)
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
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
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
        permissionMarks: [],
        openFiles: noOpenFiles('t2'),
        todos: null,
        artifacts: [],
        handoff: null,
        watchers: [],
        commits: [],
        agentTab: null,
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
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
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
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
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
      commits: [],
      agentTab: null,
    }
    // A request opened while the history loaded stays, after the loaded ones.
    const loaded = withHistory(asked, 't1', { ...empty, permissionRequests: [denied], permissionMarks: [] })
    expect(loaded.permissionRequests.t1?.map(({ id, state: closedState }) => [id, closedState])).toEqual([
      ['p1', PermissionRequestState.Denied],
      ['p2', PermissionRequestState.Open],
    ])
  })
})

describe("a task's permission marks", () => {
  const mark = (toolUseId: string, ask: SandboxFolderAsk | null = null, createdAt = 1): PermissionMark => ({
    taskId: 't1',
    toolUseId,
    outcome: { kind: PermissionMarkKind.Blocked, ask },
    createdAt,
  })
  const UV: SandboxFolderAsk = {
    kind: SandboxAskKind.Folder,
    path: '/Users/me/.cache/uv',
    access: FolderAccess.ReadWrite,
  }

  it('adds a call’s mark, replaces it in place when it changes, and keeps a newer one over a history load', () => {
    const marked = [mark('a'), mark('b'), mark('a', UV)].reduce(
      (data, one) => applyEvent(data, { type: EventType.PermissionMarked, mark: one }),
      state,
    )
    expect(marked.permissionMarks.t1).toEqual([mark('a', UV), mark('b')])

    const history = {
      messages: [],
      toolEvents: [],
      queuedMessages: [],
      questionSets: [],
      permissionRequests: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
    }
    // The load read `a` before it was named, and a call the window hadn't heard of; `b` came after the load was read.
    const loaded = withHistory(marked, 't1', { ...history, permissionMarks: [mark('earlier'), mark('a')] })
    expect(loaded.permissionMarks.t1).toEqual([mark('earlier'), mark('a', UV), mark('b')])
    expect(withHistory(state, 't1', { ...history, permissionMarks: [mark('a')] }).permissionMarks.t1).toEqual([
      mark('a'),
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
      permissionMarks: [],
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
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

  it('keeps nothing of a folder changing on disk: the Browse tab hears it from the store itself', () => {
    expect(applyEvent(state, { type: EventType.FolderChanged, taskId: 't1', path: 'docs' })).toBe(state)
  })
})

describe("a task's artifacts", () => {
  const artifact = (path: string, updatedAt: number, modifiedAt: number | null = null): Artifact => ({
    kind: ArtifactKind.File,
    taskId: 't1',
    path,
    title: path,
    addedAt: 1,
    updatedAt,
    modifiedAt,
    missing: false,
  })
  const history = (artifacts: readonly Artifact[]) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    permissionMarks: [],
    openFiles: noOpenFiles('t1'),
    todos: null,
    artifacts,
    handoff: null,
    watchers: [],
    commits: [],
    agentTab: null,
  })

  it('takes the whole list from each change, and from a history load that started at or after the last one', () => {
    const changed = applyEvent(state, {
      type: EventType.ArtifactsChanged,
      taskId: 't1',
      artifacts: [artifact('a.md', 5), artifact('b.md', 9)],
    })
    expect(changed.artifacts.t1?.map(({ title }) => title)).toEqual(['a.md', 'b.md'])
    expect(changed.artifactsVersion.t1).toBe(1)

    // Started before the change (version 0 of 1): the load is stale, so the change wins.
    expect(withHistory(changed, 't1', history([artifact('a.md', 5)]), 0).artifacts.t1).toHaveLength(2)
    // Started at the change's version: nothing has happened since it started, so the load wins.
    expect(withHistory(changed, 't1', history([artifact('a.md', 12)]), 1).artifacts.t1).toEqual([artifact('a.md', 12)])
    expect(withHistory(state, 't1', history([])).artifacts).toEqual({ t1: [] })
  })

  it("doesn't let a history load that started before an artifact was removed bring it back (#391)", () => {
    const declared = applyEvent(state, {
      type: EventType.ArtifactsChanged,
      taskId: 't1',
      artifacts: [artifact('a.md', 5), artifact('b.md', 5)],
    })
    const versionBeforeRemoval = declared.artifactsVersion.t1 ?? 0

    // The removal's own `artifacts.changed` lands first, dropping a.md. It doesn't bump b.md's own timestamp, so a
    // fix that compares the lists' content, rather than sequencing them, can't tell the removal happened at all.
    const removed = applyEvent(declared, {
      type: EventType.ArtifactsChanged,
      taskId: 't1',
      artifacts: [artifact('b.md', 5)],
    })

    // Only then does the history load that started before the removal answer, with the stale, longer list.
    const stale = history([artifact('a.md', 5), artifact('b.md', 5)])
    expect(withHistory(removed, 't1', stale, versionBeforeRemoval).artifacts.t1).toEqual([artifact('b.md', 5)])
  })

  it('counts a file seen to change as a newer list, whenever it was declared', () => {
    const changed = applyEvent(state, {
      type: EventType.ArtifactsChanged,
      taskId: 't1',
      artifacts: [artifact('a.png', 5, 40)],
    })

    expect(withHistory(changed, 't1', history([artifact('a.png', 5, 30)]), 0).artifacts.t1).toEqual([
      artifact('a.png', 5, 40),
    ])
    expect(withHistory(changed, 't1', history([artifact('a.png', 5, 50)]), 1).artifacts.t1).toEqual([
      artifact('a.png', 5, 50),
    ])
  })
})

describe("a task's watchers", () => {
  const history = (watchers: readonly Watcher[]) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    permissionMarks: [],
    openFiles: noOpenFiles('t1'),
    todos: null,
    artifacts: [],
    handoff: null,
    watchers,
    commits: [],
    agentTab: null,
  })

  it('takes every task’s live ones on start, by task, over none', () => {
    const live = [sampleWatcher('a', 't1'), sampleWatcher('b', 't2'), sampleWatcher('c', 't1')]
    expect(withLiveWatchers(state, live).watchers).toEqual({ t1: [live[0], live[2]], t2: [live[1]] })
    expect(withLiveWatchers(state, []).watchers).toEqual({})
  })

  it('takes the whole list from each change, and a task’s whole list, ended ones too, with its history', () => {
    const started = withLiveWatchers(state, [sampleWatcher('a', 't1')])
    const ended = sampleWatcher('b', 't1', { state: WatcherState.Finished })
    const loaded = withHistory(started, 't1', history([sampleWatcher('a', 't1'), ended]))
    expect(loaded.watchers.t1?.map(({ id }) => id)).toEqual(['a', 'b'])

    const changed = applyEvent(loaded, { type: EventType.WatchersChanged, taskId: 't1', watchers: [ended] })
    expect(changed.watchers).toEqual({ t1: [ended] })
    expect(applyEvent(changed, { type: EventType.WatchersChanged, taskId: 't2', watchers: [] }).watchers).toEqual({
      t1: [ended],
      t2: [],
    })
  })
})

describe("a task's watchers, as main sends the whole list with each change (#537)", () => {
  const ci = sampleWatcher('ci', 't1')
  const docs = sampleWatcher('docs', 't1', { state: WatcherState.Finished, outcome: 'It ended.' })
  const sent = (...watchers: readonly Watcher[]) => ({
    type: EventType.WatchersChanged as const,
    taskId: 't1',
    // Each made anew, as it comes over the bridge.
    watchers: watchers.map((watcher) => ({ ...watcher })),
  })
  const loaded = applyEvent(state, sent(ci, docs))

  it('keeps the object of each watcher that’s as it was, and takes the one that changed', () => {
    const reported = { ...ci, lastOutput: 'lint pass', wakes: 1 }
    const changed = applyEvent(loaded, sent(reported, docs))

    expect(changed.watchers.t1).toEqual([reported, docs])
    expect(changed.watchers.t1?.[0]).not.toBe(loaded.watchers.t1?.[0])
    expect(changed.watchers.t1?.[1]).toBe(loaded.watchers.t1?.[1])
  })

  it('keeps the whole list when nothing in it changed', () => {
    expect(applyEvent(loaded, sent(ci, docs)).watchers).toBe(loaded.watchers)
    expect(applyEvent(loaded, sent(ci, docs)).watchers.t1).toBe(loaded.watchers.t1)
  })

  it('takes a list with one more, one fewer or in another order, keeping the ones that are as they were', () => {
    const queue = sampleWatcher('queue', 't1', { state: WatcherState.Scheduled })
    const more = applyEvent(loaded, sent(ci, docs, queue))
    expect(more.watchers.t1).toEqual([ci, docs, queue])
    expect(more.watchers.t1?.[0]).toBe(loaded.watchers.t1?.[0])

    const fewer = applyEvent(more, sent(ci, queue))
    expect(fewer.watchers.t1).toEqual([ci, queue])
    expect(fewer.watchers.t1?.[1]).toBe(more.watchers.t1?.[2])

    const reordered = applyEvent(fewer, sent(queue, ci))
    expect(reordered.watchers.t1).toEqual([queue, ci])
    expect(reordered.watchers.t1).not.toBe(fewer.watchers.t1)
    expect(reordered.watchers.t1?.[1]).toBe(fewer.watchers.t1?.[0])
  })

  it('leaves another task’s list alone', () => {
    const other = applyEvent(loaded, { ...sent(sampleWatcher('x', 't2')), taskId: 't2' })
    expect(other.watchers.t1).toBe(loaded.watchers.t1)
    expect(other.watchers.t2?.map(({ id }) => id)).toEqual(['x'])
  })
})

describe("every task's running subagents", () => {
  const agent = (id: string, taskId: string): ToolCallEvent => ({
    ...call,
    id,
    taskId,
    name: 'Agent',
    toolUseId: `use-${id}`,
  })

  it('adds each task’s running subagents to its tool log on start, by task', () => {
    const calls = [agent('a', 't1'), agent('b', 't2'), agent('c', 't1')]
    expect(withRunningSubagents(state, calls).toolEvents).toEqual({ t1: [calls[0], calls[2]], t2: [calls[1]] })
    expect(withRunningSubagents(state, []).toolEvents).toEqual({})
  })

  it('keeps what a log already has, and adds a call it already has only once', () => {
    const logged = { ...state, toolEvents: { t1: [divider, agent('a', 't1')] } }
    expect(withRunningSubagents(logged, [agent('a', 't1'), agent('b', 't1')]).toolEvents).toEqual({
      t1: [divider, agent('a', 't1'), agent('b', 't1')],
    })
  })

  it('gives way to the task’s whole log once it loads, and follows the calls’ results before then', () => {
    const started = withRunningSubagents(state, [agent('a', 't1')])
    const finished = { ...agent('a', 't1'), state: ToolCallState.Done, output: 'Done.' }
    const updated = applyEvent(started, { type: EventType.ToolEventUpdated, toolEvent: finished })
    expect(updated.toolEvents.t1).toEqual([finished])

    const loaded = withHistory(started, 't1', {
      messages: [],
      toolEvents: [divider, finished],
      queuedMessages: [],
      questionSets: [],
      permissionRequests: [],
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [],
      handoff: null,
      watchers: [],
      commits: [],
      agentTab: null,
    })
    expect(loaded.toolEvents.t1).toEqual([divider, finished])
  })

  it('adds a subagent woken again to a task whose log has not loaded, for the task list to count, and only a running subagent (#395)', () => {
    const woken = agent('a', 't1')
    const updated = applyEvent(state, { type: EventType.ToolEventUpdated, toolEvent: woken })
    expect(updated.toolEvents).toEqual({ t1: [woken] })
    expect(updated.toolEvents.t1?.[0]).toMatchObject({ name: 'Agent', state: ToolCallState.Running })

    // It ends again, and its row follows.
    const ended = { ...woken, state: ToolCallState.Done, output: 'Fixed.' }
    const after = applyEvent(updated, { type: EventType.ToolEventUpdated, toolEvent: ended })
    expect(after.toolEvents).toEqual({ t1: [ended] })

    // A finished subagent, or another running call, it hasn't seen is left to the next load.
    expect(applyEvent(state, { type: EventType.ToolEventUpdated, toolEvent: ended }).toolEvents).toBe(state.toolEvents)
    const read = { ...call, id: 'r', state: ToolCallState.Running }
    expect(applyEvent(state, { type: EventType.ToolEventUpdated, toolEvent: read }).toolEvents).toBe(state.toolEvents)
    expect(applyEvent(state, { type: EventType.ToolEventUpdated, toolEvent: divider }).toolEvents).toBe(
      state.toolEvents,
    )
  })
})

describe("a task's commits", () => {
  const history = (commits: readonly TaskCommit[]) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    permissionMarks: [],
    openFiles: noOpenFiles('t1'),
    todos: null,
    artifacts: [],
    handoff: null,
    watchers: [],
    commits,
    agentTab: null,
  })

  it('takes a task’s whole list with its history, and from each change, each task’s its own', () => {
    const fix = sampleCommit('c1', 't1')
    const merge = sampleCommit('c2', 't1', { subject: 'Merge the upgrade guide', merge: true })
    const loaded = withHistory(state, 't1', history([fix]))
    expect(loaded.commits).toEqual({ t1: [fix] })

    const changed = applyEvent(loaded, { type: EventType.CommitsChanged, taskId: 't1', commits: [merge, fix] })
    expect(changed.commits).toEqual({ t1: [merge, fix] })
    expect(applyEvent(changed, { type: EventType.CommitsChanged, taskId: 't2', commits: [] }).commits).toEqual({
      t1: [merge, fix],
      t2: [],
    })
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
    permissionMarks: [],
    openFiles: noOpenFiles('t1'),
    todos: null,
    artifacts: [],
    handoff,
    watchers: [],
    commits: [],
    agentTab: null,
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
    items: [{ id: '1', text, state: TodoState.Todo, note: null, completedAt: null }],
    updatedAt,
  })
  const history = (todos: TodoList | null) => ({
    messages: [],
    toolEvents: [],
    queuedMessages: [],
    questionSets: [],
    permissionRequests: [],
    permissionMarks: [],
    openFiles: noOpenFiles('t1'),
    todos,
    artifacts: [],
    handoff: null,
    watchers: [],
    commits: [],
    agentTab: null,
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

describe('the todo hub’s filings (P16)', () => {
  const filing = (kind: ChildKind, key: string, todoId: string, filedAt = 1): Filing => ({
    taskId: 't1',
    kind,
    key,
    todoId,
    source: FilingSource.Named,
    filedAt,
  })
  const PLAN = filing(ChildKind.File, 'docs/plan.md', '1')
  const PR = filing(ChildKind.Link, 'https://example.com/acme/api/pull/511', '1')
  const GROUPS = { todos: [], unfiled: { todoId: UNFILED_TODO_ID, children: [], tallies: {} } } as never
  const loaded = withTodoHub(state, 't1', { children: GROUPS, filings: [PLAN, PR], panels: [] })

  it('keeps a task’s filings and its todos’ panels as loaded, by todo', () => {
    const panel = { taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Links }
    const unfiled = { taskId: 't1', todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.All }
    const hub = withTodoHub(state, 't1', { children: GROUPS, filings: [PLAN], panels: [panel, unfiled] })

    expect(hub.filings).toEqual({ t1: [PLAN] })
    expect(hub.todoPanels).toEqual({ t1: { '1': panel, [UNFILED_TODO_ID]: unfiled } })
  })

  it('keeps the panels the window already has when the hub is loaded again: only this window changes them', () => {
    const mine = { taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Commits }
    const earlier = { ...loaded, todoPanels: { t1: { '1': mine } } }
    const stale = { taskId: 't1', todoId: '1', open: false, filter: ChildFilter.Links }

    const again = withTodoHub(earlier, 't1', { children: GROUPS, filings: [PR], panels: [stale] })

    expect(again.todoPanels.t1).toEqual({ '1': mine })
    expect(again.filings.t1).toEqual([PR])
  })

  it('keeps nothing for a task deleted while its hub loaded', () => {
    expect(withTodoHub(state, 'gone', { children: GROUPS, filings: [PLAN], panels: [] })).toBe(state)
  })

  it('adds a filing made, and moves a child whose filing was replaced, leaving the rest as they were', () => {
    const subagent = filing(ChildKind.Subagent, 'toolu_9', '2', 5)
    const moved = { ...PLAN, todoId: '2', source: FilingSource.Moved, filedAt: 6 }

    const next = applyEvent(loaded, {
      type: EventType.FilingsChanged,
      taskId: 't1',
      filed: [subagent, moved],
      removed: [],
    })

    expect(next.filings.t1).toEqual([PR, subagent, moved])
    expect(next.filingsVersion.t1).toBe(1)
  })

  it('drops the filing of a child that lost it, and only that child’s', () => {
    const removed = [{ kind: ChildKind.Link, key: PR.key }]
    const next = applyEvent(loaded, { type: EventType.FilingsChanged, taskId: 't1', filed: [], removed })
    expect(next.filings.t1).toEqual([PLAN])
    // A file with a link's key is another child.
    const other = [{ kind: ChildKind.File, key: PR.key }]
    expect(
      applyEvent(loaded, { type: EventType.FilingsChanged, taskId: 't1', filed: [], removed: other }).filings.t1,
    ).toEqual([PLAN, PR])
  })

  it('keeps no filings for a task whose hub hasn’t been loaded, but counts the change, so a load on its way reads again', () => {
    const next = applyEvent(state, { type: EventType.FilingsChanged, taskId: 't1', filed: [PLAN], removed: [] })
    expect(next.filings).toEqual({})
    expect(next.filingsVersion).toEqual({ t1: 1 })
    const again = applyEvent(next, { type: EventType.FilingsChanged, taskId: 't1', filed: [PR], removed: [] })
    expect(again.filingsVersion).toEqual({ t1: 2 })
  })

  it('forgets a deleted task’s filings, their count and its panels', () => {
    const panel = { taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }
    const counted = applyEvent(
      { ...loaded, todoPanels: { t1: { '1': panel } } },
      { type: EventType.FilingsChanged, taskId: 't1', filed: [], removed: [] },
    )

    const next = applyEvent(counted, { type: EventType.TaskDeleted, taskId: 't1' })

    expect(next.filings).toEqual({})
    expect(next.filingsVersion).toEqual({})
    expect(next.todoPanels).toEqual({})
  })
})
