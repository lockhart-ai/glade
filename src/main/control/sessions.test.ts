// The control tools as Glade's own tasks get them: in-process, next to `glade`, while the switch is on, calling as
// their task. What sending a message does in each state a task can be in, the guard that keeps a task from stopping,
// deleting or messaging itself, and the switch turned off under a live session. All against the app's bridge, a real
// database and the fake agent backend.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CommandName } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionMode,
  QuestionKind,
  TaskActivity,
  TaskState,
  ToolEventKind,
  type Task,
  type Workspace,
} from '../../shared/domain'
import type { FakeAgentSession } from '../agent/fake-backend'
import { settle } from '../agent/fake-backend'
import { GLADE_SERVER } from '../agent/glade-tools'
import { sdkOptions } from '../agent/sdk-backend'
import * as sdk from '../agent/test-sdk-messages'
import { listMessages } from '../db/repositories/messages'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { listOpenQuestionSets } from '../db/repositories/question-sets'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, updateTask } from '../db/repositories/tasks'
import { sampleTask, sampleWorkspace } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { ControlErrorCode } from './errors'
import { CONTROL_SERVER, ControlToolName } from './names'
import { Delivery } from './service'
import {
  connect,
  errorCode,
  errorMessage,
  HTTP,
  startControlApp,
  type ControlApp,
  type ControlClient,
} from './test-control'
import { CONTROL_TOOLS_LINE } from '../agent/system-prompt'

let app: ControlApp
let workspace: Workspace
let caller: Task
let other: Task
const clients: ControlClient[] = []

beforeEach(() => {
  app = startControlApp()
  workspace = sampleWorkspace(app.database.db)
  caller = sampleTask(app.database.db, workspace.id)
  other = sampleTask(app.database.db, workspace.id)
})

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
  await app.close()
})

function current(id: string): Task {
  const found = getTask(app.database.db, id)
  if (found === undefined) throw new Error(`No task ${id}`)
  return found
}

/** Sends a task a message from the window, which starts its session; answers with the session. */
async function start(task: Task, text = 'Get going.'): Promise<FakeAgentSession> {
  await app.glade.invoke(CommandName.TasksSend, { id: task.id, text })
  const session = app.backend.session
  session.emit(sdk.init())
  await settle()
  return session
}

/** Ends the session's running turn with a reply. */
async function reply(session: FakeAgentSession, text = 'Done.'): Promise<void> {
  session.emit(sdk.text(text), sdk.result(text))
  await settle()
}

/** A client on a session's in-process control server, as its Claude Code process would connect. */
async function controlOf(session: FakeAgentSession): Promise<ControlClient> {
  const server = session.options.mcpServers[CONTROL_SERVER]
  if (server?.type !== 'sdk') throw new Error('The session has no in-process control server')
  const client = await connect(server.instance)
  clients.push(client)
  return client
}

/** A client calling as the HTTP endpoint. */
async function http(): Promise<ControlClient> {
  const client = await connect(app.bridge.control.server(HTTP))
  clients.push(client)
  return client
}

describe("a task's session", () => {
  it('gets the control server next to glade, bound to its task, and the prompt says so, while the switch is on', async () => {
    const session = await start(caller)

    expect(Object.keys(session.options.mcpServers)).toEqual([GLADE_SERVER, CONTROL_SERVER])
    expect(session.options.mcpServers[CONTROL_SERVER]).toMatchObject({ type: 'sdk', name: CONTROL_SERVER })
    expect(session.options.systemPromptAppend).toContain(CONTROL_TOOLS_LINE)
  })

  it('gets neither the control server nor the prompt line while the switch is off', async () => {
    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: false } })

    const session = await start(caller)

    expect(Object.keys(session.options.mcpServers)).toEqual([GLADE_SERVER])
    expect(session.options.systemPromptAppend).not.toContain(CONTROL_SERVER)
  })

  it("pre-approves only glade's tools: the control server's go to the permission check", async () => {
    const session = await start(caller)

    expect(sdkOptions(session.options, {}).allowedTools).toEqual([`mcp__${GLADE_SERVER}`])
  })

  it('calls as its own task', async () => {
    const control = await controlOf(await start(caller))

    await control.call(ControlToolName.GetTask, { id: other.id })

    const [call] = app.log.withMessage('control call')
    expect(call?.fields).toMatchObject({ caller: caller.id, taskId: other.id, tool: 'get_task' })
  })
})

describe('the switch', () => {
  it('is off by default: a session gets no control server, and every call is refused with disabled', async () => {
    const fresh = startControlApp(false)
    const task = sampleTask(fresh.database.db, sampleWorkspace(fresh.database.db).id)
    await fresh.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Go.' })
    const client = await connect(fresh.bridge.control.server(HTTP))

    expect(Object.keys(fresh.backend.session.options.mcpServers)).toEqual([GLADE_SERVER])
    expect(errorCode(await client.call(ControlToolName.ListWorkspaces))).toBe(ControlErrorCode.Disabled)
    expect(errorMessage(await client.call(ControlToolName.ListWorkspaces))).toBe(
      'Agents may not control Glade: turn it on in Settings › Control',
    )
    await client.close()
    await fresh.close()
  })

  it('refuses every call with disabled once it is off, even from a session started while it was on', async () => {
    const control = await controlOf(await start(caller))
    expect((await control.call(ControlToolName.ListWorkspaces)).isError).toBe(false)

    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: false } })

    for (const tool of [ControlToolName.ListWorkspaces, ControlToolName.MarkDone]) {
      const refused = await control.call(tool, { ...(tool === ControlToolName.MarkDone ? { id: other.id } : {}) })
      expect(errorCode(refused), tool).toBe(ControlErrorCode.Disabled)
    }
    expect(current(other.id).state).toBe(TaskState.Active)
  })

  it('refuses before checking the input, and works again once it is back on', async () => {
    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: false } })
    const client = await http()

    expect(errorCode(await client.call(ControlToolName.GetTask, {}))).toBe(ControlErrorCode.Disabled)

    await app.glade.invoke(CommandName.SettingsUpdate, { patch: { controlEnabled: true } })
    expect((await client.call(ControlToolName.GetTask, { id: other.id })).isError).toBe(false)
  })
})

describe('a task turning on itself', () => {
  it.each([
    [ControlToolName.StopTask, {}],
    [ControlToolName.DeleteTask, { confirm: true }],
    [ControlToolName.SendMessage, { text: 'Again.' }],
  ])('is forbidden to %s itself, while it may to another task', async (tool, extra) => {
    const control = await controlOf(await start(caller))

    const self = await control.call(tool, { id: caller.id, ...extra })
    expect(errorCode(self)).toBe(ControlErrorCode.Forbidden)
    expect(errorMessage(self)).toBe(`A task can't ${tool.replaceAll('_', ' ')} itself`)
    expect(current(caller.id)).toMatchObject({ activity: TaskActivity.Working })

    const another = await control.call(tool, { id: other.id, ...extra })
    expect(another.isError).toBe(false)
  })

  it('may read and update itself', async () => {
    const control = await controlOf(await start(caller))

    expect((await control.call(ControlToolName.GetTask, { id: caller.id })).isError).toBe(false)
    expect((await control.call(ControlToolName.GetChat, { id: caller.id })).isError).toBe(false)
    const updated = await control.call(ControlToolName.UpdateTask, { id: caller.id, patch: { status: 'Busy.' } })
    expect(updated.isError).toBe(false)
    expect(current(caller.id).status).toBe('Busy.')
  })

  it('is only guarded through its own server: the HTTP endpoint may stop any task', async () => {
    await start(caller)
    app.backend.session.onInterrupt = () => {
      app.backend.session.emit(sdk.abortedResult())
      return Promise.resolve()
    }

    const stopped = await (await http()).call(ControlToolName.StopTask, { id: caller.id })

    expect(stopped.isError).toBe(false)
    expect(current(caller.id).activity).toBe(TaskActivity.Waiting)
  })
})

describe('send_message', () => {
  it('sends to an idle task, starting a turn, as the input bar does', async () => {
    const client = await http()

    const sent = await client.call(ControlToolName.SendMessage, { id: other.id, text: 'Fix the bug.' })

    expect(sent.json).toMatchObject({ delivery: Delivery.Sent, task: { activity: TaskActivity.Working, turns: 1 } })
    expect(listMessages(app.database.db, other.id)).toMatchObject([{ role: MessageRole.User, body: 'Fix the bug.' }])
    expect(app.backend.session.sent.map(({ text }) => text)).toEqual(['Fix the bug.'])
  })

  it('queues for a working task, and the agent gets it after its current step', async () => {
    const session = await start(other)

    const queued = await (await http()).call(ControlToolName.SendMessage, { id: other.id, text: 'Also the docs.' })

    expect(queued.json).toMatchObject({ delivery: Delivery.Queued, task: { queuedMessages: 1 } })
    expect(listQueuedMessages(app.database.db, other.id).map(({ body }) => body)).toEqual(['Also the docs.'])
    await reply(session)
    expect(session.sent.map(({ text }) => text)).toEqual(['Get going.', 'Also the docs.'])
  })

  it('reopens a done task, as a message from the window does', async () => {
    const session = await start(other)
    await reply(session)
    await app.glade.invoke(CommandName.TasksMarkDone, { id: other.id })

    const sent = await (await http()).call(ControlToolName.SendMessage, { id: other.id, text: 'One more thing.' })

    expect(sent.json).toMatchObject({ delivery: Delivery.Sent, task: { state: TaskState.Active, turns: 2 } })
    const dividers = listToolEvents(app.database.db, other.id).flatMap((event) =>
      event.kind === ToolEventKind.Divider ? [event.dividerKind] : [],
    )
    expect(dividers).toEqual([DividerKind.Turn, DividerKind.MarkedDone, DividerKind.Reopened, DividerKind.Turn])
  })

  it("answers an agent's open questions, in words, when it asks", async () => {
    const session = await start(other)
    const asked = session.callTool('toolu_ask', 'mcp__glade__ask', {
      questions: [{ kind: QuestionKind.Text, prompt: 'Which branch?' }],
    })
    await settle()
    expect(current(other.id).asking).toBe(true)

    const answered = await (await http()).call(ControlToolName.SendMessage, { id: other.id, text: 'main' })
    await asked

    expect(answered.json).toMatchObject({ delivery: Delivery.Answered, task: { asking: false } })
    expect(listOpenQuestionSets(app.database.db)).toEqual([])
    expect(listMessages(app.database.db, other.id).at(-1)).toMatchObject({ body: 'main', turn: 1 })
    expect(listQueuedMessages(app.database.db, other.id)).toEqual([])
  })

  it('queues for a task whose agent waits on a permission card', async () => {
    await app.glade.invoke(CommandName.TasksUpdate, {
      id: other.id,
      patch: { permissionMode: PermissionMode.AskBeforeEdits },
    })
    const session = await start(other)
    session.emit(sdk.toolUse('toolu_edit', 'Edit', { file_path: 'a.txt' }))
    await settle()
    session.requestPermission({ toolUseId: 'toolu_edit', toolName: 'Edit', input: { file_path: 'a.txt' } })
    await settle()
    expect(current(other.id).awaitingPermission).toBe(true)

    const queued = await (await http()).call(ControlToolName.SendMessage, { id: other.id, text: 'Go ahead.' })

    expect(queued.json).toMatchObject({ delivery: Delivery.Queued, task: { awaitingPermission: true } })
    expect(listQueuedMessages(app.database.db, other.id)).toHaveLength(1)
  })

  it('queues for a paused task, which gets it once it resumes', async () => {
    updateTask(app.database.db, other.id, {
      activity: TaskActivity.Paused,
      sessionId: 'session-1',
      pause: { reason: PauseReason.UsageLimit, since: 1, resumesAt: Date.now() + 60_000, checks: 0, details: 'x' },
    })

    const queued = await (await http()).call(ControlToolName.SendMessage, { id: other.id, text: 'When you can.' })

    expect(queued.json).toMatchObject({ delivery: Delivery.Queued })
    expect(app.backend.sessions).toEqual([])
  })
})

describe('in the ask mode', () => {
  /** The calling task, in the ask mode, with its turn running. */
  async function asking(): Promise<FakeAgentSession> {
    await app.glade.invoke(CommandName.TasksUpdate, {
      id: caller.id,
      patch: { permissionMode: PermissionMode.AskBeforeEdits },
    })
    return start(caller)
  }

  /** Claude Code asking the runner about a control tool call, as it does for any tool it hasn't pre-approved. */
  async function ask(session: FakeAgentSession, tool: string, source = 'sdk'): Promise<void> {
    const toolName = `mcp__${CONTROL_SERVER}__${tool}`
    session.emit(sdk.toolUse(`toolu_${tool}`, toolName, {}))
    await settle()
    session.requestPermission({
      toolUseId: `toolu_${tool}`,
      toolName,
      input: {},
      mcpServer: { name: CONTROL_SERVER, source },
    })
    await settle()
  }

  it("lets the control server's reads through without a card, and puts a card up for each change", async () => {
    const session = await asking()

    for (const tool of [ControlToolName.ListWorkspaces, ControlToolName.ListTasks, ControlToolName.GetTask]) {
      await ask(session, tool)
    }
    await ask(session, ControlToolName.GetChat)
    expect(listPermissionRequests(app.database.db, caller.id)).toEqual([])

    await ask(session, ControlToolName.CreateTask)
    await ask(session, ControlToolName.DeleteTask)
    expect(listPermissionRequests(app.database.db, caller.id).map(({ toolName }) => toolName)).toEqual([
      `mcp__${CONTROL_SERVER}__create_task`,
      `mcp__${CONTROL_SERVER}__delete_task`,
    ])
    expect(current(caller.id).awaitingPermission).toBe(true)
  })

  it('puts a card up even for a read, when the server calling itself glade-control is not the in-process one', async () => {
    const session = await asking()

    await ask(session, ControlToolName.ListTasks, 'user')

    expect(listPermissionRequests(app.database.db, caller.id).map(({ toolName }) => toolName)).toEqual([
      `mcp__${CONTROL_SERVER}__list_tasks`,
    ])
  })
})
