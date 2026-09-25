// Per-call permission review end to end (`docs/decisions.md`, "Per-call permission review"): a scripted agent session
// behind the real bridge, asking about its tool calls as Claude Code asks `canUseTool`, saving to a database in a
// temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { needsYou } from '../../shared/attention'
import {
  PermissionDecisionKind,
  PermissionDestination,
  PermissionMode,
  PermissionRequestState,
  PermissionUpdateType,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type PermissionDecision,
  type PermissionRequest,
  type Task,
  type ToolCallEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { updateSettings } from '../db/repositories/settings'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { ToolPermissionBehavior, type ToolPermissionAnswer } from './backend'
import { FakeAgentBackend, settle, type AskedPermission, type PermissionCallFields } from './fake-backend'
import { GLADE_SERVER } from './glade-tools'
import { PERMISSION_WITHDRAWN_NOTE, permissionDeniedMessage, STOPPED_NOTE, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]
let notifyReply: ReturnType<typeof vi.fn<(taskId: string, text: string) => void>>

/** Starts the app's runner on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
  notifyReply = vi.fn()
  const ipc = fakeIpcPair()
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    notifyReply,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function setMode(permissionMode: PermissionMode): Promise<Task> {
  return (await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { permissionMode } })).task
}

/** Starts a turn in the ask mode: the session has sent its init, and the turn is running. */
async function startAsking(text = 'Add the retry change to the changelog.'): Promise<void> {
  await setMode(PermissionMode.AskBeforeEdits)
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  backend.session.emit(sdk.init())
  await settle()
}

/** The agent calls a tool, and Claude Code asks about it, as the SDK does: the `tool_use`, then `canUseTool`. */
async function callTool(fields: PermissionCallFields, parent: string | null = null): Promise<AskedPermission> {
  backend.session.emit(sdk.toolUse(fields.toolUseId, fields.toolName, { ...fields.input }, parent))
  await settle()
  const asked = backend.session.requestPermission(fields)
  await settle()
  return asked
}

/** Whether a promise has settled yet. */
async function isSettled(promise: Promise<unknown>): Promise<boolean> {
  const pending = Symbol('pending')
  return (await Promise.race([promise, Promise.resolve(pending)])) !== pending
}

function requests(): PermissionRequest[] {
  return listPermissionRequests(database.db, task.id)
}

function only(toolUseId: string): PermissionRequest {
  const found = requests().find((request) => request.toolUseId === toolUseId)
  if (found === undefined) throw new Error(`No request for ${toolUseId}`)
  return found
}

async function answer(toolUseId: string, decision: PermissionDecision): Promise<PermissionRequest> {
  return (await glade.invoke(CommandName.PermissionsAnswer, { id: only(toolUseId).id, decision })).permissionRequest
}

const ALLOW_ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
const ALLOWED_BY_YOU: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: true }
const ALLOWED_AT_ONCE: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: false }
const WITHDRAWN: ToolPermissionAnswer = {
  behavior: ToolPermissionBehavior.Deny,
  message: PERMISSION_WITHDRAWN_NOTE,
  byUser: false,
}

const BASH = { toolUseId: 'toolu_bash', toolName: 'Bash', input: { command: 'npm test' } } as const
const EDIT = {
  toolUseId: 'toolu_edit',
  toolName: 'Edit',
  input: { file_path: 'CHANGELOG.md', old_string: '## Unreleased', new_string: '## 2.4' },
} as const
const WRITE = { toolUseId: 'toolu_write', toolName: 'Write', input: { file_path: 'NOTES.md', content: 'x' } } as const

/** The permission events since the last call, as each one's type and the request's state. */
function permissionEvents(): unknown[] {
  return events
    .splice(0)
    .flatMap((event) =>
      'permissionRequest' in event
        ? [[event.type, event.permissionRequest.toolUseId, event.permissionRequest.state]]
        : [],
    )
}

function toolCall(toolUseId: string): ToolCallEvent {
  const found = listToolEvents(database.db, task.id).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

describe('Allow all', () => {
  it('runs every call without asking, and never opens a request', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Ship it.' })
    backend.session.emit(sdk.init())
    await settle()

    expect(backend.session.options.permissionMode).toBe(PermissionMode.AllowAll)
    for (const fields of [BASH, EDIT, WRITE, { toolUseId: 'toolu_x', toolName: 'SomethingNew', input: {} }]) {
      const asked = await callTool(fields)
      await expect(asked.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    }
    expect(requests()).toEqual([])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
  })

  it('is what a new task starts with, unless Settings says otherwise', async () => {
    expect(current().permissionMode).toBe(PermissionMode.AllowAll)
    updateSettings(database.db, { defaultPermissionMode: PermissionMode.AskBeforeEdits })

    const created = await glade.invoke(CommandName.TasksCreate, { workspaceId: workspace.id })

    expect(created.task.permissionMode).toBe(PermissionMode.AskBeforeEdits)
  })
})

describe('the ask mode', () => {
  it('starts the session asking, and saves the mode on the task', async () => {
    await startAsking()

    expect(current().permissionMode).toBe(PermissionMode.AskBeforeEdits)
    expect(backend.session.options.permissionMode).toBe(PermissionMode.AskBeforeEdits)
  })

  it.each([
    ['Edit', EDIT],
    ['Write', WRITE],
    ['Bash', BASH],
  ])('makes %s wait on a request, however long it takes', async (_, fields) => {
    await startAsking()

    const asked = await callTool(fields)
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(await isSettled(asked.answer)).toBe(false)
    expect(only(fields.toolUseId)).toMatchObject({
      state: PermissionRequestState.Open,
      toolName: fields.toolName,
      input: fields.input,
      turn: 1,
      agentId: null,
    })
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(toolCall(fields.toolUseId).state).toBe(ToolCallState.Running)
  })

  it.each([
    ['Read', { file_path: '/etc/hosts' }],
    ['Grep', { pattern: 'retry' }],
    ['Glob', { pattern: '**/*.ts' }],
    ['WebFetch', { url: 'https://example.com', prompt: 'Summarize' }],
    ['WebSearch', { query: 'exponential backoff' }],
    ['TaskCreate', { subject: 'Write the changelog', description: '' }],
    ['TaskUpdate', { taskId: '1', status: 'completed' }],
    ['TodoWrite', { todos: [] }],
    ['Agent', { description: 'Find flaky tests', prompt: 'Find them.' }],
  ])('lets %s through without asking', async (toolName, input) => {
    await startAsking()

    const asked = await callTool({ toolUseId: `toolu_${toolName}`, toolName, input })

    await expect(asked.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(requests()).toEqual([])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
  })

  it("lets Glade's own tools through, served by the session's own server", async () => {
    await startAsking()

    const asked = await callTool({
      toolUseId: 'toolu_status',
      toolName: `mcp__${GLADE_SERVER}__set_status`,
      input: { status: 'Updating the changelog.' },
      mcpServer: { name: GLADE_SERVER, source: 'sdk' },
    })

    await expect(asked.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(requests()).toEqual([])
  })

  it("asks for an unknown tool, another server's tool, and one only named like Glade's", async () => {
    await startAsking()

    await callTool({ toolUseId: 'toolu_new', toolName: 'SomethingNew', input: {} })
    await callTool({
      toolUseId: 'toolu_gh',
      toolName: 'mcp__github__create_issue',
      input: { title: 'Flaky' },
      mcpServer: { name: 'github', source: 'user' },
    })
    await callTool({
      toolUseId: 'toolu_spoof',
      toolName: `mcp__${GLADE_SERVER}__set_status`,
      input: { status: 'x' },
      mcpServer: { name: GLADE_SERVER, source: 'project' },
    })

    expect(requests().map(({ toolUseId }) => toolUseId)).toEqual(['toolu_new', 'toolu_gh', 'toolu_spoof'])
  })

  it('asks for a read a user permissions.ask rule forced', async () => {
    await startAsking()

    await callTool({ toolUseId: 'toolu_read', toolName: 'Read', input: { file_path: '.env' }, matchedAskRule: true })

    expect(only('toolu_read').state).toBe(PermissionRequestState.Open)
  })

  it('saves what the SDK said of the call: its prompt text, suggestions and flags', async () => {
    await startAsking()
    const suggestions = [
      { type: PermissionUpdateType.SetMode, mode: 'acceptEdits', destination: PermissionDestination.Session },
    ] as const

    await callTool({
      ...EDIT,
      title: 'Claude wants to edit CHANGELOG.md',
      displayName: 'Edit',
      description: 'CHANGELOG.md',
      suggestions,
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    })

    expect(only(EDIT.toolUseId)).toMatchObject({
      title: 'Claude wants to edit CHANGELOG.md',
      displayName: 'Edit',
      description: 'CHANGELOG.md',
      suggestions,
      defaultToNo: true,
      suppressAlwaysAllowRule: true,
    })
  })

  it('runs the call on Allow once, and the turn carries on working', async () => {
    await startAsking()
    const asked = await callTool(BASH)

    const answered = await answer(BASH.toolUseId, ALLOW_ONCE)
    await settle()

    expect(answered.state).toBe(PermissionRequestState.Allowed)
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    backend.session.emit(sdk.toolResult(BASH.toolUseId, 'Tests  148 passed'), sdk.text('All green.'))
    backend.session.emit(sdk.result('All green.'))
    await settle()
    expect(toolCall(BASH.toolUseId)).toMatchObject({ state: ToolCallState.Done, output: 'Tests  148 passed' })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it("doesn't run the call on Deny, and the agent gets the note, then carries on", async () => {
    await startAsking()
    const withNote = await callTool(BASH)
    const without = await callTool(EDIT)

    await answer(BASH.toolUseId, { kind: PermissionDecisionKind.Deny, note: 'Use pnpm, not npm.' })
    await answer(EDIT.toolUseId, { kind: PermissionDecisionKind.Deny })
    await settle()

    await expect(withNote.answer).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: permissionDeniedMessage('Use pnpm, not npm.'),
      byUser: true,
    })
    await expect(without.answer).resolves.toEqual({
      behavior: ToolPermissionBehavior.Deny,
      message: permissionDeniedMessage(undefined),
      byUser: true,
    })
    expect(permissionDeniedMessage('Use pnpm, not npm.')).toContain('Use pnpm, not npm.')
    expect(only(BASH.toolUseId)).toMatchObject({ state: PermissionRequestState.Denied, denyNote: 'Use pnpm, not npm.' })
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
  })

  it('counts under Needs you while a request is open, and not once it is answered', async () => {
    await startAsking()
    await callTool(BASH)

    expect(needsYou(current())).toBe(true)
    await answer(BASH.toolUseId, ALLOW_ONCE)
    await settle()
    expect(needsYou(current())).toBe(false)
  })

  it("marks a task you aren't viewing unread, and notifies the tool and its command or file", async () => {
    await startAsking()
    setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: '' })

    await callTool(BASH)
    await callTool(EDIT)

    expect(current().unread).toBe(true)
    expect(notifyReply.mock.calls).toEqual([
      [task.id, 'Bash: npm test'],
      [task.id, 'Edit: CHANGELOG.md'],
    ])
  })

  it('notifies nothing for a task you are viewing', async () => {
    await startAsking()

    await callTool(BASH)

    expect(current().unread).toBe(false)
    expect(notifyReply).not.toHaveBeenCalled()
  })
})

describe('parallel calls', () => {
  it.each([
    ['in the order they were made', [BASH, EDIT]],
    ['the other way round', [EDIT, BASH]],
  ])('give each call a request of its own, answered %s', async (_, order) => {
    await startAsking()
    const calls = new Map<string, AskedPermission>([
      [BASH.toolUseId, await callTool(BASH)],
      [EDIT.toolUseId, await callTool(EDIT)],
    ])
    const asked = (toolUseId = ''): Promise<ToolPermissionAnswer> => {
      const found = calls.get(toolUseId)
      if (found === undefined) throw new Error(`No call ${toolUseId}`)
      return found.answer
    }
    expect(requests().map(({ toolUseId, state }) => [toolUseId, state])).toEqual([
      [BASH.toolUseId, PermissionRequestState.Open],
      [EDIT.toolUseId, PermissionRequestState.Open],
    ])

    const [first, second] = order
    await answer(first?.toolUseId ?? '', ALLOW_ONCE)
    await settle()
    // The other still waits on you, so the task does too.
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(await isSettled(asked(second?.toolUseId))).toBe(false)

    await answer(second?.toolUseId ?? '', { kind: PermissionDecisionKind.Deny })
    await settle()

    await expect(asked(first?.toolUseId)).resolves.toEqual(ALLOWED_BY_YOU)
    await expect(asked(second?.toolUseId)).resolves.toMatchObject({
      behavior: ToolPermissionBehavior.Deny,
    })
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
  })
})

describe('a subagent’s call', () => {
  it('asks with the subagent’s id, in the turn the subagent runs in', async () => {
    await startAsking()
    backend.session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Run the tests', prompt: 'Run them.' }))
    await settle()

    const asked = await callTool({ ...BASH, agentId: 'ac2cfaf3cec2364e5' }, 'toolu_agent')

    expect(only(BASH.toolUseId)).toMatchObject({ agentId: 'ac2cfaf3cec2364e5', turn: 1 })
    expect(toolCall(BASH.toolUseId).parentToolUseId).toBe('toolu_agent')
    await answer(BASH.toolUseId, ALLOW_ONCE)
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it("keeps a background subagent's request open when the turn that started it ends, until its session goes", async () => {
    await startAsking()
    backend.session.emit(...sdk.backgroundLaunch('toolu_agent', 'a1', 'Run the tests'))
    await settle()
    const asked = await callTool({ ...BASH, agentId: 'a1' }, 'toolu_agent')
    backend.session.emit(sdk.text('It runs in the background.'), sdk.result('It runs in the background.'))
    await settle()

    expect(only(BASH.toolUseId).state).toBe(PermissionRequestState.Open)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(await isSettled(asked.answer)).toBe(false)

    backend.session.fail(new Error('The agent process crashed.'))
    await settle()
    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(only(BASH.toolUseId).state).toBe(PermissionRequestState.Withdrawn)
    expect(current().awaitingPermission).toBe(false)
  })

  it("answers a background subagent's request between turns without putting the task to work", async () => {
    await startAsking()
    backend.session.emit(...sdk.backgroundLaunch('toolu_agent', 'a1', 'Run the tests'))
    await settle()
    backend.session.emit(sdk.result('Launched.'))
    await settle()
    const asked = await callTool({ ...BASH, agentId: 'a1' }, 'toolu_agent')

    await answer(BASH.toolUseId, ALLOW_ONCE)
    await settle()

    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(only(BASH.toolUseId).turn).toBe(1)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
  })
})

describe('withdrawing', () => {
  it('withdraws an open request on Stop, first, and the task no longer waits on it', async () => {
    await startAsking()
    const asked = await callTool(BASH)
    backend.session.onInterrupt = () => {
      backend.session.emit(
        sdk.toolResult(BASH.toolUseId, "The user doesn't want to proceed with this tool use.", true),
        sdk.interruptMarker(true),
        sdk.abortedResult('aborted_tools'),
      )
      return Promise.resolve()
    }
    events.splice(0)

    const stopped = await glade.invoke(CommandName.TasksStop, { id: task.id })

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(permissionEvents()).toEqual([
      [EventType.PermissionWithdrawn, BASH.toolUseId, PermissionRequestState.Withdrawn],
    ])
    expect(stopped.task).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
    expect(toolCall(BASH.toolUseId)).toMatchObject({ state: ToolCallState.Error, output: STOPPED_NOTE })
  })

  it('withdraws every open request when the turn fails', async () => {
    await startAsking()
    const asked = [await callTool(BASH), await callTool(EDIT)]

    backend.session.emit(sdk.apiErrorResult())
    await settle()

    await expect(Promise.all(asked.map(({ answer: decided }) => decided))).resolves.toEqual([WITHDRAWN, WITHDRAWN])
    expect(requests().map(({ state }) => state)).toEqual([
      PermissionRequestState.Withdrawn,
      PermissionRequestState.Withdrawn,
    ])
    expect(current()).toMatchObject({ activity: TaskActivity.Error, awaitingPermission: false })
  })

  it('withdraws an open request when its session fails', async () => {
    await startAsking()
    const asked = await callTool(BASH)

    backend.session.fail(new Error('The agent process crashed.'))
    await settle()

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(current()).toMatchObject({ activity: TaskActivity.Error, awaitingPermission: false })
  })

  it('withdraws a request when the SDK cancels its call, and the turn carries on', async () => {
    await startAsking()
    const asked = await callTool(BASH)

    asked.abort()
    await settle()

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(only(BASH.toolUseId).state).toBe(PermissionRequestState.Withdrawn)
    expect(current().awaitingPermission).toBe(false)
  })

  it('withdraws the requests of a task being deleted', async () => {
    await startAsking()
    const asked = await callTool(BASH)

    await glade.invoke(CommandName.TasksDelete, { id: task.id })

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
  })

  it("denies a call the session asks about once it's closed, without opening a request", async () => {
    await startAsking()
    const session = backend.session
    runner.discard(task.id)

    const asked = session.requestPermission(BASH)

    await expect(asked.answer).resolves.toEqual(WITHDRAWN)
    expect(requests()).toEqual([])
  })
})

describe('answering', () => {
  it('fails with a bridge error, and no crash, for a request that is gone, answered or withdrawn', async () => {
    await startAsking()
    await callTool(BASH)
    const asked = await callTool(EDIT)
    await answer(BASH.toolUseId, ALLOW_ONCE)
    asked.abort()
    await settle()

    await expect(answer(BASH.toolUseId, { kind: PermissionDecisionKind.Deny })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
    })
    await expect(answer(EDIT.toolUseId, ALLOW_ONCE)).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
    })
    await expect(
      glade.invoke(CommandName.PermissionsAnswer, { id: 'missing', decision: ALLOW_ONCE }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    await expect(
      glade.invoke(CommandName.PermissionsAnswer, {
        id: only(BASH.toolUseId).id,
        decision: { kind: 'maybe' },
      } as never),
    ).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })
    expect(only(BASH.toolUseId).state).toBe(PermissionRequestState.Allowed)
    expect(only(EDIT.toolUseId).state).toBe(PermissionRequestState.Withdrawn)
    // The runner is fine: the next call asks and is answered as usual.
    const next = await callTool(WRITE)
    await answer(WRITE.toolUseId, ALLOW_ONCE)
    await expect(next.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it("answers a request the app quit on, which nothing waits on any more, and leaves the task's activity alone", async () => {
    await startAsking()
    await callTool(BASH)
    runner.close()
    launch()

    expect(current().awaitingPermission).toBe(true)
    await answer(BASH.toolUseId, ALLOW_ONCE)

    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
  })
})

describe('switching mode', () => {
  it('takes effect from the next call on a running task, without losing the session', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Ship it.' })
    backend.session.emit(sdk.init())
    await settle()
    const session = backend.session
    const early = await callTool(BASH)
    await expect(early.answer).resolves.toEqual(ALLOWED_AT_ONCE)

    await setMode(PermissionMode.AskBeforeEdits)
    const later = await callTool(EDIT)

    expect(backend.sessions).toEqual([session])
    expect(session.configured.map(({ permissionMode }) => permissionMode)).toEqual([PermissionMode.AskBeforeEdits])
    expect(session.settings.permissionMode).toBe(PermissionMode.AskBeforeEdits)
    expect(only(EDIT.toolUseId).state).toBe(PermissionRequestState.Open)
    expect(await isSettled(later.answer)).toBe(false)

    await answer(EDIT.toolUseId, ALLOW_ONCE)
    await setMode(PermissionMode.AllowAll)
    const last = await callTool(WRITE)
    await expect(last.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(backend.sessions).toEqual([session])
  })

  it('leaves a request already open open, answerable as ever, and asks nothing more', async () => {
    await startAsking()
    const asked = await callTool(BASH)

    await setMode(PermissionMode.AllowAll)
    const next = await callTool(EDIT)

    await expect(next.answer).resolves.toEqual(ALLOWED_AT_ONCE)
    expect(only(BASH.toolUseId).state).toBe(PermissionRequestState.Open)
    expect(current().awaitingPermission).toBe(true)
    await answer(BASH.toolUseId, ALLOW_ONCE)
    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('tells nothing to a task with no live session, whose next session starts in the mode', async () => {
    await setMode(PermissionMode.AskBeforeEdits)
    expect(backend.sessions).toEqual([])

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Ship it.' })
    expect(backend.session.options.permissionMode).toBe(PermissionMode.AskBeforeEdits)
    expect(backend.session.configured).toEqual([])
  })

  it('changes nothing when the mode is what the session has already', async () => {
    await startAsking()
    await setMode(PermissionMode.AskBeforeEdits)
    // And a patch without a mode doesn't touch the session at all.
    await glade.invoke(CommandName.TasksUpdate, { id: task.id, patch: { pinned: true } })

    expect(backend.session.configured).toEqual([])
  })

  it('applies a mode changed behind the runner’s back with the next turn’s settings', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Ship it.' })
    backend.session.emit(sdk.init(), sdk.result('Shipped.'))
    await settle()
    updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })

    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Again.' })

    expect(backend.session.sent.at(-1)?.settings.permissionMode).toBe(PermissionMode.AskBeforeEdits)
  })

  it('fails for a task that does not exist', () => {
    expect(() => {
      runner.applyPermissionMode('missing')
    }).toThrow(expect.objectContaining({ code: BridgeErrorCode.NotFound }))
  })
})

describe('a message sent while a request waits', () => {
  it('is queued, not delivered, until the call has its result', async () => {
    await startAsking()
    await callTool(BASH)

    // The input bar sends it; the agent is still mid-step, so it goes to the queue.
    await expect(glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Use pnpm.' })).rejects.toMatchObject({
      code: BridgeErrorCode.Busy,
    })
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Use pnpm.' })
    await settle()
    expect(listQueuedMessages(database.db, task.id).map(({ body }) => body)).toEqual(['Use pnpm.'])
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Add the retry change to the changelog.'])
    expect(only(BASH.toolUseId).state).toBe(PermissionRequestState.Open)

    await answer(BASH.toolUseId, ALLOW_ONCE)
    backend.session.emit(sdk.toolResult(BASH.toolUseId, 'Tests  148 passed'))
    await settle()

    expect(listQueuedMessages(database.db, task.id)).toEqual([])
    expect(backend.session.sent.map(({ text }) => text)).toEqual([
      'Add the retry change to the changelog.',
      'Use pnpm.',
    ])
  })
})
