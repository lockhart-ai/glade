// The control API's tools through a real MCP client over the in-memory transport, against the app's bridge on a real
// database and the fake agent backend: what each tool answers, the rows it leaves and the events the windows get.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import {
  AgentErrorKind,
  DividerKind,
  Effort,
  MessageRole,
  PauseReason,
  PermissionMode,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  UiStateKey,
  type Task,
  type Workspace,
} from '../../shared/domain'
import { MODEL_OPTIONS } from '../../shared/models'
import { settle } from '../agent/fake-backend'
import * as sdk from '../agent/test-sdk-messages'
import { appendMessage, listMessages } from '../db/repositories/messages'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, updateTask } from '../db/repositories/tasks'
import { sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { appendDivider, appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { getUiState, setUiState } from '../db/repositories/ui-state'
import { createWorkspace } from '../db/repositories/workspaces'
import { LogScope } from '../logging/logger'
import { ControlErrorCode } from './errors'
import { CONTROL_SERVER, ControlToolName } from './names'
import {
  connect,
  errorCode,
  errorMessage,
  HTTP,
  startControlApp,
  type ControlApp,
  type ControlClient,
} from './test-control'
import { MAX_MESSAGE_LENGTH } from './views'

const SONNET = 'claude-sonnet-5'
const HAIKU = 'claude-haiku-4-5'

let app: ControlApp
let client: ControlClient
let workspace: Workspace
let task: Task

beforeEach(async () => {
  app = startControlApp()
  workspace = sampleWorkspace(app.database.db)
  task = sampleTask(app.database.db, workspace.id)
  client = await connect(app.bridge.control.server(HTTP))
})

afterEach(async () => {
  await client.close()
  await app.close()
})

function current(id: string): Task {
  const found = getTask(app.database.db, id)
  if (found === undefined) throw new Error(`No task ${id}`)
  return found
}

/** The events the windows got since `from`, by type. */
function eventTypes(from = 0): string[] {
  return app.events.slice(from).map((event) => event.type)
}

describe('the server', () => {
  it('lists every tool with its description and a strict JSON Schema for its input', async () => {
    const { tools } = await client.client.listTools()

    expect(tools.map((tool) => tool.name)).toEqual(Object.values(ControlToolName))
    for (const tool of tools) {
      expect(tool.description, tool.name).not.toBe('')
      expect(tool.inputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false })
      expect(tool.inputSchema, tool.name).not.toHaveProperty('$schema')
    }
    const create = tools.find(({ name }) => name === 'create_task')
    expect(create?.inputSchema.required).toEqual(['workspaceId'])
    expect(JSON.stringify(create?.inputSchema.properties)).toContain(MODEL_OPTIONS[0].id)
  })

  it('names itself glade-control', () => {
    expect(client.client.getServerVersion()?.name).toBe(CONTROL_SERVER)
  })

  it('answers a tool it does not have with a protocol error', async () => {
    await expect(client.call('drop_database')).rejects.toThrow('No tool named drop_database')
  })

  it('gives every result as structuredContent and the same JSON as text', async () => {
    const reply = await client.call(ControlToolName.ListWorkspaces)

    expect(reply.isError).toBe(false)
    expect(JSON.parse(reply.text)).toEqual(reply.json)
  })

  it('gives every failure as a tool error with its code, as structuredContent and as text', async () => {
    const reply = await client.call(ControlToolName.GetTask, { id: 'no-such-task' })

    expect(reply.isError).toBe(true)
    expect(reply.json).toEqual({ error: { code: ControlErrorCode.NotFound, message: 'No task no-such-task' } })
    expect(JSON.parse(reply.text)).toEqual(reply.json)
  })
})

describe('list_workspaces', () => {
  it("lists the workspaces in the switcher's order, with their active and done tasks", async () => {
    const other = createWorkspace(app.database.db, { name: 'Acme Web', rootPath: '/code/acme-web' }, 500)
    updateTask(app.database.db, sampleTask(app.database.db, workspace.id).id, { state: TaskState.Done })

    const reply = await client.call(ControlToolName.ListWorkspaces)

    expect(reply.json).toEqual({
      workspaces: [
        { id: other.id, name: 'Acme Web', rootPath: '/code/acme-web', activeTasks: 0, doneTasks: 0 },
        { id: workspace.id, name: 'Acme API', rootPath: '/code/acme-api', activeTasks: 1, doneTasks: 1 },
      ],
    })
  })
})

describe('get_task', () => {
  it('reads every field the header card and the sidebar row show, and changes nothing', async () => {
    updateTask(app.database.db, task.id, {
      title: 'Fix the login bug',
      objective: 'Users can log in again.',
      status: 'Found the bug.',
      unread: true,
      sessionId: 'session-1',
      activity: TaskActivity.Error,
      error: {
        kind: AgentErrorKind.Transient,
        source: TaskErrorSource.Api,
        status: 529,
        code: 'overloaded',
        details: 'Overloaded',
        retries: 3,
        retryingMs: 1000,
      },
    })
    appendMessage(app.database.db, { taskId: task.id, role: MessageRole.User, body: 'Fix it.', turn: 1 })
    const before = current(task.id)
    const events = app.events.length

    const reply = await client.call(ControlToolName.GetTask, { id: task.id })

    expect(reply.json).toEqual({
      task: {
        id: task.id,
        workspaceId: workspace.id,
        title: 'Fix the login bug',
        status: 'Found the bug.',
        state: TaskState.Active,
        activity: TaskActivity.Error,
        needsYou: true,
        pinned: false,
        unread: true,
        updatedAt: before.updatedAt,
        doneAt: null,
        workspace: { id: workspace.id, name: 'Acme API', rootPath: '/code/acme-api', activeTasks: 1, doneTasks: 0 },
        objective: 'Users can log in again.',
        statusUpdatedAt: before.statusUpdatedAt,
        asking: false,
        awaitingPermission: false,
        model: task.model,
        effort: task.effort,
        permissionMode: PermissionMode.AllowAll,
        contextUsedTokens: 0,
        contextWindowTokens: before.contextWindowTokens,
        error: { kind: 'transient', details: 'Overloaded' },
        pause: null,
        queuedMessages: 0,
        turns: 1,
        createdAt: before.createdAt,
        sessionId: 'session-1',
        importedAt: null,
      },
    })
    // A read never marks a task read, and tells no window anything.
    expect(current(task.id)).toEqual(before)
    expect(app.events.length).toBe(events)
  })

  it("says what paused a task's turn and when it resumes", async () => {
    const pause = { reason: PauseReason.UsageLimit, since: 1, resumesAt: 99_000, checks: 0, details: 'Limit' }
    updateTask(app.database.db, task.id, { activity: TaskActivity.Paused, pause })

    const reply = await client.call(ControlToolName.GetTask, { id: task.id })

    expect(reply.json.task).toMatchObject({ pause: { reason: 'usage_limit', resumesAt: 99_000 }, needsYou: false })
  })
})

describe('get_chat', () => {
  /** Two turns: messages, a turn divider each, and tool calls, one of them a subagent's. */
  function seedChat(): void {
    const { db } = app.database
    appendDivider(db, { taskId: task.id, turn: 1, dividerKind: DividerKind.Turn }, 1_000)
    appendMessage(db, { taskId: task.id, role: MessageRole.User, body: 'Fix the login bug.', turn: 1 }, 1_000)
    appendToolCall(
      db,
      {
        taskId: task.id,
        turn: 1,
        name: 'Read',
        input: { file_path: '/code/acme-api/src/login.ts' },
        toolUseId: 'toolu_read',
        parentToolUseId: null,
      },
      1_100,
    )
    updateToolCall(db, { taskId: task.id, toolUseId: 'toolu_read', state: ToolCallState.Done, output: 'x' }, 1_200)
    appendToolCall(
      db,
      { taskId: task.id, turn: 1, name: 'Grep', input: { pattern: 'x' }, toolUseId: 'toolu_sub', parentToolUseId: 'a' },
      1_150,
    )
    appendToolCall(
      db,
      {
        taskId: task.id,
        turn: 1,
        name: 'mcp__glade__set_status',
        input: { status: 'Reading.' },
        toolUseId: 'toolu_status',
        parentToolUseId: null,
      },
      1_160,
    )
    appendMessage(db, { taskId: task.id, role: MessageRole.Agent, body: 'Fixed it.', turn: 1 }, 1_300)
    appendMessage(db, { taskId: task.id, role: MessageRole.User, body: 'x'.repeat(25_000), turn: 2 }, 2_000)
  }

  it("reads the chat by turn, with each turn's start and its agent's own tool calls in one line", async () => {
    seedChat()

    const reply = await client.call(ControlToolName.GetChat, { id: task.id })

    expect(reply.json).toEqual({
      turns: [
        {
          turn: 1,
          startedAt: 1_000,
          messages: [
            { role: 'user', body: 'Fix the login bug.', createdAt: 1_000, truncated: false },
            { role: 'agent', body: 'Fixed it.', createdAt: 1_300, truncated: false },
          ],
          toolCalls: [
            { name: 'Read', summary: 'src/login.ts', state: 'done' },
            { name: 'set_status', summary: '{"status":"Reading."}', state: 'running' },
          ],
        },
        {
          turn: 2,
          startedAt: 2_000,
          messages: [{ role: 'user', body: 'x'.repeat(MAX_MESSAGE_LENGTH), createdAt: 2_000, truncated: true }],
          toolCalls: [],
        },
      ],
      totalTurns: 2,
      nextFromTurn: null,
    })
  })

  it('pages by turn, and leaves out the tool calls when asked', async () => {
    seedChat()

    const first = await client.call(ControlToolName.GetChat, { id: task.id, limit: 1, includeTools: false })
    const second = await client.call(ControlToolName.GetChat, { id: task.id, fromTurn: 2, limit: 1 })
    const past = await client.call(ControlToolName.GetChat, { id: task.id, fromTurn: 5 })

    expect(first.json).toMatchObject({ totalTurns: 2, nextFromTurn: 2 })
    expect(first.json.turns).toEqual([
      expect.not.objectContaining({ toolCalls: expect.anything() as unknown }) as unknown,
    ])
    expect(second.json).toMatchObject({ turns: [{ turn: 2 }], nextFromTurn: null })
    expect(past.json).toEqual({ turns: [], totalTurns: 2, nextFromTurn: null })
  })

  it('reads an empty chat for a task that has never run', async () => {
    const reply = await client.call(ControlToolName.GetChat, { id: task.id })

    expect(reply.json).toEqual({ turns: [], totalTurns: 0, nextFromTurn: null })
  })
})

describe('create_task', () => {
  it("creates a waiting task with Settings' defaults, as New task does, when given no message", async () => {
    const from = app.events.length

    const reply = await client.call(ControlToolName.CreateTask, { workspaceId: workspace.id })

    const created = current(String(Reflect.get(reply.json.task as object, 'id')))
    expect(created).toMatchObject({
      workspaceId: workspace.id,
      title: '',
      state: TaskState.Active,
      activity: TaskActivity.Waiting,
      model: MODEL_OPTIONS[0].id,
      effort: Effort.High,
      permissionMode: PermissionMode.AllowAll,
    })
    expect(reply.json.task).toMatchObject({ id: created.id, needsYou: false, turns: 0 })
    expect(eventTypes(from)).toEqual([EventType.TaskUpdated])
    expect(app.backend.sessions).toEqual([])
    // Unlike New task in the window, it isn't selected.
    expect(getUiState(app.database.db, UiStateKey.SelectedTaskId)).toBeUndefined()
  })

  it('sets the fields it is given, and sends the first message, which starts the agent', async () => {
    const reply = await client.call(ControlToolName.CreateTask, {
      workspaceId: workspace.id,
      message: '  Draft the release notes.  ',
      title: 'Release notes',
      objective: 'Notes for 2.4.',
      model: HAIKU,
      effort: Effort.Low,
      permissionMode: PermissionMode.AskBeforeEdits,
    })

    const id = String(Reflect.get(reply.json.task as object, 'id'))
    expect(current(id)).toMatchObject({
      title: 'Release notes',
      objective: 'Notes for 2.4.',
      model: HAIKU,
      effort: Effort.Low,
      permissionMode: PermissionMode.AskBeforeEdits,
      activity: TaskActivity.Working,
    })
    expect(listMessages(app.database.db, id).map(({ body, turn }) => ({ body, turn }))).toEqual([
      { body: 'Draft the release notes.', turn: 1 },
    ])
    expect(app.backend.session.options).toMatchObject({ model: HAIKU, effort: Effort.Low })
    expect(app.backend.session.sent.map(({ text }) => text)).toEqual(['Draft the release notes.'])
    expect(reply.json.task).toMatchObject({ activity: TaskActivity.Working, turns: 1 })
  })

  it('refuses a workspace that does not exist', async () => {
    const reply = await client.call(ControlToolName.CreateTask, { workspaceId: 'gone' })

    expect(errorCode(reply)).toBe(ControlErrorCode.NotFound)
    expect(errorMessage(reply)).toBe('No workspace gone')
  })
})

describe('update_task', () => {
  it('changes every field it is given in one write, the objective and status included, and tells the windows', async () => {
    const from = app.events.length

    const reply = await client.call(ControlToolName.UpdateTask, {
      id: task.id,
      patch: {
        title: 'Renamed',
        objective: 'A new aim.',
        status: 'Half done.',
        pinned: true,
        unread: true,
        model: SONNET,
        effort: Effort.Max,
        permissionMode: PermissionMode.AskBeforeEdits,
      },
    })

    expect(current(task.id)).toMatchObject({
      title: 'Renamed',
      objective: 'A new aim.',
      status: 'Half done.',
      pinned: true,
      unread: true,
      model: SONNET,
      effort: Effort.Max,
      permissionMode: PermissionMode.AskBeforeEdits,
    })
    expect(reply.json.task).toMatchObject({ title: 'Renamed', status: 'Half done.', pinned: true })
    expect(eventTypes(from)).toEqual([EventType.TaskUpdated])
  })

  it("gives a running session its new permission mode at once, as the picker's does", async () => {
    await app.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go.' })
    app.backend.session.emit(sdk.init())
    await settle()

    await client.call(ControlToolName.UpdateTask, {
      id: task.id,
      patch: { permissionMode: PermissionMode.AskBeforeEdits },
    })

    expect(app.backend.session.configured.at(-1)?.permissionMode).toBe(PermissionMode.AskBeforeEdits)
  })

  it('marks a task unread without moving it in the list', async () => {
    const before = current(task.id)

    await client.call(ControlToolName.UpdateTask, { id: task.id, patch: { unread: true } })

    expect(current(task.id)).toEqual({ ...before, unread: true })
  })
})

describe('mark_done and reopen_task', () => {
  it("mark a task done and reopen it, as the header's actions do", async () => {
    const from = app.events.length

    const done = await client.call(ControlToolName.MarkDone, { id: task.id })
    expect(current(task.id).state).toBe(TaskState.Done)
    expect(done.json.task).toMatchObject({ state: TaskState.Done, doneAt: current(task.id).doneAt })

    const reopened = await client.call(ControlToolName.ReopenTask, { id: task.id })
    expect(current(task.id)).toMatchObject({ state: TaskState.Active, doneAt: null })
    expect(reopened.json.task).toMatchObject({ state: TaskState.Active })
    expect(eventTypes(from)).toEqual([EventType.TaskUpdated, EventType.TaskUpdated])
  })

  it('refuse a change the task’s state does not allow', async () => {
    await client.call(ControlToolName.MarkDone, { id: task.id })

    const again = await client.call(ControlToolName.MarkDone, { id: task.id })
    await client.call(ControlToolName.ReopenTask, { id: task.id })
    const reopenActive = await client.call(ControlToolName.ReopenTask, { id: task.id })

    expect(errorCode(again)).toBe(ControlErrorCode.InvalidTransition)
    expect(errorCode(reopenActive)).toBe(ControlErrorCode.InvalidTransition)
  })
})

describe('delete_task', () => {
  it('deletes a task and its rows with confirm: true, deselecting it, and tells the windows', async () => {
    setUiState(app.database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
    appendMessage(app.database.db, { taskId: task.id, role: MessageRole.User, body: 'Hi.', turn: 1 })
    const from = app.events.length

    const reply = await client.call(ControlToolName.DeleteTask, { id: task.id, confirm: true })

    expect(reply.json).toEqual({ deleted: task.id })
    expect(getTask(app.database.db, task.id)).toBeUndefined()
    expect(listMessages(app.database.db, task.id)).toEqual([])
    expect(app.events.slice(from)).toEqual([
      { type: EventType.UiStateChanged, entry: { key: UiStateKey.SelectedTaskId, value: '' } },
      { type: EventType.TaskDeleted, taskId: task.id },
    ])
  })

  it.each([
    ['without confirm', {}],
    ['with confirm: false', { confirm: false }],
  ])('refuses %s, and deletes nothing', async (_, extra) => {
    const reply = await client.call(ControlToolName.DeleteTask, { id: task.id, ...extra })

    expect(errorCode(reply)).toBe(ControlErrorCode.ConfirmRequired)
    expect(getTask(app.database.db, task.id)).toBeDefined()
  })

  it("closes the task's live session first", async () => {
    await app.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go.' })

    await client.call(ControlToolName.DeleteTask, { id: task.id, confirm: true })

    expect(app.backend.session.closed).toBe(true)
  })
})

describe('a deleted task', () => {
  it.each([
    [ControlToolName.GetTask, {}],
    [ControlToolName.GetChat, {}],
    [ControlToolName.UpdateTask, { patch: { title: 'x' } }],
    [ControlToolName.SendMessage, { text: 'Hello?' }],
    [ControlToolName.StopTask, {}],
    [ControlToolName.MarkDone, {}],
    [ControlToolName.ReopenTask, {}],
    [ControlToolName.DeleteTask, { confirm: true }],
  ])('is not_found to %s', async (tool, extra) => {
    await client.call(ControlToolName.DeleteTask, { id: task.id, confirm: true })

    const reply = await client.call(tool, { id: task.id, ...extra })

    expect(errorCode(reply)).toBe(ControlErrorCode.NotFound)
    expect(errorMessage(reply)).toBe(`No task ${task.id}`)
  })

  it('is left out of list_tasks, and of list_workspaces’ counts', async () => {
    await client.call(ControlToolName.DeleteTask, { id: task.id, confirm: true })

    expect((await client.call(ControlToolName.ListTasks)).json).toEqual({ tasks: [], nextCursor: null })
    expect((await client.call(ControlToolName.ListWorkspaces)).json.workspaces).toEqual([
      expect.objectContaining({ activeTasks: 0, doneTasks: 0 }),
    ])
  })
})

describe('stop_task', () => {
  it('does nothing to an idle task, and answers with it', async () => {
    const before = current(task.id)
    const from = app.events.length

    const reply = await client.call(ControlToolName.StopTask, { id: task.id })

    expect(reply.json.task).toMatchObject({ id: task.id, activity: TaskActivity.Waiting })
    expect(current(task.id)).toEqual(before)
    expect(app.events.length).toBe(from)
  })

  it('interrupts a running turn, as the Stop button does, and answers once it has ended', async () => {
    await app.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go.' })
    app.backend.session.emit(sdk.init())
    await settle()
    app.backend.session.onInterrupt = () => {
      app.backend.session.emit(sdk.interruptMarker(), sdk.abortedResult())
      return Promise.resolve()
    }

    const reply = await client.call(ControlToolName.StopTask, { id: task.id })

    expect(app.backend.session.interrupts).toBe(1)
    expect(reply.json.task).toMatchObject({ activity: TaskActivity.Waiting })
    expect(current(task.id).activity).toBe(TaskActivity.Waiting)
  })
})

describe('the queue', () => {
  it('counts the messages waiting in a task’s queue', async () => {
    await app.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go.' })
    await client.call(ControlToolName.SendMessage, { id: task.id, text: 'And the tests.' })

    const reply = await client.call(ControlToolName.GetTask, { id: task.id })

    expect(listQueuedMessages(app.database.db, task.id)).toHaveLength(1)
    expect(reply.json.task).toMatchObject({ queuedMessages: 1 })
  })
})

describe('the log', () => {
  it('logs each call in the control scope: tool, caller, target task, duration and outcome', async () => {
    await client.call(ControlToolName.GetTask, { id: task.id })
    await client.call(ControlToolName.MarkDone, { id: 'gone' })
    await client.call(ControlToolName.ListWorkspaces)

    const calls = app.log.inScope(LogScope.Control).filter((record) => record.message === 'control call')
    expect(calls.map(({ fields }) => fields)).toEqual([
      { taskId: task.id, tool: 'get_task', caller: 'http', durationMs: expect.any(Number) as unknown, outcome: 'ok' },
      {
        taskId: 'gone',
        tool: 'mark_done',
        caller: 'http',
        durationMs: expect.any(Number) as unknown,
        outcome: 'not_found',
        message: 'No task gone',
      },
      { tool: 'list_workspaces', caller: 'http', durationMs: expect.any(Number) as unknown, outcome: 'ok' },
    ])
  })

  it('logs the text a call sends at debug only, cut short', async () => {
    await client.call(ControlToolName.SendMessage, { id: task.id, text: 'y'.repeat(2_000) })

    const [text] = app.log.inScope(LogScope.Control).filter((record) => record.message === 'control text')
    expect(text?.level).toBe('debug')
    expect(text?.fields).toMatchObject({
      tool: 'send_message',
      text: expect.stringMatching(/^y{500}… \(1500 more/) as unknown,
    })
  })

  it('logs an error Glade did not expect as one, and answers internal', async () => {
    app.database.db.exec('DROP TABLE queued_messages')

    const reply = await client.call(ControlToolName.GetTask, { id: task.id })

    expect(errorCode(reply)).toBe(ControlErrorCode.Internal)
    const [failed] = app.log.inScope(LogScope.Control).filter((record) => record.message === 'control call failed')
    expect(failed?.level).toBe('error')
    expect(failed?.fields).toMatchObject({ tool: 'get_task', outcome: 'internal' })
  })
})
