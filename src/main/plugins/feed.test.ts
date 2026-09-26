// The plugin feed on a real database: its snapshot, and each event type in `docs/plugin-api.md` from the events main
// emits. Every event the feed sends is checked against the strict schema on its way out, so a field outside it fails.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  DividerKind,
  Effort,
  PermissionRequestState,
  QuestionKind,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type PermissionRequest,
  type QuestionSet,
  type Task,
  type ToolCallEvent,
  type ToolInput,
  type Workspace,
} from '../../shared/domain'
import {
  PluginEventType,
  PluginPermissionOutcome,
  PluginQuestionOutcome,
  PluginSubagentState,
  PluginTaskActivity,
  PluginTaskState,
  PluginToolCallState,
  PluginWaitingOn,
  type PluginChangeEvent,
  type PluginSnapshotEvent,
  type PluginTask,
} from '../../shared/plugin-api'
import { pluginEventSchema } from '../../shared/plugin-api-schema'
import {
  appendPermissionRequest,
  closePermissionRequest,
  type NewPermissionRequest,
} from '../db/repositories/permission-requests'
import { appendQuestionSet, closeQuestionSet } from '../db/repositories/question-sets'
import { createTask, listTasks, updateTask } from '../db/repositories/tasks'
import { appendNarration, appendToolCall, setSubagentProgress, updateToolCall } from '../db/repositories/tool-events'
import { createWorkspace, listWorkspaces, updateWorkspace } from '../db/repositories/workspaces'
import { openTestDatabase, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog } from '../logging/memory-sink'
import { createPluginFeed, type PluginFeed, type PluginFeedSource, type PluginSink } from './feed'
import { databaseFeedSource } from './feed-source'

type Sent = PluginSnapshotEvent | PluginChangeEvent

let database: TestDatabase
let acme: Workspace
let billing: Workspace
let feed: PluginFeed
let sent: Sent[]

beforeEach(() => {
  database = openTestDatabase()
  acme = createWorkspace(database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  billing = createWorkspace(database.db, { name: 'Billing', rootPath: '/code/billing' }, 1_000)
  sent = []
})

afterEach(() => {
  database.close()
})

function allTasks(): Task[] {
  return listWorkspaces(database.db).flatMap((workspace) => listTasks(database.db, workspace.id))
}

/** Starts the feed as the app does, on every task there is now. */
function start(source: PluginFeedSource = databaseFeedSource(database.db)): void {
  feed = createPluginFeed({ source, tasks: allTasks() })
}

/** A sink that checks each event against the strict schema, then keeps it. */
function sinkInto(into: Sent[]): PluginSink {
  return (event) => {
    expect(pluginEventSchema.parse(event)).toEqual(event)
    into.push(event)
  }
}

/** Starts the feed and subscribes to it; answers with the snapshot, which `sent` doesn't keep. */
function listen(): PluginSnapshotEvent {
  start()
  feed.subscribe(sinkInto(sent))
  const snapshot = sent.shift()
  if (snapshot?.type !== PluginEventType.Snapshot) throw new Error('No snapshot came first')
  return snapshot
}

function emit(event: GladeEvent): void {
  feed.observe(event)
}

function newTask(workspace: Workspace = acme, now = 2_000): Task {
  return createTask(database.db, { workspaceId: workspace.id, model: 'claude-sample-1', effort: Effort.Medium }, now)
}

/** Changes a task in the database and emits it, as main does. */
function changed(task: Task, patch: Parameters<typeof updateTask>[2], now = 3_000): Task {
  const updated = updateTask(database.db, task.id, patch, now)
  emit({ type: EventType.TaskUpdated, task: updated })
  return updated
}

function asPlugin(task: Task, workspace: Workspace, overrides: Partial<PluginTask> = {}): PluginTask {
  return {
    id: task.id,
    workspaceId: workspace.id,
    workspaceName: workspace.name,
    title: task.title,
    status: task.status,
    state: PluginTaskState.Active,
    activity: PluginTaskActivity.Waiting,
    needsYou: false,
    waitingOn: null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    doneAt: null,
    ...overrides,
  }
}

interface CallOptions {
  readonly parent?: string | null
  readonly at?: number
}

/** Appends a running tool call to a task's log and emits it. */
function started(
  task: Task,
  toolUseId: string,
  name: string,
  input: ToolInput,
  options: CallOptions = {},
): ToolCallEvent {
  const call = appendToolCall(
    database.db,
    { taskId: task.id, turn: 1, name, input, toolUseId, parentToolUseId: options.parent ?? null },
    options.at ?? 5_000,
  )
  emit({ type: EventType.ToolEventAppended, toolEvent: call })
  return call
}

/** Finishes a tool call and emits it. */
function ended(task: Task, toolUseId: string, state = ToolCallState.Done, output = 'ok', at = 6_000): ToolCallEvent {
  const call = updateToolCall(database.db, { taskId: task.id, toolUseId, state, output }, at)
  emit({ type: EventType.ToolEventUpdated, toolEvent: call })
  return call
}

function noted(task: Task, text: string, parent: string | null = null, at = 5_500): NarrationEvent {
  const note = appendNarration(database.db, { taskId: task.id, turn: 1, text, parentToolUseId: parent }, at)
  emit({ type: EventType.ToolEventAppended, toolEvent: note })
  return note
}

function asked(task: Task, prompts: readonly string[], at = 7_000): QuestionSet {
  const set = appendQuestionSet(
    database.db,
    {
      taskId: task.id,
      turn: 1,
      questions: prompts.map((prompt) => ({ kind: QuestionKind.Pills, prompt, options: ['Yes', 'No'] })),
    },
    at,
  )
  emit({ type: EventType.QuestionOpened, questionSet: set })
  return set
}

function permissionFor(task: Task, toolUseId: string, agentId: string | null = null): NewPermissionRequest {
  return {
    taskId: task.id,
    turn: 1,
    toolUseId,
    agentId,
    toolName: 'Bash',
    input: { command: 'npm publish', description: 'Publish the package' },
    title: 'Claude wants to run npm publish',
    displayName: 'Bash',
    description: 'Publish the package',
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
  }
}

function requested(task: Task, toolUseId: string, agentId: string | null = null, at = 8_000): PermissionRequest {
  const request = appendPermissionRequest(database.db, permissionFor(task, toolUseId, agentId), at)
  emit({ type: EventType.PermissionOpened, permissionRequest: request })
  return request
}

describe('the snapshot', () => {
  it('holds every active task in every workspace, their running subagents, open questions and permission requests', () => {
    const working = newTask(acme)
    const billed = newTask(billing, 2_500)
    const finished = newTask(acme)
    const pinnedDone = newTask(billing)
    updateTask(database.db, working.id, { title: 'Fix the date bug', status: 'Running the tests.' }, 3_000)
    updateTask(database.db, working.id, { activity: TaskActivity.Working, sessionId: 'session-1' }, 3_100)
    updateTask(database.db, finished.id, { state: TaskState.Done, status: 'Shipped.' }, 3_000)
    updateTask(database.db, pinnedDone.id, { state: TaskState.Done, pinned: true }, 3_000)
    // A running subagent, with what it last did; one that's done, and one in a done task, which aren't sent.
    appendToolCall(database.db, call(working, 'toolu_a', 'Agent', { description: 'Sort the API PRs' }), 4_000)
    appendNarration(database.db, { taskId: working.id, turn: 1, text: 'Reading PRs.', parentToolUseId: 'toolu_a' })
    appendToolCall(
      database.db,
      call(working, 'toolu_a1', 'Read', { file_path: '/code/acme-api/src/date.ts' }, 'toolu_a'),
      4_100,
    )
    appendToolCall(database.db, call(working, 'toolu_b', 'Agent', { description: 'Check links' }), 4_000)
    updateToolCall(database.db, { taskId: working.id, toolUseId: 'toolu_b', state: ToolCallState.Done, output: 'ok' })
    appendToolCall(database.db, call(finished, 'toolu_c', 'Agent', { description: 'Old' }), 4_000)
    appendToolCall(database.db, call(working, 'toolu_a2', 'Bash', { command: 'npm test' }, 'toolu_a'), 4_200)
    // An open question set and a closed one; an open request from the subagent, and a closed one.
    const open = appendQuestionSet(database.db, pills(billed, ['Which branch?', 'Squash?']), 7_000)
    const closed = appendQuestionSet(database.db, pills(billed, ['Old?']), 6_000)
    closeQuestionSet(database.db, closed.id, { state: QuestionSetState.Withdrawn })
    const request = appendPermissionRequest(database.db, permissionFor(working, 'toolu_a2', 'agent-a'), 8_000)
    const old = appendPermissionRequest(database.db, permissionFor(working, 'toolu_x'), 7_500)
    closePermissionRequest(database.db, old.id, { state: PermissionRequestState.Allowed })
    appendQuestionSet(database.db, pills(finished, ['Done already?']), 7_000)

    const snapshot = listen()

    expect(snapshot.tasks).toEqual([
      asPlugin(working, acme, {
        title: 'Fix the date bug',
        status: 'Running the tests.',
        activity: PluginTaskActivity.Working,
        needsYou: true,
        waitingOn: PluginWaitingOn.Permission,
        updatedAt: 3_100,
      }),
      asPlugin(billed, billing, { waitingOn: PluginWaitingOn.Question }),
    ])
    expect(snapshot.subagents).toEqual([
      {
        id: 'toolu_a',
        taskId: working.id,
        name: 'Sort the API PRs',
        state: PluginSubagentState.Running,
        latest: 'Bash npm test',
        startedAt: 4_000,
        endedAt: null,
      },
    ])
    expect(snapshot.questions).toEqual([
      { taskId: billed.id, questionSetId: open.id, prompts: ['Which branch?', 'Squash?'], openedAt: 7_000 },
    ])
    expect(snapshot.permissions).toEqual([
      {
        taskId: working.id,
        requestId: request.id,
        subagentId: 'toolu_a',
        tool: 'Bash',
        summary: 'npm publish',
        openedAt: 8_000,
      },
    ])
  })

  it('is empty with no tasks', () => {
    expect(listen()).toEqual({
      type: PluginEventType.Snapshot,
      tasks: [],
      subagents: [],
      questions: [],
      permissions: [],
    })
  })

  it('leaves out a task marked done, and has one reopened', () => {
    const task = newTask()
    listen()
    changed(task, { state: TaskState.Done })

    const later: Sent[] = []
    feed.subscribe(sinkInto(later))
    expect(later).toEqual([
      { type: PluginEventType.Snapshot, tasks: [], subagents: [], questions: [], permissions: [] },
    ])

    changed(task, { state: TaskState.Active }, 4_000)
    const again: Sent[] = []
    feed.subscribe(sinkInto(again))
    expect(again[0]).toMatchObject({ tasks: [{ id: task.id, state: PluginTaskState.Active }] })
  })
})

/** A new tool call in a task, as `appendToolCall` takes it. */
function call(task: Task, toolUseId: string, name: string, input: ToolInput, parent: string | null = null) {
  return { taskId: task.id, turn: 1, name, input, toolUseId, parentToolUseId: parent }
}

function pills(task: Task, prompts: readonly string[]) {
  return {
    taskId: task.id,
    turn: 1,
    questions: prompts.map((prompt) => ({ kind: QuestionKind.Pills as const, prompt, options: ['Yes', 'No'] })),
  }
}

describe('task events', () => {
  it('sends task.created for a new task, in any workspace', () => {
    listen()
    const first = newTask(acme)
    emit({ type: EventType.TaskUpdated, task: first })
    const second = newTask(billing)
    emit({ type: EventType.TaskUpdated, task: second })

    expect(sent).toEqual([
      { type: PluginEventType.TaskCreated, task: asPlugin(first, acme) },
      { type: PluginEventType.TaskCreated, task: asPlugin(second, billing) },
    ])
  })

  it('sends task.updated when its title, status, activity, state or what it waits on changes', () => {
    const task = newTask()
    listen()

    changed(task, { title: 'Fix the date bug' })
    changed(task, { status: 'Reading the code.' })
    changed(task, { activity: TaskActivity.Working, sessionId: 'session-1' }, 3_100)
    changed(task, { activity: TaskActivity.Waiting }, 3_200)
    emit({ type: EventType.TaskUpdated, task: { ...updateTask(database.db, task.id, {}, 3_200), asking: true } })
    const done = changed(task, { state: TaskState.Done, status: 'Fixed.' }, 3_300)

    expect(sent.map((event) => event.type)).toEqual(Array(6).fill(PluginEventType.TaskUpdated))
    expect(sent.map((event) => (event.type === PluginEventType.TaskUpdated ? event.task : null))).toMatchObject([
      { title: 'Fix the date bug', updatedAt: 3_000 },
      { status: 'Reading the code.' },
      { activity: PluginTaskActivity.Working, needsYou: false },
      { activity: PluginTaskActivity.Waiting, needsYou: true, waitingOn: null },
      { needsYou: true, waitingOn: PluginWaitingOn.Question },
      { state: PluginTaskState.Done, status: 'Fixed.', needsYou: false, doneAt: done.doneAt, updatedAt: 3_300 },
    ])
  })

  it("sends nothing when only what a plugin doesn't see changes: unread, pinned, model, context, objective", () => {
    const task = newTask()
    listen()
    // Its updatedAt alone changing (its session starting, here) isn't a change either.
    changed(task, { contextUsedTokens: 500 }, 2_500)

    changed(task, { unread: true })
    const pinned = updateTask(database.db, task.id, { pinned: true, objective: 'Something' }, 2_000)
    emit({ type: EventType.TaskUpdated, task: pinned })
    emit({ type: EventType.TaskUpdated, task: { ...pinned, contextUsedTokens: 1_000, model: 'claude-other' } })
    emit({ type: EventType.TaskUpdated, task: pinned })

    expect(sent).toEqual([])
  })

  it('sends task.updated for a done task that changes, though no snapshot had it', () => {
    const task = newTask()
    updateTask(database.db, task.id, { state: TaskState.Done }, 2_500)
    listen()

    const reopened = changed(task, { state: TaskState.Active }, 4_000)

    expect(sent).toEqual([{ type: PluginEventType.TaskUpdated, task: asPlugin(reopened, acme, { updatedAt: 4_000 }) }])
  })

  it('sends task.deleted, and task.updated to every task of a renamed workspace', () => {
    const first = newTask(acme)
    const second = newTask(acme)
    const other = newTask(billing)
    listen()

    emit({ type: EventType.WorkspaceUpdated, workspace: updateWorkspace(database.db, acme.id, { name: 'Acme' }) })
    emit({ type: EventType.WorkspaceUpdated, workspace: updateWorkspace(database.db, billing.id, {}) })
    emit({ type: EventType.TaskDeleted, taskId: other.id })

    expect(sent).toHaveLength(3)
    expect(sent.slice(0, 2)).toEqual(
      expect.arrayContaining([
        { type: PluginEventType.TaskUpdated, task: asPlugin(first, acme, { workspaceName: 'Acme' }) },
        { type: PluginEventType.TaskUpdated, task: asPlugin(second, acme, { workspaceName: 'Acme' }) },
      ]),
    )
    expect(sent[2]).toEqual({ type: PluginEventType.TaskDeleted, taskId: other.id })
  })

  it("names a task's workspace when the workspace is new to it", () => {
    listen()
    const added = createWorkspace(database.db, { name: 'Docs site', rootPath: '/code/docs' }, 1_000)
    const task = newTask(added)
    emit({ type: EventType.TaskUpdated, task })
    const orphan = { ...newTask(acme), id: 'orphan', workspaceId: 'gone' }
    emit({ type: EventType.TaskUpdated, task: orphan })
    emit({ type: EventType.WorkspaceUpdated, workspace: { ...added, name: 'Docs' } })

    expect(sent).toEqual([
      { type: PluginEventType.TaskCreated, task: asPlugin(task, added) },
      {
        type: PluginEventType.TaskCreated,
        task: asPlugin(orphan, acme, { id: 'orphan', workspaceId: 'gone', workspaceName: '' }),
      },
      { type: PluginEventType.TaskUpdated, task: asPlugin(task, added, { workspaceName: 'Docs' }) },
    ])
  })

  it('cuts a long title, status and workspace name to 200 characters', () => {
    listen()
    const long = createWorkspace(database.db, { name: 'w'.repeat(300), rootPath: '/code/long' }, 1_000)
    const task = newTask(long)
    emit({ type: EventType.TaskUpdated, task })
    changed(task, { title: 't'.repeat(500), status: `${'s'.repeat(199)}😺😺` })

    expect(sent.at(-1)).toMatchObject({
      task: { title: 't'.repeat(200), status: 's'.repeat(199), workspaceName: 'w'.repeat(200) },
    })
  })
})

describe('agent events', () => {
  let task: Task

  beforeEach(() => {
    task = newTask()
    listen()
  })

  it('sends agent.toolCall when a call starts and again when it ends, with its summary', () => {
    started(task, 'toolu_1', 'Edit', { file_path: '/code/acme-api/src/date.ts', old_string: 'a', new_string: 'b' })
    ended(task, 'toolu_1')
    started(task, 'toolu_2', 'Bash', { command: 'npm test\n  -- --watch=false', description: 'Run the tests' })
    ended(task, 'toolu_2', ToolCallState.Error, 'FAIL')

    expect(sent).toEqual([
      {
        type: PluginEventType.AgentToolCall,
        call: {
          id: 'toolu_1',
          taskId: task.id,
          subagentId: null,
          tool: 'Edit',
          summary: 'src/date.ts',
          state: PluginToolCallState.Running,
          startedAt: 5_000,
          endedAt: null,
        },
      },
      {
        type: PluginEventType.AgentToolCall,
        call: expect.objectContaining({ id: 'toolu_1', state: PluginToolCallState.Done, endedAt: 6_000 }) as unknown,
      },
      {
        type: PluginEventType.AgentToolCall,
        call: expect.objectContaining({ id: 'toolu_2', tool: 'Bash', summary: 'npm test' }) as unknown,
      },
      {
        type: PluginEventType.AgentToolCall,
        call: expect.objectContaining({ id: 'toolu_2', state: PluginToolCallState.Failed }) as unknown,
      },
    ])
  })

  it.each([
    [ToolCallState.Paused, PluginToolCallState.Interrupted, PluginSubagentState.Stopped],
    [ToolCallState.Interrupted, PluginToolCallState.Interrupted, PluginSubagentState.Stopped],
    [ToolCallState.Error, PluginToolCallState.Failed, PluginSubagentState.Failed],
    [ToolCallState.Done, PluginToolCallState.Done, PluginSubagentState.Done],
  ])('maps a call that ends %s to %s, and its subagent to %s', (state, callState, subagentState) => {
    started(task, 'toolu_s', 'Agent', { description: 'Sort the PRs' })
    ended(task, 'toolu_s', state)

    expect(sent.at(-2)).toMatchObject({ call: { state: callState } })
    expect(sent.at(-1)).toMatchObject({ type: PluginEventType.SubagentUpdated, subagent: { state: subagentState } })
  })

  it("names Glade's own tools as the tool log does, and gives no summary for tools whose input could hold anything", () => {
    started(task, 'toolu_1', 'mcp__glade__set_status', { status: 'Reading the code.' })
    started(task, 'toolu_2', 'mcp__github__create_issue', { title: 'Bug', body: 'Details' })
    started(task, 'toolu_3', 'TodoWrite', { todos: [{ content: 'Fix it' }] })
    started(task, 'toolu_4', 'Grep', { pattern: 'formatDate', path: '/code/acme-api' })
    started(task, 'toolu_5', 'Read', { file_path: '/etc/hosts' })
    started(task, 'toolu_6', 'WebFetch', { url: 'https://example.com/docs', prompt: 'Summarise' })
    started(task, 'toolu_7', 'Bash', { command: 42 })

    expect(sent.map((event) => (event.type === PluginEventType.AgentToolCall ? event.call : null))).toMatchObject([
      { tool: 'set_status', summary: '' },
      { tool: 'mcp__github__create_issue', summary: '' },
      { tool: 'TodoWrite', summary: '' },
      { tool: 'Grep', summary: 'formatDate' },
      { tool: 'Read', summary: '/etc/hosts' },
      { tool: 'WebFetch', summary: 'https://example.com/docs' },
      { tool: 'Bash', summary: '' },
    ])
  })

  it('cuts a long command to 200 characters', () => {
    started(task, 'toolu_1', 'Bash', { command: `echo ${'x'.repeat(400)}` })

    expect(sent[0]).toMatchObject({ call: { summary: `echo ${'x'.repeat(195)}` } })
  })

  it("sends agent.note for the agent's notes and a subagent's, not blank ones, and not a note that changes", () => {
    started(task, 'toolu_s', 'Agent', { subagent_type: 'general-purpose' })
    sent.length = 0
    const note = noted(task, "  I'll find where the date is formatted.  ")
    noted(task, 'Reading the PRs.', 'toolu_s', 5_600)
    noted(task, '   ')
    emit({ type: EventType.ToolEventUpdated, toolEvent: note })

    expect(sent).toEqual([
      {
        type: PluginEventType.AgentNote,
        taskId: task.id,
        subagentId: null,
        text: "I'll find where the date is formatted.",
        at: 5_500,
      },
      { type: PluginEventType.AgentNote, taskId: task.id, subagentId: 'toolu_s', text: 'Reading the PRs.', at: 5_600 },
      {
        type: PluginEventType.SubagentUpdated,
        subagent: expect.objectContaining({
          id: 'toolu_s',
          name: 'general-purpose',
          latest: 'Reading the PRs.',
        }) as unknown,
      },
    ])
  })

  it("sends nothing when a running subagent's progress summary changes: plugins aren't told it", () => {
    const agent = started(task, 'toolu_s', 'Agent', { description: 'Sort the PRs', prompt: 'Sort them' })
    sent.length = 0
    const progress = { taskId: task.id, toolUseId: agent.toolUseId, summary: 'Sorting 14 PRs into features' }
    emit({ type: EventType.ToolEventUpdated, toolEvent: setSubagentProgress(database.db, progress) ?? agent })

    expect(sent).toEqual([])
    ended(task, 'toolu_s', ToolCallState.Done, 'Three features.')
    expect(sent.map((event) => event.type)).toEqual([PluginEventType.AgentToolCall, PluginEventType.SubagentUpdated])
  })

  it('sends nothing for dividers and compactions', () => {
    emit({
      type: EventType.ToolEventAppended,
      toolEvent: {
        kind: ToolEventKind.Divider,
        id: 'd',
        taskId: task.id,
        turn: 1,
        createdAt: 1,
        dividerKind: DividerKind.Turn,
      },
    })

    expect(sent).toEqual([])
  })

  it('follows a turn with parallel tool calls and a subagent, nested subagents included', () => {
    started(task, 'toolu_r', 'Read', { file_path: '/code/acme-api/a.ts' })
    started(task, 'toolu_g', 'Grep', { pattern: 'todo' })
    started(task, 'toolu_s', 'Agent', { description: 'Sort the PRs', prompt: 'Sort them' })
    ended(task, 'toolu_g')
    started(task, 'toolu_s1', 'Bash', { command: 'gh pr list' }, { parent: 'toolu_s' })
    started(task, 'toolu_n', 'Agent', { description: 'Read one PR' }, { parent: 'toolu_s' })
    started(task, 'toolu_n1', 'Read', { file_path: '/code/acme-api/b.ts' }, { parent: 'toolu_n' })
    ended(task, 'toolu_r')
    ended(task, 'toolu_n1')
    ended(task, 'toolu_n', ToolCallState.Done, 'It adds rate limits.')
    ended(task, 'toolu_s1')
    ended(task, 'toolu_s', ToolCallState.Done, 'Three features, two fixes.', 9_000)

    const summary = sent.map((event) => {
      switch (event.type) {
        case PluginEventType.AgentToolCall:
          return `call ${event.call.id} ${event.call.state} in ${String(event.call.subagentId)}`
        case PluginEventType.SubagentStarted:
        case PluginEventType.SubagentUpdated:
          return `${event.type} ${event.subagent.id} ${event.subagent.state}: ${String(event.subagent.latest)}`
        case PluginEventType.Snapshot:
        case PluginEventType.TaskCreated:
        case PluginEventType.TaskUpdated:
        case PluginEventType.TaskDeleted:
        case PluginEventType.AgentNote:
        case PluginEventType.QuestionOpened:
        case PluginEventType.QuestionClosed:
        case PluginEventType.PermissionOpened:
        case PluginEventType.PermissionClosed:
          return event.type
      }
    })
    expect(summary).toEqual([
      'call toolu_r running in null',
      'call toolu_g running in null',
      'call toolu_s running in null',
      'subagent.started toolu_s running: null',
      'call toolu_g done in null',
      'subagent.updated toolu_s running: Bash gh pr list',
      'call toolu_s1 running in toolu_s',
      'subagent.updated toolu_s running: Agent Read one PR',
      'call toolu_n running in toolu_s',
      'subagent.started toolu_n running: null',
      'subagent.updated toolu_n running: Read b.ts',
      'call toolu_n1 running in toolu_n',
      'call toolu_r done in null',
      'call toolu_n1 done in toolu_n',
      'call toolu_n done in toolu_s',
      // What a subagent came to is a tool result: its latest line stays what it last did.
      'subagent.updated toolu_n done: Read b.ts',
      'call toolu_s1 done in toolu_s',
      'call toolu_s done in null',
      'subagent.updated toolu_s done: Agent Read one PR',
    ])
    expect(sent.at(-1)).toMatchObject({ subagent: { name: 'Sort the PRs', startedAt: 5_000, endedAt: 9_000 } })
  })

  it('sends question.opened with the prompts only, and question.closed once it is answered or withdrawn', () => {
    const first = asked(task, ['Which layout?', 'Credit contributors?'])
    const answered = closeQuestionSet(database.db, first.id, {
      state: QuestionSetState.Answered,
      reply: { kind: QuestionReplyKind.FreeText, text: 'By type, and yes' },
    })
    emit({ type: EventType.QuestionAnswered, questionSet: answered ?? first })
    const second = asked(task, ['Squash?'], 8_000)
    const withdrawn = closeQuestionSet(database.db, second.id, { state: QuestionSetState.Withdrawn })
    emit({ type: EventType.QuestionWithdrawn, questionSet: withdrawn ?? second })
    // Closed twice, or never opened for this plugin: nothing.
    emit({ type: EventType.QuestionWithdrawn, questionSet: withdrawn ?? second })

    expect(sent).toEqual([
      {
        type: PluginEventType.QuestionOpened,
        question: {
          taskId: task.id,
          questionSetId: first.id,
          prompts: ['Which layout?', 'Credit contributors?'],
          openedAt: 7_000,
        },
      },
      {
        type: PluginEventType.QuestionClosed,
        taskId: task.id,
        questionSetId: first.id,
        outcome: PluginQuestionOutcome.Answered,
      },
      {
        type: PluginEventType.QuestionOpened,
        question: { taskId: task.id, questionSetId: second.id, prompts: ['Squash?'], openedAt: 8_000 },
      },
      {
        type: PluginEventType.QuestionClosed,
        taskId: task.id,
        questionSetId: second.id,
        outcome: PluginQuestionOutcome.Withdrawn,
      },
    ])
  })

  it('cuts a long prompt to 200 characters', () => {
    asked(task, ['q'.repeat(1_000)])

    expect(sent[0]).toMatchObject({ question: { prompts: ['q'.repeat(200)] } })
  })

  it.each([
    [{ state: PermissionRequestState.Allowed } as const, PluginPermissionOutcome.Allowed],
    [{ state: PermissionRequestState.Denied, note: 'Not yet' } as const, PluginPermissionOutcome.Denied],
    [{ state: PermissionRequestState.Withdrawn } as const, PluginPermissionOutcome.Withdrawn],
  ])('sends permission.opened and permission.closed %#', (closing, outcome) => {
    const request = requested(task, 'toolu_p')
    const closed = closePermissionRequest(database.db, request.id, closing)
    const type =
      closing.state === PermissionRequestState.Withdrawn ? EventType.PermissionWithdrawn : EventType.PermissionAnswered
    emit({ type, permissionRequest: closed ?? request })
    emit({ type, permissionRequest: closed ?? request })

    expect(sent).toEqual([
      {
        type: PluginEventType.PermissionOpened,
        request: {
          taskId: task.id,
          requestId: request.id,
          subagentId: null,
          tool: 'Bash',
          summary: 'npm publish',
          openedAt: 8_000,
        },
      },
      { type: PluginEventType.PermissionClosed, taskId: task.id, requestId: request.id, outcome },
    ])
  })

  it("names the subagent a permission request's call was made in, and none when it isn't known", () => {
    started(task, 'toolu_s', 'Agent', { description: 'Publish' })
    started(task, 'toolu_s1', 'Bash', { command: 'npm publish' }, { parent: 'toolu_s' })
    sent.length = 0
    requested(task, 'toolu_s1', 'agent-1')
    requested(task, 'toolu_unknown', 'agent-2')
    // The same open request again (a plugin already told of it) sends nothing.
    emit({ type: EventType.PermissionOpened, permissionRequest: requested(task, 'toolu_x') })

    expect(
      sent.map((event) => (event.type === PluginEventType.PermissionOpened ? event.request.subagentId : null)),
    ).toEqual(['toolu_s', null, null])
  })

  it("forgets a deleted task's subagents, questions and requests", () => {
    started(task, 'toolu_s', 'Agent', { description: 'Sort' })
    const set = asked(task, ['Which?'])
    const request = requested(task, 'toolu_p')
    emit({ type: EventType.TaskDeleted, taskId: task.id })
    sent.length = 0

    emit({ type: EventType.QuestionWithdrawn, questionSet: { ...set, state: QuestionSetState.Withdrawn } })
    emit({
      type: EventType.PermissionWithdrawn,
      permissionRequest: { ...request, state: PermissionRequestState.Withdrawn },
    })
    started(task, 'toolu_s1', 'Bash', { command: 'ls' }, { parent: 'toolu_s' })

    expect(sent.map((event) => event.type)).toEqual([PluginEventType.AgentToolCall])
  })
})

describe('subscribing', () => {
  it('sends nothing to a subscriber once it unsubscribes, and each subscriber its own snapshot', () => {
    const task = newTask()
    start()
    const first: Sent[] = []
    const stop = feed.subscribe(sinkInto(first))
    const second: Sent[] = []
    feed.subscribe(sinkInto(second))

    stop()
    changed(task, { title: 'Renamed' })

    expect(first.map((event) => event.type)).toEqual([PluginEventType.Snapshot])
    expect(second.map((event) => event.type)).toEqual([PluginEventType.Snapshot, PluginEventType.TaskUpdated])
  })

  it('keeps up with tasks while no one is subscribed, so a later change is sent as a change', () => {
    const task = newTask()
    start()
    changed(task, { title: 'First' })
    const created = newTask()
    emit({ type: EventType.TaskUpdated, task: created })
    feed.subscribe(sinkInto(sent))
    sent.shift()

    changed(created, { title: 'Second' })

    expect(sent).toEqual([
      { type: PluginEventType.TaskUpdated, task: asPlugin(created, acme, { title: 'Second', updatedAt: 3_000 }) },
    ])
  })

  it('loses nothing and sends nothing twice when a burst of events lands while the snapshot is read', () => {
    const task = newTask()
    const other = newTask(billing)
    const real = databaseFeedSource(database.db)
    let burst = true
    start({
      ...real,
      activeTasks() {
        // Half the burst lands before the tasks are read (so the snapshot has it), half after (so it doesn't).
        if (burst) {
          burst = false
          changed(task, { title: 'Before the read' })
          started(task, 'toolu_s', 'Agent', { description: 'Sort' })
          asked(other, ['Before?'])
          const tasks = real.activeTasks()
          changed(other, { title: 'After the read' })
          started(task, 'toolu_s1', 'Bash', { command: 'ls' }, { parent: 'toolu_s' })
          const created = newTask(acme, 9_000)
          emit({ type: EventType.TaskUpdated, task: created })
          return tasks
        }
        return real.activeTasks()
      },
    })

    feed.subscribe(sinkInto(sent))

    const [snapshot, ...after] = sent
    expect(snapshot).toMatchObject({
      type: PluginEventType.Snapshot,
      tasks: [{ title: 'Before the read' }, { title: '' }],
      subagents: [{ id: 'toolu_s', latest: 'Bash ls' }],
      questions: [{ prompts: ['Before?'] }],
    })
    // The held events follow, applied against the snapshot: only what it didn't have is sent.
    expect(after.map((event) => event.type)).toEqual([
      PluginEventType.AgentToolCall,
      PluginEventType.TaskUpdated,
      PluginEventType.AgentToolCall,
      PluginEventType.TaskCreated,
    ])
    expect(after[1]).toMatchObject({ task: { id: other.id, title: 'After the read' } })
  })

  it("still sends everyone else what happened while a snapshot couldn't be read", () => {
    const task = newTask()
    const real = databaseFeedSource(database.db)
    let fail = false
    start({
      ...real,
      openQuestionSets() {
        if (!fail) return real.openQuestionSets()
        changed(task, { title: 'Meanwhile' })
        throw new Error('disk I/O error')
      },
    })
    feed.subscribe(sinkInto(sent))
    sent.length = 0
    fail = true
    const failed: Sent[] = []

    expect(() => feed.subscribe(sinkInto(failed))).toThrow('disk I/O error')

    expect(failed).toEqual([])
    expect(sent).toMatchObject([{ type: PluginEventType.TaskUpdated, task: { title: 'Meanwhile' } }])
    fail = false
    changed(task, { title: 'Later' }, 4_000)
    expect(failed).toEqual([])
  })

  it("sends subagent.updated, not started, when a subagent the snapshot didn't have ends", () => {
    // A follow-up running in a done task: its subagent started before the plugin subscribed.
    const task = newTask()
    updateTask(database.db, task.id, { state: TaskState.Done }, 2_500)
    appendToolCall(database.db, call(task, 'toolu_s', 'Agent', { description: 'Sort' }), 4_000)
    listen()

    ended(task, 'toolu_s')
    ended(task, 'toolu_s')

    expect(sent.map((event) => event.type)).toEqual([
      PluginEventType.AgentToolCall,
      PluginEventType.SubagentUpdated,
      PluginEventType.AgentToolCall,
      PluginEventType.SubagentUpdated,
    ])
    expect(sent[1]).toMatchObject({ subagent: { id: 'toolu_s', state: PluginSubagentState.Done, latest: null } })
  })

  it('logs each subscription', () => {
    const log = createMemoryLog()
    feed = createPluginFeed({ source: databaseFeedSource(database.db), tasks: [], log: log.logger })
    feed.subscribe(() => undefined)

    expect(log.records).toContainEqual(
      expect.objectContaining({ message: 'plugin feed subscribed', fields: { tasks: 0, held: 0 } }),
    )
  })
})
