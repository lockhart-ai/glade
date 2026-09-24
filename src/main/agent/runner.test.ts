// The agent runner end to end: a scripted agent session behind the real bridge (the preload's `window.glade` over a
// fake IPC pair), saving to a database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import {
  CompactionTrigger,
  DividerKind,
  Effort,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type QueuedMessage,
  UiStateKey,
  type Task,
  type ToolEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { FakeAgentBackend, settle, type FakeAgentSession } from './fake-backend'
import { GLADE_SERVER } from './glade-tools'
import {
  COMPACT_COMMAND,
  createAgentRunner,
  NOT_RESUMED_NOTE,
  RESTARTED_TOOL_NOTE,
  RESUME_PROMPT,
  STOPPED_NOTE,
  type AgentRunner,
} from './runner'
import { systemPromptAppend } from './system-prompt'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  // The window is viewing the task, so its replies don't make it unread (see `../tasks/attention.test.ts`).
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    agentBackend: backend,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

/** Quits the app, mid-turn or not, as a crash or force-quit would leave it, then starts a new runner on the same database. */
function relaunch(): void {
  runner.close()
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    agentBackend: backend,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
}

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
}

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** The tool log, in a form that's easy to compare: each entry's kind, turn and what matters for it. */
function toolLog(): unknown[] {
  return listToolEvents(database.db, task.id).map((event: ToolEvent) => {
    switch (event.kind) {
      case ToolEventKind.Divider:
        return { divider: event.dividerKind, turn: event.turn }
      case ToolEventKind.Narration:
        return { narration: event.text, turn: event.turn }
      case ToolEventKind.ToolCall:
        return {
          call: event.name,
          input: event.input,
          state: event.state,
          output: event.output,
          toolUseId: event.toolUseId,
          parentToolUseId: event.parentToolUseId,
          turn: event.turn,
        }
      case ToolEventKind.Compaction:
        return {
          compaction: event.trigger,
          state: event.state,
          preTokens: event.preTokens,
          postTokens: event.postTokens,
          turn: event.turn,
        }
    }
  })
}

function chat(): unknown[] {
  return listMessages(database.db, task.id).map(({ role, body, turn }) => ({ role, body, turn }))
}

/** The bridge events since the last call, each as its type and the part that matters. */
function drainEvents(): (readonly unknown[])[] {
  const drained = events.splice(0).map((event) => {
    switch (event.type) {
      case EventType.MessageAppended:
        return [event.type, event.message.role, event.message.body]
      case EventType.ToolEventAppended:
      case EventType.ToolEventUpdated:
        return [event.type, event.toolEvent.kind, 'state' in event.toolEvent ? event.toolEvent.state : null]
      case EventType.TaskUpdated:
        return [event.type, event.task.activity, event.task.sessionId, event.task.contextUsedTokens]
      case EventType.QueueChanged:
        return [event.type, event.queuedMessages.map(({ body }) => body)]
      case EventType.UiStateChanged:
      case EventType.WorkspaceUpdated:
      case EventType.TaskOpenRequested:
        return [event.type]
    }
  })
  return drained
}

/** A realistic turn: preamble, a tool call, a subagent with a tool call of its own, then the final reply. */
function scriptedTurn(): unknown[] {
  return [
    sdk.init(),
    ...sdk.turnStartNoise(),
    sdk.thinking(),
    sdk.text("I'll run the login tests first."),
    sdk.toolUse('toolu_01', 'Bash', { command: 'npm test -- login', description: 'Run the login tests' }),
    sdk.toolResult('toolu_01', '12 passed'),
    sdk.toolUse('toolu_02', 'Agent', { description: 'Find flaky tests', prompt: 'Run each login test 50 times.' }),
    { type: 'system', subtype: 'task_started', task_id: 'b7f3', tool_use_id: 'toolu_02', session_id: sdk.SESSION_ID },
    {
      type: 'user',
      parent_tool_use_id: 'toolu_02',
      message: { role: 'user', content: [{ type: 'text', text: 'Run each login test 50 times.' }] },
    },
    sdk.toolUse('toolu_03', 'Bash', { command: 'npm test -- login --repeat 50' }, 'toolu_02', 'msg_sub'),
    sdk.toolResult('toolu_03', '2 failed, 598 passed', false, 'toolu_02'),
    { type: 'system', subtype: 'task_notification', task_id: 'b7f3', status: 'completed', session_id: sdk.SESSION_ID },
    sdk.toolResult('toolu_02', [{ type: 'text', text: 'test_login_redirect fails 2 runs in 50.' }]),
    sdk.thinking('msg_02'),
    sdk.text('The redirect test reads the session before it is saved; that race is the flake.', null, 'msg_02'),
    sdk.result('The redirect test reads the session before it is saved; that race is the flake.'),
  ]
}

describe('a turn', () => {
  it('saves the chat, the tool log, the session id and the activity, and broadcasts each change', async () => {
    await send('Find out why the login test is flaky.')

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options).toEqual({
      cwd: workspace.rootPath,
      model: task.model,
      effort: task.effort,
      resumeSessionId: null,
      systemPromptAppend: systemPromptAppend(task),
      mcpServers: { [GLADE_SERVER]: expect.objectContaining({ type: 'sdk', name: GLADE_SERVER }) as unknown },
    })
    const [userMessage] = listMessages(database.db, task.id)
    expect(backend.session.sent).toEqual([
      {
        text: 'Find out why the login test is flaky.',
        uuid: userMessage?.id,
        settings: { model: task.model, effort: task.effort },
      },
    ])
    expect(backend.session.configured).toEqual([])
    expect(current().activity).toBe(TaskActivity.Working)

    backend.session.emit(...scriptedTurn())
    await settle()

    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Find out why the login test is flaky.', turn: 1 },
      {
        role: MessageRole.Agent,
        body: 'The redirect test reads the session before it is saved; that race is the flake.',
        turn: 1,
      },
    ])
    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      { narration: "I'll run the login tests first.", turn: 1 },
      {
        call: 'Bash',
        input: { command: 'npm test -- login', description: 'Run the login tests' },
        state: ToolCallState.Done,
        output: '12 passed',
        toolUseId: 'toolu_01',
        parentToolUseId: null,
        turn: 1,
      },
      {
        call: 'Agent',
        input: { description: 'Find flaky tests', prompt: 'Run each login test 50 times.' },
        state: ToolCallState.Done,
        output: 'test_login_redirect fails 2 runs in 50.',
        toolUseId: 'toolu_02',
        parentToolUseId: null,
        turn: 1,
      },
      {
        call: 'Bash',
        input: { command: 'npm test -- login --repeat 50' },
        state: ToolCallState.Done,
        output: '2 failed, 598 passed',
        toolUseId: 'toolu_03',
        parentToolUseId: 'toolu_02',
        turn: 1,
      },
    ])
    expect(current()).toMatchObject({ sessionId: sdk.SESSION_ID, activity: TaskActivity.Waiting })
    expect(drainEvents()).toEqual([
      [EventType.MessageAppended, MessageRole.User, 'Find out why the login test is flaky.'],
      [EventType.ToolEventAppended, ToolEventKind.Divider, null],
      [EventType.TaskUpdated, TaskActivity.Working, null, 0],
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID, 0],
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID, sdk.CONTEXT_USED],
      [EventType.ToolEventAppended, ToolEventKind.Narration, null],
      [EventType.ToolEventAppended, ToolEventKind.ToolCall, ToolCallState.Running],
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Done],
      [EventType.ToolEventAppended, ToolEventKind.ToolCall, ToolCallState.Running],
      [EventType.ToolEventAppended, ToolEventKind.ToolCall, ToolCallState.Running],
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Done],
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Done],
      [
        EventType.MessageAppended,
        MessageRole.Agent,
        'The redirect test reads the session before it is saved; that race is the flake.',
      ],
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID, sdk.CONTEXT_USED],
    ])
    await expect(glade.invoke(CommandName.TasksHistory, { id: task.id })).resolves.toEqual({
      messages: listMessages(database.db, task.id),
      toolEvents: listToolEvents(database.db, task.id),
      queuedMessages: [],
    })
  })

  it('shows a running tool call while it runs', async () => {
    await send('Run the tests.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    await settle()

    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      expect.objectContaining({ call: 'Bash', state: ToolCallState.Running, output: null }),
    ])
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('carries on in the same session for the next turn, taking the reply from the result when no text came', async () => {
    await send('Find out why the login test is flaky.')
    backend.session.emit(...scriptedTurn())
    await settle()
    events.splice(0)

    await send('Fix it.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_04', 'Edit', { file_path: 'tests/test_login.py' }))
    backend.session.emit(sdk.toolResult('toolu_04', 'Edited.'), sdk.result('Fixed: the test now waits for the save.'))
    await settle()

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Find out why the login test is flaky.', 'Fix it.'])
    expect(chat().slice(2)).toEqual([
      { role: MessageRole.User, body: 'Fix it.', turn: 2 },
      { role: MessageRole.Agent, body: 'Fixed: the test now waits for the save.', turn: 2 },
    ])
    expect(toolLog().slice(5)).toEqual([
      { divider: DividerKind.Turn, turn: 2 },
      expect.objectContaining({ call: 'Edit', state: ToolCallState.Done, turn: 2 }),
    ])
    // The session id didn't change, so the second init wrote nothing.
    expect(drainEvents().filter(([type]) => type === EventType.TaskUpdated)).toEqual([
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID, sdk.CONTEXT_USED],
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID, sdk.CONTEXT_USED],
    ])
  })

  it('saves no reply for a turn that ends with none, and fails a call that never got its result', async () => {
    await send('Start the dev server.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'npm run dev' }), sdk.result(''))
    await settle()

    expect(chat()).toHaveLength(1)
    expect(toolLog()[1]).toMatchObject({
      state: ToolCallState.Error,
      output: 'The turn ended before this tool call finished.',
    })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('records a failed tool call as an error', async () => {
    await send('Read the config.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Read', { file_path: 'config.yml' }))
    backend.session.emit(sdk.toolResult('toolu_01', 'File does not exist.', true), sdk.result('There is no config.'))
    await settle()

    expect(toolLog()[1]).toMatchObject({ state: ToolCallState.Error, output: 'File does not exist.' })
  })
})

describe('the context usage', () => {
  /** The context usage in each `task.updated` since the last call. */
  function contextUpdates(): { used: number; window: number }[] {
    return events
      .splice(0)
      .flatMap((event) =>
        event.type === EventType.TaskUpdated
          ? [{ used: event.task.contextUsedTokens, window: event.task.contextWindowTokens }]
          : [],
      )
  }

  it("follows the latest top-level message, not a subagent's, and saves it on the task", async () => {
    expect(current()).toMatchObject({ contextUsedTokens: 0, contextWindowTokens: 200_000 })
    await send('Find out why the login test is flaky.')
    contextUpdates()

    backend.session.emit(
      sdk.init(),
      sdk.withContextUsed(sdk.text('Looking.'), 40_000),
      sdk.withContextUsed(sdk.toolUse('toolu_01', 'Bash', { command: 'ls' }), 40_000),
      sdk.toolResult('toolu_01', 'src'),
      sdk.withContextUsed(sdk.toolUse('toolu_02', 'Bash', { command: 'ls' }, 'toolu_01', 'msg_sub'), 5_000),
      sdk.withContextUsed(sdk.text('Found it.', null, 'msg_02'), 76_000),
      sdk.result('Found it.'),
    )
    await settle()

    expect(current()).toMatchObject({ contextUsedTokens: 76_000, contextWindowTokens: 200_000 })
    expect(contextUpdates()).toEqual([
      { used: 0, window: 200_000 },
      { used: 40_000, window: 200_000 },
      { used: 76_000, window: 200_000 },
      { used: 76_000, window: 200_000 },
    ])
  })

  it("keeps the context window the result reports for the session's model", async () => {
    await send('Hi')
    const modelUsage = {
      'claude-sample-other': { contextWindow: 50_000 },
      [sdk.MODEL]: { contextWindow: 180_000 },
    }
    backend.session.emit(sdk.init(), sdk.text('Hello.'), sdk.result('Hello.', { modelUsage }))
    await settle()

    expect(current()).toMatchObject({ contextUsedTokens: sdk.CONTEXT_USED, contextWindowTokens: 180_000 })
  })

  it("keeps the window it has when the result doesn't report the session's model", async () => {
    await send('Hi')
    backend.session.emit(
      sdk.init(),
      sdk.result('Hello.', { modelUsage: { 'claude-sample-other': { contextWindow: 1 } } }),
    )
    await settle()
    expect(current().contextWindowTokens).toBe(200_000)
  })

  it("can't find a window before the session has said which model it runs on", async () => {
    await send('Hi')
    backend.session.emit(sdk.result('Hello.', { modelUsage: { [sdk.MODEL]: { contextWindow: 1 } } }))
    await settle()
    expect(current().contextWindowTokens).toBe(200_000)
  })

  it('lists the task with it once its session is gone', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), sdk.withContextUsed(sdk.text('Hello.'), 76_000), sdk.result('Hello.'))
    await settle()
    runner.close()

    await expect(glade.invoke(CommandName.TasksList, { workspaceId: workspace.id })).resolves.toEqual({
      tasks: [expect.objectContaining({ contextUsedTokens: 76_000, contextWindowTokens: 200_000 })],
    })
  })
})

describe('the turn summary', () => {
  /** The summary saved on the chat's latest reply. */
  function lastSummary(): unknown {
    return listMessages(database.db, task.id).at(-1)?.summary
  }

  // The duration is wall-clock time, so the clock is the test's: each turn starts at 100s.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: 100_000 })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("saves the reply with the turn's duration and the files its finished edits changed, across a relaunch", async () => {
    await send('Fix the date formatting.')
    vi.setSystemTime(1_550_000)
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Edit', { file_path: 'src/date.ts', old_string: 'a\nb', new_string: 'a\nc\nd' }),
      sdk.toolResult('toolu_01', 'Edited.'),
      sdk.toolUse('toolu_02', 'Write', { file_path: 'test/date.test.ts', content: 'one\ntwo\nthree\n' }),
      sdk.toolResult('toolu_02', 'Written.'),
      // A failed edit changed nothing.
      sdk.toolUse('toolu_03', 'Edit', { file_path: 'src/other.ts', old_string: 'x', new_string: 'y' }),
      sdk.toolResult('toolu_03', 'String not found.', true),
      sdk.toolUse('toolu_04', 'Agent', { description: 'Tidy up', prompt: 'Tidy the date module.' }),
      sdk.toolUse(
        'toolu_05',
        'MultiEdit',
        { file_path: 'src/date.ts', edits: [{ old_string: 'old', new_string: 'new' }] },
        'toolu_04',
        'msg_sub',
      ),
      sdk.toolResult('toolu_05', 'Edited.', false, 'toolu_04'),
      sdk.toolResult('toolu_04', 'Tidied.'),
      sdk.toolUse('toolu_06', 'Bash', { command: 'npm test' }, null, 'msg_02'),
      sdk.toolResult('toolu_06', '148 passed'),
      sdk.text('Fixed.', null, 'msg_03'),
      sdk.result('Fixed.', { duration_ms: 1_450_000 }),
    )
    await settle()

    const summary = { durationMs: 1_450_000, filesChanged: 2, linesAdded: 6, linesRemoved: 2 }
    expect(listMessages(database.db, task.id).at(-1)?.createdAt).toBe(1_550_000)
    expect(lastSummary()).toEqual(summary)
    const appended = events.filter((event) => event.type === EventType.MessageAppended).at(-1)
    expect(appended).toMatchObject({ message: { role: MessageRole.Agent, summary } })

    relaunch()
    await expect(glade.invoke(CommandName.TasksHistory, { id: task.id })).resolves.toMatchObject({
      messages: [
        { role: MessageRole.User, summary: null },
        { role: MessageRole.Agent, summary },
      ],
    })
  })

  it("counts only this turn's edits and time, whatever duration the SDK reports", async () => {
    await send('Fix it.')
    vi.setSystemTime(107_000)
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Write', { file_path: 'a.ts', content: 'a\n' }),
      sdk.toolResult('toolu_01', 'Written.'),
      sdk.result('Fixed.'),
    )
    await settle()
    expect(lastSummary()).toEqual({ durationMs: 7_000, filesChanged: 1, linesAdded: 1, linesRemoved: 0 })

    vi.setSystemTime(200_000)
    await send('Thanks.')
    vi.setSystemTime(203_000)
    backend.session.emit(sdk.init(), sdk.result('You are welcome.', { duration_ms: null }))
    await settle()
    expect(lastSummary()).toEqual({ durationMs: 3_000, filesChanged: 0, linesAdded: 0, linesRemoved: 0 })
  })

  it('times a turn from its first message, not from messages queued into it', async () => {
    await send('Fix it.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    await settle()
    vi.setSystemTime(104_000)
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'And the docs.' })
    backend.session.emit(sdk.toolResult('toolu_01', '148 passed'))
    await settle()
    vi.setSystemTime(109_000)
    backend.session.emit(sdk.result('Fixed, docs too.'))
    await settle()

    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Fix it.', turn: 1 },
      { role: MessageRole.User, body: 'And the docs.', turn: 1 },
      { role: MessageRole.Agent, body: 'Fixed, docs too.', turn: 1 },
    ])
    expect(lastSummary()).toMatchObject({ durationMs: 9_000 })
  })

  it('counts the edits a resumed turn made before the app quit, and the time since it started', async () => {
    await send('Fix it.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Write', { file_path: 'a.ts', content: 'a\nb\n' }),
      sdk.toolResult('toolu_01', 'Written.'),
    )
    await settle()

    // The app quits and is relaunched 80s into the turn; the resumed part takes the 8s the SDK reports.
    vi.setSystemTime(180_000)
    relaunch()
    runner.resumeInterrupted()
    vi.setSystemTime(188_000)
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_02', 'Write', { file_path: 'b.ts', content: 'c\n' }),
      sdk.toolResult('toolu_02', 'Written.'),
      sdk.result('Fixed.', { duration_ms: 8_000 }),
    )
    await settle()

    expect(lastSummary()).toEqual({ durationMs: 88_000, filesChanged: 2, linesAdded: 3, linesRemoved: 0 })
  })
})

describe('an error turn', () => {
  it("records why in the tool log, fails the running calls, and marks the task's activity as error", async () => {
    await send('Find out why the login test is flaky.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }),
      sdk.text('API Error: 529 overloaded'),
      sdk.apiErrorResult(),
    )
    await settle()

    expect(chat()).toHaveLength(1)
    expect(toolLog().slice(1)).toEqual([
      expect.objectContaining({ call: 'Bash', state: ToolCallState.Error, output: 'The turn failed (api_error).' }),
      { narration: 'API Error: 529 overloaded\n\nThe turn failed (api_error).', turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Error)
  })

  it("gives the SDK's reasons when it has them, and takes the next message as a new turn", async () => {
    await send('Refactor everything.')
    backend.session.emit(
      sdk.init(),
      sdk.result('', { subtype: 'error_max_turns', is_error: true, errors: ['Reached the maximum number of turns'] }),
    )
    await settle()
    expect(toolLog()[1]).toEqual({ narration: 'Reached the maximum number of turns', turn: 1 })

    await send('Just the auth module, then.')
    expect(current().activity).toBe(TaskActivity.Working)
    expect(backend.sessions).toHaveLength(1)
  })

  it('treats a result it cannot read as a failed turn', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), { type: 'result', subtype: 'success' })
    await settle()

    expect(toolLog()[1]).toEqual({ narration: 'The turn failed (unknown).', turn: 1 })
    expect(current().activity).toBe(TaskActivity.Error)
  })
})

describe('the session', () => {
  it('fails the turn when the agent process fails, and resumes the session on the next message', async () => {
    await send('Find out why the login test is flaky.')
    const first = backend.session
    first.emit(sdk.init(), sdk.text('Checking.'), sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    first.fail(new Error('spawn claude ENOENT'))
    await settle()

    expect(toolLog().slice(1)).toEqual([
      { narration: 'Checking.', turn: 1 },
      expect.objectContaining({ state: ToolCallState.Error, output: 'The agent stopped: spawn claude ENOENT' }),
      { narration: 'The agent stopped: spawn claude ENOENT', turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Error)

    await send('Try again.')
    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Try again.'])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Try again.', turn: 2 })
  })

  it('fails the turn when the session ends in the middle of it', async () => {
    await send('Hi')
    backend.session.end()
    await settle()

    expect(toolLog()[1]).toEqual({ narration: 'The agent session ended unexpectedly.', turn: 1 })
    expect(current().activity).toBe(TaskActivity.Error)
  })

  it('starts again quietly when the session ends between turns', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), sdk.result('Hello.'))
    await settle()
    events.splice(0)
    backend.session.end()
    await settle()

    expect(events).toEqual([])
    expect(current().activity).toBe(TaskActivity.Waiting)
    await send('Still there?')
    expect(backend.sessions).toHaveLength(2)
  })

  it('ignores what a session sends between turns', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), sdk.result('Hello.'))
    await settle()
    events.splice(0)

    backend.session.emit(sdk.text('A late thought.'), sdk.toolResult('toolu_09', 'x'), sdk.result('Late.'))
    await settle()

    expect(events).toEqual([])
  })

  it('closes every session and ignores anything they send afterwards, leaving a cut-short turn working', async () => {
    await send('Hi')
    const session = backend.session
    runner.close()
    session.emit(sdk.init(), sdk.result('Hello.'))
    await settle()

    expect(session.closed).toBe(true)
    expect(chat()).toHaveLength(1)
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('gives the session the MCP servers for its task', () => {
    const servers = { glade: { type: 'http' as const, url: 'http://127.0.0.1:1/mcp' } }
    const mcpServers = vi.fn(() => servers)
    const own = createAgentRunner({ db: database.db, emit: () => undefined, backend, mcpServers })

    own.send(task.id, 'Hi')

    expect(mcpServers).toHaveBeenCalledWith(task)
    expect(backend.session.options.mcpServers).toBe(servers)
    own.close()
  })

  it('logs and survives an unknown message, a result for a call it never saw, and a write that fails', async () => {
    const warn = vi.fn()
    const own = createAgentRunner({ db: database.db, emit: () => undefined, backend, log: { warn } })
    own.send(task.id, 'Hi')
    backend.session.emit(
      sdk.init(),
      { type: 'brand_new_thing', session_id: sdk.SESSION_ID },
      sdk.toolResult('toolu_99', 'x'),
      sdk.toolUse('toolu_01', 'Bash', { command: 'ls' }),
      // The same call again breaks the tool log's one-row-per-call rule, so saving it throws.
      sdk.toolUse('toolu_01', 'Bash', { command: 'ls' }),
      sdk.toolResult('toolu_01', 'README.md'),
      sdk.result('Done.'),
    )
    await settle()

    expect(warn).toHaveBeenCalledWith('Ignored SDK messages of the unknown type brand_new_thing')
    expect(warn).toHaveBeenCalledWith("Ignored a result for tool call toolu_99, which isn't running")
    expect(warn).toHaveBeenCalledWith(`Failed to handle an agent event for task ${task.id}`, expect.any(Error))
    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'Done.', turn: 1 })
    expect(current().activity).toBe(TaskActivity.Waiting)
    own.close()
  })

  it('logs to the console by default', async () => {
    await send('Hi')
    backend.session.emit({ type: 'brand_new_thing' })
    await settle()

    expect(console.warn).toHaveBeenCalledWith('Ignored SDK messages of the unknown type brand_new_thing')
  })
})

describe('resuming on launch', () => {
  it('carries on a turn the app quit in, in the same session, and ends it like any other', async () => {
    await send('Run the e2e suite.')
    backend.session.emit(
      sdk.init(),
      sdk.text("I'll run the whole suite."),
      sdk.toolUse('toolu_01', 'Bash', { command: 'npm run test:e2e' }),
    )
    await settle()

    relaunch()
    runner.resumeInterrupted()

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options).toMatchObject({ cwd: workspace.rootPath, resumeSessionId: sdk.SESSION_ID })
    expect(backend.session.sent).toEqual([
      {
        text: RESUME_PROMPT,
        uuid: expect.any(String) as unknown,
        settings: { model: task.model, effort: task.effort },
      },
    ])
    expect(current().activity).toBe(TaskActivity.Working)
    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      { narration: "I'll run the whole suite.", turn: 1 },
      expect.objectContaining({ call: 'Bash', state: ToolCallState.Error, output: RESTARTED_TOOL_NOTE, turn: 1 }),
      { divider: DividerKind.Resumed, turn: 1 },
    ])
    expect(drainEvents()).toEqual([
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Error],
      [EventType.ToolEventAppended, ToolEventKind.Divider, null],
    ])

    backend.session.emit(
      sdk.init(),
      sdk.text('Glade restarted mid-suite, so I ran it again.'),
      sdk.toolUse('toolu_02', 'Bash', { command: 'npm run test:e2e' }),
      sdk.toolResult('toolu_02', '41 passed'),
      sdk.text('All 41 end-to-end tests pass.', null, 'msg_02'),
      sdk.result('All 41 end-to-end tests pass.'),
    )
    await settle()

    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Run the e2e suite.', turn: 1 },
      { role: MessageRole.Agent, body: 'All 41 end-to-end tests pass.', turn: 1 },
    ])
    expect(toolLog().slice(4)).toEqual([
      { narration: 'Glade restarted mid-suite, so I ran it again.', turn: 1 },
      expect.objectContaining({ call: 'Bash', state: ToolCallState.Done, output: '41 passed', turn: 1 }),
    ])
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, sessionId: sdk.SESSION_ID })

    // The next message is the next turn, in the resumed session.
    await send('Thanks.')
    expect(backend.sessions).toHaveLength(1)
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Thanks.', turn: 2 })
  })

  it('puts a working task with no session back to waiting on you, with a note, and starts nothing', async () => {
    await send('Hi')
    relaunch()
    runner.resumeInterrupted()

    expect(backend.sessions).toHaveLength(0)
    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      { narration: NOT_RESUMED_NOTE, turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('leaves tasks that were waiting, errored or done alone', () => {
    const others = [TaskActivity.Waiting, TaskActivity.Error].map((activity) =>
      updateTask(database.db, sampleTask(database.db, workspace.id).id, { activity, sessionId: 's' }),
    )
    updateTask(database.db, task.id, { state: TaskState.Done, activity: TaskActivity.Working, sessionId: 's' })

    runner.resumeInterrupted()

    expect(backend.sessions).toHaveLength(0)
    expect(events).toEqual([])
    for (const other of others) expect(getTask(database.db, other.id)).toEqual(other)
  })

  it('marks a task it cannot resume as errored, and says why', async () => {
    await send('Hi')
    updateTask(database.db, task.id, { sessionId: 's' })
    relaunch()
    vi.spyOn(backend, 'start').mockImplementation(() => {
      throw new Error('spawn claude ENOENT')
    })

    runner.resumeInterrupted()

    expect(console.warn).toHaveBeenCalledWith(`Failed to resume task ${task.id}`, expect.any(Error))
    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      { narration: "Glade couldn't resume the agent: spawn claude ENOENT", turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Error)
  })
})

describe('tasks.send', () => {
  it('refuses a message while the agent is working', async () => {
    await send('Find out why the login test is flaky.')

    await expect(send('And fix it.')).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
    expect(chat()).toHaveLength(1)
    expect(backend.session.sent).toHaveLength(1)
  })

  it('refuses a task that does not exist, and a blank message', async () => {
    await expect(glade.invoke(CommandName.TasksSend, { id: 'gone', text: 'Hi' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    await expect(glade.invoke(CommandName.TasksSend, { id: task.id, text: ' \n' })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    expect(backend.sessions).toEqual([])
    expect(chat()).toEqual([])
  })

  it('refuses a task whose workspace is gone, before saving anything', async () => {
    database.db.pragma('foreign_keys = OFF')
    database.db.prepare('DELETE FROM workspaces').run()

    await expect(send('Hi')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    expect(chat()).toEqual([])
  })

  it('starts the session with the task’s model, effort and saved session id', async () => {
    updateTask(database.db, task.id, { model: 'claude-sample-2', effort: Effort.Max, sessionId: 'session-9' })

    await send('Hi')

    expect(backend.session.options).toMatchObject({
      model: 'claude-sample-2',
      effort: Effort.Max,
      resumeSessionId: 'session-9',
    })
  })

  it('applies a model or effort change made between turns to the live session, from the next turn on', async () => {
    await send('Find out why the login test is flaky.')
    backend.session.emit(...scriptedTurn())
    await settle()

    // The pickers change the task through tasks.update; the session doesn't hear of it until the next message.
    await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { model: 'claude-sample-2' } })
    expect(backend.session.configured).toEqual([])

    await send('Fix it.')
    backend.session.emit(sdk.result('Fixed.'))
    await settle()
    await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { effort: Effort.Low } })
    await send('Now add a test.')

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.sent.map(({ text, settings }) => [text, settings])).toEqual([
      ['Find out why the login test is flaky.', { model: task.model, effort: task.effort }],
      ['Fix it.', { model: 'claude-sample-2', effort: task.effort }],
      ['Now add a test.', { model: 'claude-sample-2', effort: Effort.Low }],
    ])
    expect(backend.session.configured).toHaveLength(2)
  })

  it('leaves the session alone when the model and effort are unchanged', async () => {
    await send('Hi')
    backend.session.emit(sdk.result('Hello.'))
    await settle()
    await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { model: task.model, effort: task.effort } })
    await send('Again')

    expect(backend.session.configured).toEqual([])
  })
})

describe('tasks.stop', () => {
  /** How long the scripted agent takes to end a turn once interrupted: about what the real one takes (§7). */
  const INTERRUPT_LATENCY_MS = 40

  async function stop(id = task.id): Promise<Task> {
    return (await glade.invoke(CommandName.TasksStop, { id })).task
  }

  /** A turn that has narrated, finished one tool call and is running two more, one of them a subagent's. */
  async function startLongTurn(): Promise<void> {
    await send('Copy the existing uploads to S3.')
    backend.session.emit(
      sdk.init(),
      sdk.text('Backend configured. Copying the existing files next.'),
      sdk.toolUse('toolu_01', 'Write', { file_path: 'scripts/copy.py', content: 'copy()' }),
      sdk.toolResult('toolu_01', 'File created'),
      sdk.toolUse('toolu_02', 'Bash', { command: 'python scripts/copy.py' }),
      sdk.toolUse('toolu_03', 'Agent', { description: 'Check a sample', prompt: 'Check ten copied files.' }),
    )
    await settle()
  }

  /** Makes the agent answer an interrupt as the real one does mid-tool, after a realistic delay. */
  function abortToolsOnInterrupt(): void {
    backend.session.onInterrupt = () => {
      setTimeout(() => {
        backend.session.emit(
          sdk.toolResult('toolu_02', "The user doesn't want to proceed with this tool use.", true),
          sdk.interruptMarker(true),
          sdk.abortedResult('aborted_tools'),
        )
      }, INTERRUPT_LATENCY_MS)
      return Promise.resolve()
    }
  }

  it('halts a running turn within a second, keeps what it saved, and goes back to waiting on you', async () => {
    await startLongTurn()
    abortToolsOnInterrupt()
    events.splice(0)

    const started = performance.now()
    const stopped = await stop()
    const elapsed = performance.now() - started

    expect(backend.session.interrupts).toBe(1)
    expect(elapsed).toBeLessThan(1000)
    expect(stopped.activity).toBe(TaskActivity.Waiting)
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(chat()).toEqual([{ role: MessageRole.User, body: 'Copy the existing uploads to S3.', turn: 1 }])
    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      { narration: 'Backend configured. Copying the existing files next.', turn: 1 },
      expect.objectContaining({ call: 'Write', state: ToolCallState.Done, output: 'File created' }),
      expect.objectContaining({ call: 'Bash', state: ToolCallState.Error, output: STOPPED_NOTE }),
      expect.objectContaining({ call: 'Agent', state: ToolCallState.Error, output: STOPPED_NOTE }),
      { narration: STOPPED_NOTE, turn: 1 },
    ])
    expect(drainEvents()).toEqual([
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Error],
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Error],
      [EventType.ToolEventAppended, ToolEventKind.Narration, null],
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID, sdk.CONTEXT_USED],
    ])
  })

  it('lets a stopped task be messaged again, carrying on in the same session', async () => {
    await startLongTurn()
    abortToolsOnInterrupt()
    await stop()

    await send('Only copy the files from this year.')
    expect(current().activity).toBe(TaskActivity.Working)
    backend.session.emit(sdk.init(), sdk.result('Copied the 1,240 files from this year.'))
    await settle()

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.sent.map(({ text }) => text)).toEqual([
      'Copy the existing uploads to S3.',
      'Only copy the files from this year.',
    ])
    expect(chat().slice(1)).toEqual([
      { role: MessageRole.User, body: 'Only copy the files from this year.', turn: 2 },
      { role: MessageRole.Agent, body: 'Copied the 1,240 files from this year.', turn: 2 },
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('keeps the partial text of a reply it stopped in the tool log, not the chat', async () => {
    await send('Write a short story.')
    backend.session.emit(sdk.init())
    backend.session.onInterrupt = () => {
      backend.session.emit(
        sdk.abortedText('# Juniper\n\nIn the heart of the'),
        sdk.interruptMarker(),
        sdk.abortedResult(),
      )
      return Promise.resolve()
    }

    await stop()

    expect(chat()).toHaveLength(1)
    expect(toolLog().slice(1)).toEqual([
      { narration: '# Juniper\n\nIn the heart of the', turn: 1 },
      { narration: STOPPED_NOTE, turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('answers only once the interrupted turn has ended', async () => {
    await send('Hi')
    let answered = false
    const stopping = stop().then((stopped) => {
      answered = true
      return stopped
    })
    await settle()
    expect(backend.session.interrupts).toBe(1)
    expect(answered).toBe(false)

    backend.session.emit(sdk.interruptMarker(), sdk.abortedResult())

    await expect(stopping).resolves.toMatchObject({ activity: TaskActivity.Waiting })
  })

  it('treats an aborted turn as stopped, even when Glade did not ask', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), sdk.interruptMarker(), sdk.abortedResult())
    await settle()

    expect(toolLog()[1]).toEqual({ narration: STOPPED_NOTE, turn: 1 })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it("keeps the SDK's own text for a rejected tool call when Glade did not ask to stop", async () => {
    await send('Copy the uploads.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Bash', { command: 'python scripts/copy.py' }),
      sdk.toolResult('toolu_01', "The user doesn't want to proceed with this tool use.", true),
      sdk.interruptMarker(true),
      sdk.abortedResult('aborted_tools'),
    )
    await settle()

    expect(toolLog()[1]).toEqual(
      expect.objectContaining({
        call: 'Bash',
        state: ToolCallState.Error,
        output: "The user doesn't want to proceed with this tool use.",
      }),
    )
    expect(toolLog()[2]).toEqual({ narration: STOPPED_NOTE, turn: 1 })
  })

  it('keeps the reply of a turn that finished before the interrupt landed', async () => {
    await send('Hi')
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.init(), sdk.result('Hello.'))
      return Promise.resolve()
    }

    await stop()

    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'Hello.', turn: 1 })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('does nothing for a task whose agent is not working', async () => {
    await expect(stop()).resolves.toEqual(current())

    await send('Hi')
    backend.session.emit(sdk.init(), sdk.result('Hello.'))
    await settle()
    events.splice(0)
    await expect(stop()).resolves.toEqual(current())

    updateTask(database.db, task.id, { state: TaskState.Done })
    await expect(stop()).resolves.toMatchObject({ state: TaskState.Done })
    expect(backend.session.interrupts).toBe(0)
    expect(events).toEqual([])
  })

  it('refuses a task that does not exist', async () => {
    await expect(stop('gone')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
  })

  it('answers once the turn ends some other way: the session failing, or the app closing it', async () => {
    await send('Hi')
    backend.session.onInterrupt = () => {
      backend.session.fail(new Error('spawn claude ENOENT'))
      return Promise.resolve()
    }
    await expect(stop()).resolves.toMatchObject({ activity: TaskActivity.Error })

    await send('Try again.')
    backend.session.onInterrupt = () => {
      runner.close()
      return Promise.resolve()
    }
    await expect(stop()).resolves.toMatchObject({ activity: TaskActivity.Working })
  })

  it('fails when the session cannot be interrupted', async () => {
    await send('Hi')
    backend.session.onInterrupt = () => Promise.reject(new Error('The session is not in streaming input mode'))

    await expect(stop()).rejects.toMatchObject({ code: BridgeErrorCode.Internal })
    expect(current().activity).toBe(TaskActivity.Working)
  })
})

describe('the message queue', () => {
  async function queue(text: string, taskId = task.id): Promise<QueuedMessage> {
    return (await glade.invoke(CommandName.QueueAdd, { taskId, text })).queuedMessage
  }

  function queued(): string[] {
    return listQueuedMessages(database.db, task.id).map(({ body }) => body)
  }

  /** What the session was sent, text only. */
  function sent(): string[] {
    return backend.session.sent.map(({ text }) => text)
  }

  /** A turn that has started a shell command and is waiting on its result. */
  async function startCopy(): Promise<void> {
    await send('Copy the existing uploads to S3.')
    backend.session.emit(
      sdk.init(),
      sdk.text("I'll copy the files, then check a sample."),
      sdk.toolUse('toolu_01', 'Bash', { command: 'python scripts/copy.py' }),
    )
    await settle()
  }

  it('keeps messages queued while a tool call runs, then folds them into the turn once its result arrives', async () => {
    await startCopy()
    events.splice(0)

    const first = await queue('Keep the original filenames in the bucket keys.')
    await queue('When the copy finishes, tell me how many files failed.')

    expect(first).toMatchObject({ taskId: task.id, body: 'Keep the original filenames in the bucket keys.' })
    expect(queued()).toEqual([
      'Keep the original filenames in the bucket keys.',
      'When the copy finishes, tell me how many files failed.',
    ])
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])
    expect(drainEvents()).toEqual([
      [EventType.QueueChanged, ['Keep the original filenames in the bucket keys.']],
      [
        EventType.QueueChanged,
        ['Keep the original filenames in the bucket keys.', 'When the copy finishes, tell me how many files failed.'],
      ],
    ])

    backend.session.emit(sdk.toolResult('toolu_01', 'copied 3,900 of 3,900'))
    await settle()

    expect(queued()).toEqual([])
    const messages = listMessages(database.db, task.id)
    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Copy the existing uploads to S3.', turn: 1 },
      { role: MessageRole.User, body: 'Keep the original filenames in the bucket keys.', turn: 1 },
      { role: MessageRole.User, body: 'When the copy finishes, tell me how many files failed.', turn: 1 },
    ])
    expect(backend.session.sent.map(({ text, uuid }) => [text, uuid])).toEqual(
      messages.map(({ body, id }) => [body, id]),
    )
    expect(drainEvents()).toEqual([
      [EventType.ToolEventUpdated, ToolEventKind.ToolCall, ToolCallState.Done],
      [EventType.QueueChanged, []],
      [EventType.MessageAppended, MessageRole.User, 'Keep the original filenames in the bucket keys.'],
      [EventType.MessageAppended, MessageRole.User, 'When the copy finishes, tell me how many files failed.'],
    ])

    backend.session.emit(
      sdk.text('Done: the keys keep their filenames, and no file failed.', null, 'msg_02'),
      sdk.result('Done: the keys keep their filenames, and no file failed.', {
        user_message_uuids: messages.map(({ id }) => id),
      }),
    )
    await settle()

    expect(chat().at(-1)).toEqual({
      role: MessageRole.Agent,
      body: 'Done: the keys keep their filenames, and no file failed.',
      turn: 1,
    })
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(toolLog().filter((entry) => 'divider' in (entry as object))).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
    ])
  })

  it("waits until every top-level call of the step has its result, not just a subagent's", async () => {
    await send('Check the uploads.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_01', 'Bash', { command: 'ls uploads' }),
      sdk.toolUse('toolu_02', 'Agent', { description: 'Check a sample', prompt: 'Check ten files.' }, null, 'msg_01'),
      sdk.toolUse('toolu_03', 'Read', { file_path: 'uploads/a.jpg' }, 'toolu_02', 'msg_sub'),
    )
    await settle()
    await queue('Skip the thumbnails.')

    backend.session.emit(sdk.toolResult('toolu_03', 'ok', false, 'toolu_02'), sdk.toolResult('toolu_01', 'a.jpg'))
    await settle()
    expect(queued()).toEqual(['Skip the thumbnails.'])

    backend.session.emit(sdk.toolResult('toolu_02', 'All ten files are fine.'))
    await settle()
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Check the uploads.', 'Skip the thumbnails.'])
  })

  it('starts the next turn with what is still queued when the turn ends', async () => {
    await send('Summarise the plan.')
    backend.session.emit(sdk.init(), sdk.text('The plan: copy, then verify.'))
    await settle()
    await queue('Keep the original filenames.')
    await queue('Then check a sample.')
    events.splice(0)

    backend.session.emit(sdk.result('The plan: copy, then verify.'))
    await settle()

    expect(queued()).toEqual([])
    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Summarise the plan.', turn: 1 },
      { role: MessageRole.Agent, body: 'The plan: copy, then verify.', turn: 1 },
      { role: MessageRole.User, body: 'Keep the original filenames.', turn: 2 },
      { role: MessageRole.User, body: 'Then check a sample.', turn: 2 },
    ])
    expect(sent()).toEqual(['Summarise the plan.', 'Keep the original filenames.', 'Then check a sample.'])
    expect(drainEvents()).toEqual([
      [EventType.MessageAppended, MessageRole.Agent, 'The plan: copy, then verify.'],
      [EventType.QueueChanged, []],
      [EventType.MessageAppended, MessageRole.User, 'Keep the original filenames.'],
      [EventType.MessageAppended, MessageRole.User, 'Then check a sample.'],
      [EventType.ToolEventAppended, ToolEventKind.Divider, null],
    ])
    expect(current().activity).toBe(TaskActivity.Working)

    // It's a turn like any other: busy until it ends.
    await expect(send('And another thing.')).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
    backend.session.emit(sdk.result('Copied with the original filenames; the sample is fine.'))
    await settle()
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('delivers an edit made before delivery, and never a removed message', async () => {
    await startCopy()
    const keep = await queue('Keep the filenames.')
    const drop = await queue('Use the Glacier storage class.')

    const { queuedMessage } = await glade.invoke(CommandName.QueueEdit, {
      id: keep.id,
      text: 'Keep the original filenames in the bucket keys.',
    })
    await glade.invoke(CommandName.QueueRemove, { id: drop.id })

    expect(queuedMessage).toEqual({ ...keep, body: 'Keep the original filenames in the bucket keys.' })
    expect(queued()).toEqual(['Keep the original filenames in the bucket keys.'])

    backend.session.emit(sdk.toolResult('toolu_01', 'copied'))
    await settle()

    expect(sent()).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames in the bucket keys.'])
    // Once delivered, it can't be edited or removed.
    await expect(glade.invoke(CommandName.QueueEdit, { id: keep.id, text: 'Too late.' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    await expect(glade.invoke(CommandName.QueueRemove, { id: keep.id })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })

  it('leaves the queue alone when the turn is stopped, then sends it before the next message', async () => {
    await startCopy()
    await queue('Keep the original filenames.')
    backend.session.onInterrupt = () => {
      backend.session.emit(
        sdk.toolResult('toolu_01', "The user doesn't want to proceed with this tool use.", true),
        sdk.interruptMarker(true),
        sdk.abortedResult('aborted_tools'),
      )
      return Promise.resolve()
    }

    await glade.invoke(CommandName.TasksStop, { id: task.id })

    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(queued()).toEqual(['Keep the original filenames.'])
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])

    await send('Carry on with the copy.')

    expect(queued()).toEqual([])
    expect(chat().slice(1)).toEqual([
      { role: MessageRole.User, body: 'Keep the original filenames.', turn: 2 },
      { role: MessageRole.User, body: 'Carry on with the copy.', turn: 2 },
    ])
    expect(sent()).toEqual([
      'Copy the existing uploads to S3.',
      'Keep the original filenames.',
      'Carry on with the copy.',
    ])
  })

  it('leaves the queue alone when the turn fails', async () => {
    await startCopy()
    backend.session.emit(sdk.toolResult('toolu_01', 'copied'))
    await settle()
    await queue('Keep the original filenames.')

    backend.session.emit(sdk.apiErrorResult())
    await settle()

    expect(current().activity).toBe(TaskActivity.Error)
    expect(queued()).toEqual(['Keep the original filenames.'])
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])
  })

  it('leaves the queue alone when the session fails', async () => {
    await startCopy()
    await queue('Keep the original filenames.')

    backend.session.fail(new Error('The agent process exited with code 1'))
    await settle()

    expect(current().activity).toBe(TaskActivity.Error)
    expect(queued()).toEqual(['Keep the original filenames.'])
  })

  it('leaves the queue alone when the turn ends on a task marked done meanwhile', async () => {
    await startCopy()
    backend.session.emit(sdk.toolResult('toolu_01', 'copied'))
    await settle()
    await queue('Keep the original filenames.')
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })

    backend.session.emit(sdk.result('Copied.'))
    await settle()

    expect(current()).toMatchObject({ state: TaskState.Done, activity: TaskActivity.Waiting })
    expect(queued()).toEqual(['Keep the original filenames.'])
  })

  it('starts a turn at once for a message queued when no turn is running', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), sdk.result('Hello.'))
    await settle()

    const message = await queue('Copy the existing uploads to S3.')

    expect(message.body).toBe('Copy the existing uploads to S3.')
    expect(queued()).toEqual([])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Copy the existing uploads to S3.', turn: 2 })
    expect(sent()).toEqual(['Hi', 'Copy the existing uploads to S3.'])
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('starts the session for a message queued to a task that has none', async () => {
    await queue('Copy the existing uploads to S3.')

    expect(backend.sessions).toHaveLength(1)
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])
    expect(chat()).toEqual([{ role: MessageRole.User, body: 'Copy the existing uploads to S3.', turn: 1 }])
  })

  it('carries the turn on when the SDK answers a message handed over mid-turn with a turn of its own', async () => {
    await startCopy()
    await queue('Keep the original filenames.')
    backend.session.emit(sdk.toolResult('toolu_01', 'copied'))
    await settle()
    const [first, folded] = listMessages(database.db, task.id)

    backend.session.emit(
      sdk.text('Copied all 3,900 files.', null, 'msg_02'),
      sdk.result('Copied all 3,900 files.', { user_message_uuids: [first?.id] }),
    )
    await settle()

    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'Copied all 3,900 files.', turn: 1 })
    expect(current().activity).toBe(TaskActivity.Working)

    backend.session.emit(
      sdk.init(),
      sdk.text('They keep their original filenames.', null, 'msg_03'),
      sdk.result('They keep their original filenames.', { user_message_uuids: [folded?.id] }),
    )
    await settle()

    expect(chat().slice(-2)).toEqual([
      { role: MessageRole.Agent, body: 'Copied all 3,900 files.', turn: 1 },
      { role: MessageRole.Agent, body: 'They keep their original filenames.', turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('ends the turn on a result that names none of its messages, since it cannot match them up', async () => {
    await startCopy()
    await queue('Keep the original filenames.')
    backend.session.emit(sdk.toolResult('toolu_01', 'copied'))
    await settle()

    backend.session.emit(sdk.result('Copied.', { user_message_uuids: ['not-one-of-ours'] }))
    await settle()

    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('keeps the queue across a relaunch, and delivers it at the end of the resumed turn’s step', async () => {
    await startCopy()
    await queue('Keep the original filenames.')

    relaunch()
    expect(queued()).toEqual(['Keep the original filenames.'])
    runner.resumeInterrupted()
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_02', 'Bash', { command: 'python scripts/copy.py --resume' }),
      sdk.toolResult('toolu_02', 'copied the rest'),
    )
    await settle()

    expect(queued()).toEqual([])
    expect(sent()).toEqual([RESUME_PROMPT, 'Keep the original filenames.'])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Keep the original filenames.', turn: 1 })
  })

  it('lists the queue with the task’s history', async () => {
    await startCopy()
    const message = await queue('Keep the original filenames.')

    await expect(glade.invoke(CommandName.TasksHistory, { id: task.id })).resolves.toMatchObject({
      queuedMessages: [message],
    })
  })

  it('refuses a task that does not exist, and a blank message', async () => {
    await expect(queue('Hi', 'gone')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    await expect(queue(' \n')).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    await expect(glade.invoke(CommandName.QueueEdit, { id: 'gone', text: ' ' })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })
    expect(backend.sessions).toEqual([])
  })
})

describe('tasks.history', () => {
  it('refuses a task that does not exist', async () => {
    await expect(glade.invoke(CommandName.TasksHistory, { id: 'gone' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })
})

describe('the Glade tools', () => {
  it("set the task's title, objective and status from a turn, and show in the tool log like any other call", async () => {
    await send('The login test fails now and then. Find out why and fix it.')
    const session = backend.session
    session.emit(sdk.init())
    await session.callTool('toolu_01', 'mcp__glade__set_title', { title: 'Fix the flaky login test' })
    await session.callTool('toolu_02', 'mcp__glade__set_objective', {
      objective: 'Make the login test pass every run.',
    })
    await session.callTool('toolu_03', 'mcp__glade__set_status', { status: '' })
    await session.callTool('toolu_04', 'mcp__glade__set_status', { status: 'Reproducing the flake.' })
    session.emit(sdk.result('Found it: a race on the session save.'))
    await settle()

    expect(current()).toMatchObject({
      title: 'Fix the flaky login test',
      objective: 'Make the login test pass every run.',
      status: 'Reproducing the flake.',
      activity: TaskActivity.Waiting,
    })
    const updates = events.flatMap((event) =>
      event.type === EventType.TaskUpdated
        ? [{ title: event.task.title, objective: event.task.objective, status: event.task.status }]
        : [],
    )
    // Working, then the session id, the context used, the three tools' writes, then waiting on you.
    expect(updates.slice(3, 6)).toEqual([
      { title: 'Fix the flaky login test', objective: '', status: '' },
      { title: 'Fix the flaky login test', objective: 'Make the login test pass every run.', status: '' },
      {
        title: 'Fix the flaky login test',
        objective: 'Make the login test pass every run.',
        status: 'Reproducing the flake.',
      },
    ])
    expect(updates).toHaveLength(7)
    expect(toolLog()).toEqual([
      { divider: DividerKind.Turn, turn: 1 },
      {
        call: 'mcp__glade__set_title',
        input: { title: 'Fix the flaky login test' },
        state: ToolCallState.Done,
        output: 'Title set to "Fix the flaky login test".',
        toolUseId: 'toolu_01',
        parentToolUseId: null,
        turn: 1,
      },
      {
        call: 'mcp__glade__set_objective',
        input: { objective: 'Make the login test pass every run.' },
        state: ToolCallState.Done,
        output: 'Objective set.',
        toolUseId: 'toolu_02',
        parentToolUseId: null,
        turn: 1,
      },
      {
        call: 'mcp__glade__set_status',
        input: { status: '' },
        state: ToolCallState.Error,
        output: expect.stringContaining('The status is empty.') as unknown,
        toolUseId: 'toolu_03',
        parentToolUseId: null,
        turn: 1,
      },
      {
        call: 'mcp__glade__set_status',
        input: { status: 'Reproducing the flake.' },
        state: ToolCallState.Done,
        output: 'Status updated.',
        toolUseId: 'toolu_04',
        parentToolUseId: null,
        turn: 1,
      },
    ])
  })
})

describe('reopening by chatting', () => {
  const DONE_AT = Date.UTC(2026, 8, 23, 11, 26)

  /** Runs a first turn to its reply, then marks the task done at `DONE_AT`, as the header's Mark done would. */
  async function finishAndMarkDone(): Promise<void> {
    await send('Find out why the login test is flaky.')
    backend.session.emit(...scriptedTurn())
    await settle()
    vi.spyOn(Date, 'now').mockReturnValueOnce(DONE_AT)
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })
    events.splice(0)
  }

  /** The tool log's dividers after the first turn's five entries. */
  function reopenDividers(): unknown[] {
    return listToolEvents(database.db, task.id)
      .slice(5)
      .filter((event) => event.kind === ToolEventKind.Divider)
      .map(({ dividerKind, turn, createdAt }) => ({ dividerKind, turn, createdAt }))
  }

  it('reopens a done task and delivers the message as the next turn of the same live session', async () => {
    await finishAndMarkDone()
    expect(current()).toMatchObject({ state: TaskState.Done, doneAt: DONE_AT })
    const session = backend.session

    await send('Actually, also cover the logout test.')

    expect(backend.sessions).toEqual([session])
    expect(session.sent.map(({ text }) => text)).toEqual([
      'Find out why the login test is flaky.',
      'Actually, also cover the logout test.',
    ])
    expect(current()).toMatchObject({ state: TaskState.Active, doneAt: null, activity: TaskActivity.Working })
    expect(reopenDividers()).toEqual([
      { dividerKind: DividerKind.MarkedDone, turn: 1, createdAt: DONE_AT },
      { dividerKind: DividerKind.Reopened, turn: 2, createdAt: expect.any(Number) as unknown },
      { dividerKind: DividerKind.Turn, turn: 2, createdAt: expect.any(Number) as unknown },
    ])
    // The task reopens before anything else is heard, and its dividers follow the message, in log order.
    const used = current().contextUsedTokens
    expect(drainEvents()).toEqual([
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID, used],
      [EventType.MessageAppended, MessageRole.User, 'Actually, also cover the logout test.'],
      [EventType.ToolEventAppended, ToolEventKind.Divider, null],
      [EventType.ToolEventAppended, ToolEventKind.Divider, null],
      [EventType.ToolEventAppended, ToolEventKind.Divider, null],
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID, used],
    ])

    session.emit(sdk.init(), sdk.result('The logout test is covered too.'))
    await settle()

    expect(chat().slice(2)).toEqual([
      { role: MessageRole.User, body: 'Actually, also cover the logout test.', turn: 2 },
      { role: MessageRole.Agent, body: 'The logout test is covered too.', turn: 2 },
    ])
    expect(current()).toMatchObject({ state: TaskState.Active, activity: TaskActivity.Waiting })
  })

  it('resumes the saved session by its id when the live one is gone', async () => {
    await finishAndMarkDone()
    relaunch()

    await send('Actually, also cover the logout test.')

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Actually, also cover the logout test.'])
    expect(current()).toMatchObject({ state: TaskState.Active, doneAt: null })
    expect(reopenDividers()).toEqual([
      expect.objectContaining({ dividerKind: DividerKind.MarkedDone, turn: 1, createdAt: DONE_AT }),
      expect.objectContaining({ dividerKind: DividerKind.Reopened, turn: 2 }),
      expect.objectContaining({ dividerKind: DividerKind.Turn, turn: 2 }),
    ])

    backend.session.emit(sdk.init(), sdk.result('The logout test is covered too.'))
    await settle()

    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'The logout test is covered too.', turn: 2 })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('leaves a done task done when its workspace is gone', async () => {
    await finishAndMarkDone()
    relaunch()
    database.db.pragma('foreign_keys = OFF')
    database.db.prepare('DELETE FROM workspaces').run()

    await expect(send('One more thing.')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    expect(current()).toMatchObject({ state: TaskState.Done, doneAt: DONE_AT })
    expect(reopenDividers()).toEqual([])
  })
})

describe('several tasks at once', () => {
  const NAMES = ['alpha', 'beta', 'gamma'] as const

  /** Three tasks in the workspace, `task` first, and their sessions once each has been sent `text`. */
  async function startThree(text: (name: string) => string): Promise<{ ids: string[]; sessions: FakeAgentSession[] }> {
    const ids = [task.id, sampleTask(database.db, workspace.id).id, sampleTask(database.db, workspace.id).id]
    // None of them is being viewed, so each one's reply makes it unread alike.
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: '' })
    for (const [index, id] of ids.entries()) {
      await glade.invoke(CommandName.TasksSend, { id, text: text(NAMES[index] ?? '') })
    }
    return { ids, sessions: backend.sessions }
  }

  /** The task an event is about, if any. */
  function eventTaskId(event: GladeEvent): string | null {
    switch (event.type) {
      case EventType.MessageAppended:
        return event.message.taskId
      case EventType.ToolEventAppended:
      case EventType.ToolEventUpdated:
        return event.toolEvent.taskId
      case EventType.TaskUpdated:
        return event.task.id
      case EventType.TaskOpenRequested:
      case EventType.QueueChanged:
        return event.taskId
      case EventType.UiStateChanged:
      case EventType.WorkspaceUpdated:
        return null
    }
  }

  /** An event's type and what it changed, without anything that tells the tasks apart. */
  function shape(event: GladeEvent): unknown[] {
    switch (event.type) {
      case EventType.MessageAppended:
        return [event.type, event.message.role]
      case EventType.ToolEventAppended:
      case EventType.ToolEventUpdated:
        return [event.type, event.toolEvent.kind, 'state' in event.toolEvent ? event.toolEvent.state : null]
      case EventType.TaskUpdated:
        return [event.type, event.task.activity]
      case EventType.QueueChanged:
        return [event.type, event.queuedMessages.length]
      case EventType.UiStateChanged:
      case EventType.WorkspaceUpdated:
      case EventType.TaskOpenRequested:
        return [event.type]
    }
  }

  /** A task's tool log, as each entry's kind and what tells the tasks apart. */
  function logOf(taskId: string): unknown[] {
    return listToolEvents(database.db, taskId).map((event) => {
      switch (event.kind) {
        case ToolEventKind.Divider:
          return [event.dividerKind, event.turn]
        case ToolEventKind.Narration:
          return [event.text, event.turn]
        case ToolEventKind.ToolCall:
          return [event.name, event.input, event.state, event.output, event.toolUseId, event.parentToolUseId]
        case ToolEventKind.Compaction:
          return [event.trigger, event.state, event.preTokens, event.postTokens]
      }
    })
  }

  /** A turn about `name`, with the same tool call ids whatever the name: a subagent, results out of order, a reply. */
  function turnAbout(name: string): unknown[] {
    return [
      sdk.init(`session-${name}`),
      sdk.text(`Looking at ${name}.`),
      sdk.toolUse('toolu_01', 'Read', { file_path: `src/${name}.ts` }),
      sdk.toolUse('toolu_02', 'Agent', { description: `Check ${name}`, prompt: `Check ${name}.` }),
      sdk.toolUse('toolu_03', 'Grep', { pattern: name }, 'toolu_02', 'msg_sub'),
      sdk.toolResult('toolu_01', `${name} source`),
      sdk.toolResult('toolu_03', `${name} matches`, false, 'toolu_02'),
      sdk.toolResult('toolu_02', `${name} checked`),
      sdk.withContextUsed(sdk.text(`Done with ${name}.`, null, 'msg_02'), 1000 * name.length),
      sdk.result(`Done with ${name}.`),
    ]
  }

  it('runs three turns side by side, each saved to and broadcast for its own task only', async () => {
    const { ids, sessions } = await startThree((name) => `Work on ${name}.`)
    expect(sessions.map((session) => session.sent.map(({ text }) => text))).toEqual(
      NAMES.map((name) => [`Work on ${name}.`]),
    )
    events.splice(0)

    // The sessions stream a message each in turn, and the runner handles each round before the next, so the tasks'
    // writes really interleave.
    const turns = NAMES.map(turnAbout)
    for (let step = 0; step < (turns[0]?.length ?? 0); step += 1) {
      for (const [index, session] of sessions.entries()) session.emit(turns[index]?.[step])
      await settle()
    }

    for (const [index, id] of ids.entries()) {
      const name = NAMES[index] ?? ''
      expect(listMessages(database.db, id).map(({ role, body, turn }) => ({ role, body, turn }))).toEqual([
        { role: MessageRole.User, body: `Work on ${name}.`, turn: 1 },
        { role: MessageRole.Agent, body: `Done with ${name}.`, turn: 1 },
      ])
      expect(logOf(id)).toEqual([
        [DividerKind.Turn, 1],
        [`Looking at ${name}.`, 1],
        ['Read', { file_path: `src/${name}.ts` }, ToolCallState.Done, `${name} source`, 'toolu_01', null],
        [
          'Agent',
          { description: `Check ${name}`, prompt: `Check ${name}.` },
          ToolCallState.Done,
          `${name} checked`,
          'toolu_02',
          null,
        ],
        ['Grep', { pattern: name }, ToolCallState.Done, `${name} matches`, 'toolu_03', 'toolu_02'],
      ])
      expect(getTask(database.db, id)).toMatchObject({
        sessionId: `session-${name}`,
        activity: TaskActivity.Waiting,
        contextUsedTokens: 1000 * name.length,
      })
    }

    // The windows heard every change as it happened, the tasks' events interleaved. Each task's events read as the
    // same turn, and none carries another task's content.
    const broadcast = events.splice(0)
    expect(broadcast.map(eventTaskId).slice(0, 3)).toEqual(ids)
    const byTask = ids.map((id) => broadcast.filter((event) => eventTaskId(event) === id))
    expect(byTask.flat()).toHaveLength(broadcast.length)
    const [first, ...others] = byTask.map((own) => own.map(shape))
    expect(first).toContainEqual([EventType.MessageAppended, MessageRole.Agent])
    for (const other of others) expect(other).toEqual(first)
    for (const [index, own] of byTask.entries()) {
      const content = JSON.stringify(own)
      expect(content).toContain(NAMES[index])
      for (const name of NAMES) if (name !== NAMES[index]) expect(content).not.toContain(name)
    }
  })

  it('stops one task without touching the others, and refuses a message only to a busy one', async () => {
    const {
      ids: [first = '', second = '', third = ''],
      sessions: [a, b, c],
    } = await startThree(() => 'Run the suite.')
    if (a === undefined || b === undefined || c === undefined) throw new Error('Expected three sessions')
    for (const session of [a, b, c]) session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'npm test' }))
    await settle()
    a.onInterrupt = () => {
      a.emit(
        sdk.toolResult('toolu_01', 'rejected', true),
        sdk.interruptMarker(true),
        sdk.abortedResult('aborted_tools'),
      )
      return Promise.resolve()
    }

    await expect(glade.invoke(CommandName.TasksStop, { id: first })).resolves.toMatchObject({
      task: { activity: TaskActivity.Waiting },
    })
    expect([a.interrupts, b.interrupts, c.interrupts]).toEqual([1, 0, 0])
    for (const id of [second, third]) {
      expect(getTask(database.db, id)?.activity).toBe(TaskActivity.Working)
      expect(logOf(id)).toEqual([
        [DividerKind.Turn, 1],
        ['Bash', { command: 'npm test' }, ToolCallState.Running, null, 'toolu_01', null],
      ])
    }

    // The stopped task takes a message again; a working one still refuses one.
    await glade.invoke(CommandName.TasksSend, { id: first, text: 'Just the unit tests.' })
    expect(a.sent.map(({ text }) => text)).toEqual(['Run the suite.', 'Just the unit tests.'])
    await expect(glade.invoke(CommandName.TasksSend, { id: second, text: 'Hurry up.' })).rejects.toMatchObject({
      code: BridgeErrorCode.Busy,
    })

    // The others finish as normal, and the first stays on its new turn.
    b.emit(sdk.toolResult('toolu_01', '12 passed'), sdk.result('Beta passes.'))
    c.emit(sdk.toolResult('toolu_01', '3 passed'), sdk.result('Gamma passes.'))
    await settle()
    expect(listMessages(database.db, second).at(-1)?.body).toBe('Beta passes.')
    expect(listMessages(database.db, third).at(-1)?.body).toBe('Gamma passes.')
    expect(getTask(database.db, first)?.activity).toBe(TaskActivity.Working)
    expect(logOf(second).at(-1)).toEqual([
      'Bash',
      { command: 'npm test' },
      ToolCallState.Done,
      '12 passed',
      'toolu_01',
      null,
    ])
  })
})

describe('compaction', () => {
  async function compact(taskId = task.id): Promise<Task> {
    return (await glade.invoke(CommandName.TasksCompact, { id: taskId })).task
  }

  /** A finished first turn whose last message used `tokens` of context. */
  async function fullTurn(tokens = 198_000): Promise<void> {
    await send('Move the uploads to S3.')
    backend.session.emit(
      sdk.init(),
      sdk.withContextUsed(sdk.text('All 3,900 files are copied.'), tokens),
      sdk.result('All 3,900 files are copied.'),
    )
    await settle()
  }

  /** What the session was sent, text only. */
  function sent(): string[] {
    return backend.session.sent.map(({ text }) => text)
  }

  const running = {
    compaction: CompactionTrigger.Manual,
    state: ToolCallState.Running,
    preTokens: null,
    postTokens: null,
    turn: 1,
  }
  const done = { ...running, state: ToolCallState.Done, preTokens: 198_000, postTokens: 41_000 }

  it('sends an idle session /compact, logs it, and drops the context to what the SDK says is left', async () => {
    await fullTurn()
    events.splice(0)

    const answered = await compact()

    expect(answered).toMatchObject({ id: task.id, activity: TaskActivity.Working })
    expect(sent()).toEqual(['Move the uploads to S3.', COMPACT_COMMAND])
    expect(toolLog().at(-1)).toEqual(running)
    expect(drainEvents()).toEqual([
      [EventType.ToolEventAppended, ToolEventKind.Compaction, ToolCallState.Running],
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID, 198_000],
    ])
    // While it compacts, the agent is working: a message waits in the queue.
    await expect(send('Now update the stored paths.')).rejects.toMatchObject({ code: BridgeErrorCode.Busy })

    backend.session.emit(sdk.init(), ...sdk.compaction(198_000, 41_000), sdk.compactResult())
    await settle()

    expect(toolLog().at(-1)).toEqual(done)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, contextUsedTokens: 41_000 })
    expect(drainEvents()).toEqual([
      [EventType.ToolEventUpdated, ToolEventKind.Compaction, ToolCallState.Done],
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID, 41_000],
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID, 41_000],
    ])
    // Neither `/compact` nor the summary the session continues from reaches the chat, and there's no turn divider.
    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Move the uploads to S3.', turn: 1 },
      { role: MessageRole.Agent, body: 'All 3,900 files are copied.', turn: 1 },
    ])
    expect(toolLog().filter((entry) => (entry as { divider?: DividerKind }).divider !== undefined)).toHaveLength(1)

    // The next message is turn 2, in the same session, and the usage follows its messages again.
    await send('Now update the stored paths.')
    backend.session.emit(sdk.init(), sdk.withContextUsed(sdk.text('Updating.'), 43_500))
    await settle()
    expect(backend.sessions).toHaveLength(1)
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Now update the stored paths.', turn: 2 })
    expect(current().contextUsedTokens).toBe(43_500)
  })

  it('keeps the context usage when the SDK does not say what is left', async () => {
    await fullTurn()
    await compact()

    backend.session.emit(sdk.compactBoundary({ trigger: 'manual', pre_tokens: 198_000 }), sdk.compactResult())
    await settle()

    expect(toolLog().at(-1)).toEqual({ ...done, postTokens: null })
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, contextUsedTokens: 198_000 })
  })

  it('starts the next turn with a message queued while it compacted', async () => {
    await fullTurn()
    await compact()
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Now update the stored paths.' })
    expect(sent()).toEqual(['Move the uploads to S3.', COMPACT_COMMAND])

    backend.session.emit(...sdk.compaction(198_000, 41_000), sdk.compactResult())
    await settle()

    expect(sent().at(-1)).toBe('Now update the stored paths.')
    expect(current().activity).toBe(TaskActivity.Working)
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Now update the stored paths.', turn: 2 })
  })

  it('ends the Compact row as an error when the turn ends without the SDK reporting it', async () => {
    await fullTurn()
    await compact()

    backend.session.emit(sdk.compactResult())
    await settle()

    expect(toolLog().at(-1)).toEqual({ ...running, state: ToolCallState.Error })
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, contextUsedTokens: 198_000 })
  })

  it('can be stopped, and fails with the session', async () => {
    await fullTurn()
    await compact()
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.abortedResult())
      return Promise.resolve()
    }

    await glade.invoke(CommandName.TasksStop, { id: task.id })

    expect(toolLog().slice(-2)).toEqual([
      { ...running, state: ToolCallState.Error },
      { narration: STOPPED_NOTE, turn: 1 },
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)

    await compact()
    backend.session.fail(new Error('The agent process exited'))
    await settle()

    expect(toolLog().at(-2)).toEqual({ ...running, state: ToolCallState.Error })
    expect(current().activity).toBe(TaskActivity.Error)
  })

  it('logs a compaction the SDK does on its own in the middle of a turn', async () => {
    await fullTurn(160_000)
    await send('Now update the stored paths.')
    backend.session.emit(
      sdk.init(),
      sdk.withContextUsed(sdk.text('Updating in batches.'), 167_500),
      ...sdk.compaction(167_500, 30_000, 'auto'),
    )
    await settle()

    expect(toolLog().at(-1)).toEqual({
      compaction: CompactionTrigger.Auto,
      state: ToolCallState.Done,
      preTokens: 167_500,
      postTokens: 30_000,
      turn: 2,
    })
    expect(current()).toMatchObject({ activity: TaskActivity.Working, contextUsedTokens: 30_000 })
    expect(listToolEvents(database.db, task.id).at(-1)).toMatchObject({ windowTokens: sdk.CONTEXT_WINDOW })
  })

  it('refuses while the agent works, for a done task, before the agent has a session, and for no such task', async () => {
    await expect(compact()).rejects.toMatchObject({ code: BridgeErrorCode.InvalidTransition })
    await expect(compact('nope')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })

    await send('Move the uploads to S3.')
    backend.session.emit(sdk.init())
    await settle()
    await expect(compact()).rejects.toMatchObject({ code: BridgeErrorCode.Busy })

    backend.session.emit(sdk.result('Done.'))
    await settle()
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })
    await expect(compact()).rejects.toMatchObject({ code: BridgeErrorCode.InvalidTransition })
    expect(sent()).toEqual(['Move the uploads to S3.'])
    expect(toolLog().some((entry) => 'compaction' in (entry as object))).toBe(false)
  })

  it('resumes the saved session to compact when the live one is gone', async () => {
    await fullTurn()
    relaunch()

    await compact()

    expect(backend.session.options).toMatchObject({ resumeSessionId: sdk.SESSION_ID })
    expect(sent()).toEqual([COMPACT_COMMAND])
  })

  it('fails a compaction the app quit in, and carries the task on like any other cut-short turn', async () => {
    await fullTurn()
    await compact()

    relaunch()
    runner.resumeInterrupted()

    expect(toolLog().slice(-2)).toEqual([
      { ...running, state: ToolCallState.Error },
      { divider: DividerKind.Resumed, turn: 1 },
    ])
    expect(sent()).toEqual([RESUME_PROMPT])
  })
})
