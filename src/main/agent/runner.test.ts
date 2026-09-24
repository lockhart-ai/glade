// The agent runner end to end: a scripted agent session behind the real bridge (the preload's `window.glade` over a
// fake IPC pair), saving to a database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import {
  DividerKind,
  Effort,
  MessageRole,
  TaskActivity,
  TaskState,
  ToolCallState,
  ToolEventKind,
  type Task,
  type ToolEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { FakeAgentBackend, settle } from './fake-backend'
import { createAgentRunner, systemPromptAppend, type AgentRunner } from './runner'
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
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
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
        return [event.type, event.task.activity, event.task.sessionId]
      case EventType.UiStateChanged:
      case EventType.WorkspaceUpdated:
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
      mcpServers: {},
    })
    const [userMessage] = listMessages(database.db, task.id)
    expect(backend.session.sent).toEqual([{ text: 'Find out why the login test is flaky.', uuid: userMessage?.id }])
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
      [EventType.TaskUpdated, TaskActivity.Working, null],
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID],
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
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID],
    ])
    await expect(glade.invoke(CommandName.TasksHistory, { id: task.id })).resolves.toEqual({
      messages: listMessages(database.db, task.id),
      toolEvents: listToolEvents(database.db, task.id),
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
      [EventType.TaskUpdated, TaskActivity.Working, sdk.SESSION_ID],
      [EventType.TaskUpdated, TaskActivity.Waiting, sdk.SESSION_ID],
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

  it('interrupts the running session, and does nothing for a task without one', async () => {
    await runner.interrupt(task.id)
    await send('Hi')
    await runner.interrupt(task.id)

    expect(backend.session.interrupts).toBe(1)
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

describe('tasks.send', () => {
  it('refuses a message while the agent is working', async () => {
    await send('Find out why the login test is flaky.')

    await expect(send('And fix it.')).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
    expect(chat()).toHaveLength(1)
    expect(backend.session.sent).toHaveLength(1)
  })

  it('refuses a done task, a task that does not exist, and a blank message', async () => {
    updateTask(database.db, task.id, { state: TaskState.Done })

    await expect(send('Hi')).rejects.toMatchObject({ code: BridgeErrorCode.InvalidTransition })
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
})

describe('tasks.history', () => {
  it('refuses a task that does not exist', async () => {
    await expect(glade.invoke(CommandName.TasksHistory, { id: 'gone' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })
})

describe('systemPromptAppend', () => {
  it("says the agent runs inside Glade, and gives the task's id and title", () => {
    expect(systemPromptAppend(task)).toBe(
      [
        'You are running inside Glade, a desktop app that runs Claude agent sessions as tasks.',
        'This session is one Glade task, with one objective.',
        `Its task id is ${task.id}. Its title is not set yet.`,
      ].join('\n'),
    )
    expect(systemPromptAppend({ ...task, title: 'Fix the flaky login test' })).toContain(
      'Its title is "Fix the flaky login test".',
    )
  })
})
