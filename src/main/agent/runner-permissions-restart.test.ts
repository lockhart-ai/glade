// Permission requests the app quit on (`docs/decisions.md`, "Per-call permission review"; P11-04): a scripted agent
// session behind the real bridge asks about its calls, the app quits with the requests open, and a new runner on the same
// database finds them still open. Deciding on them resumes the task's session and tells the agent in a message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import { needsYou } from '../../shared/attention'
import {
  AgentErrorKind,
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionDecisionKind,
  PermissionDestination,
  PermissionMode,
  PermissionRequestState,
  PermissionRuleBehavior,
  PermissionUpdateType,
  TaskActivity,
  TaskErrorSource,
  TaskState,
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
import { listMessages } from '../db/repositories/messages'
import {
  closePermissionRequest,
  listPermissionRequests,
  restartDeliveryOf,
  RestartDelivery,
} from '../db/repositories/permission-requests'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { listTaskPermissionRules } from '../db/repositories/task-permission-rules'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { ToolPermissionBehavior, type ToolPermissionAnswer } from './backend'
import { FakeAgentBackend, settle, type AskedPermission, type PermissionCallFields } from './fake-backend'
import {
  PERMISSION_RESTARTED_NOTE,
  PERMISSIONS_DECIDED_AFTER_RESTART_END,
  PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT,
  permissionsDecidedAfterRestart,
  RESTARTED_TOOL_NOTE,
  RESUME_PROMPT,
  type AgentRunner,
} from './runner'
import * as sdk from './test-sdk-messages'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner

/** Starts the app's runner on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
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
  }))
  glade = createBridge(ipc.renderer)
}

/** Quits the app, whatever it's doing, and launches it again on the same database, carrying on what it quit in. */
function relaunch(): void {
  runner.close()
  launch()
  runner.resumeInterrupted()
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

function current(id = task.id): Task {
  const found = getTask(database.db, id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** Starts a turn in the ask mode: the session has sent its init, and the turn is running. */
async function startAsking(id = task.id, text = 'Run the migrations, then note them in the changelog.'): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id, text })
  // Each task has a session of its own.
  backend.session.emit(sdk.init(id === task.id ? undefined : `session-${id}`))
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

function requests(id = task.id): PermissionRequest[] {
  return listPermissionRequests(database.db, id)
}

function only(toolUseId: string, id = task.id): PermissionRequest {
  const found = requests(id).find((request) => request.toolUseId === toolUseId)
  if (found === undefined) throw new Error(`No request for ${toolUseId}`)
  return found
}

async function answer(toolUseId: string, decision: PermissionDecision, id = task.id): Promise<PermissionRequest> {
  const request = only(toolUseId, id)
  return (await glade.invoke(CommandName.PermissionsAnswer, { id: request.id, decision })).permissionRequest
}

function toolCall(toolUseId: string, id = task.id): ToolCallEvent {
  const found = listToolEvents(database.db, id).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

/** What the runner sent the task's latest session, in order. */
function sent(): string[] {
  return backend.session.sent.map(({ text }) => text)
}

/** Ends the turn running, as the agent would once its calls are done. */
async function finishTurn(reply = 'The migrations ran.'): Promise<void> {
  backend.session.emit(sdk.text(reply, null, 'msg_02'), sdk.result(reply))
  await settle()
}

const ALLOW_ONCE: PermissionDecision = { kind: PermissionDecisionKind.AllowOnce }
const FOR_TASK: PermissionDecision = { kind: PermissionDecisionKind.AllowForTask }
const ALLOWED_BY_YOU: ToolPermissionAnswer = { behavior: ToolPermissionBehavior.Allow, byUser: true }

const MIGRATE = {
  toolUseId: 'toolu_migrate',
  toolName: 'Bash',
  input: { command: 'npm run db:migrate', description: 'Run the migrations' },
  suggestions: [
    {
      type: PermissionUpdateType.AddRules,
      rules: [{ toolName: 'Bash', ruleContent: 'npm run db:migrate *' }],
      behavior: PermissionRuleBehavior.Allow,
      destination: PermissionDestination.LocalSettings,
    },
  ],
} as const satisfies PermissionCallFields
const EDIT = {
  toolUseId: 'toolu_edit',
  toolName: 'Edit',
  input: { file_path: 'CHANGELOG.md', old_string: '## Unreleased', new_string: '## Unreleased\n\n- Migrations.' },
} as const satisfies PermissionCallFields

/** The same call as `fields`, made again by the agent with a new id. */
function again(fields: PermissionCallFields, toolUseId = `${fields.toolUseId}_again`): PermissionCallFields {
  return { ...fields, toolUseId }
}

describe('a request open when the app quits', () => {
  it('is still open after a relaunch, and answering it resumes the session and sends the decision', async () => {
    await startAsking()
    await callTool(MIGRATE)

    relaunch()

    // Still open: the card shows, and the task waits on you, without its agent running.
    expect(only(MIGRATE.toolUseId).state).toBe(PermissionRequestState.Open)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(needsYou(current())).toBe(true)
    expect(backend.sessions).toHaveLength(0)
    // Its call ended as interrupted, as an `ask` call's does.
    expect(toolCall(MIGRATE.toolUseId)).toMatchObject({
      state: ToolCallState.Interrupted,
      output: PERMISSION_RESTARTED_NOTE,
    })

    const answered = await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    await settle()

    expect(answered.state).toBe(PermissionRequestState.Allowed)
    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options).toMatchObject({
      resumeSessionId: sdk.SESSION_ID,
      permissionMode: PermissionMode.AskBeforeEdits,
    })
    expect(sent()).toEqual([permissionsDecidedAfterRestart([answered])])
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    const log = listToolEvents(database.db, task.id)
    expect(log.at(-1)).toMatchObject({ kind: ToolEventKind.Divider, dividerKind: DividerKind.Resumed, turn: 1 })

    // The agent makes the call again: it runs without asking, once. The same call after it asks again.
    backend.session.emit(sdk.init())
    const rerun = await callTool(again(MIGRATE))
    await expect(rerun.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(requests()).toHaveLength(1)
    const third = await callTool(again(MIGRATE, 'toolu_migrate_third'))
    expect(await isSettled(third.answer)).toBe(false)
    expect(requests()).toHaveLength(2)
    await answer('toolu_migrate_third', ALLOW_ONCE)
    await finishTurn()

    // The turn that asked carries on to its reply.
    expect(listMessages(database.db, task.id).map(({ role, turn }) => [role, turn])).toEqual([
      [MessageRole.User, 1],
      [MessageRole.Agent, 1],
    ])
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('tells the agent clearly what was decided, in words it can act on', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()

    const answered = await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    const message = permissionsDecidedAfterRestart([answered])
    expect(message).toBe(
      [
        PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT,
        '',
        '- Your Bash call toolu_migrate, with input {"command":"npm run db:migrate","description":"Run the ' +
          'migrations"}: allowed once.',
        '',
        PERMISSIONS_DECIDED_AFTER_RESTART_END,
      ].join('\n'),
    )
  })

  it('is left alone by the next launches until you decide on it', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    relaunch()

    expect(backend.sessions).toHaveLength(0)
    expect(only(MIGRATE.toolUseId).state).toBe(PermissionRequestState.Open)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
  })

  it('survives a clean quit, whose closing sessions cancel the calls, as well as a crash', async () => {
    await startAsking()
    const asked = await callTool(MIGRATE)
    runner.close()
    // The SDK cancels the call as its process goes: the request stays open for the next launch.
    asked.abort()
    await settle()
    launch()
    runner.resumeInterrupted()

    expect(only(MIGRATE.toolUseId).state).toBe(PermissionRequestState.Open)
    expect(current().awaitingPermission).toBe(true)
  })
})

describe('each decision after a relaunch', () => {
  it('Allow for this task: saves the rule first, so the resumed session starts with it, and the call runs', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()

    const answered = await answer(MIGRATE.toolUseId, FOR_TASK)

    const rule = { toolName: 'Bash', ruleContent: 'npm run db:migrate *' }
    expect(answered.grantedRule).toEqual(rule)
    expect(listTaskPermissionRules(database.db, task.id).map((granted) => granted.rule)).toEqual([rule])
    expect(backend.session.options.allowedRules).toEqual([rule])
    expect(sent()).toEqual([permissionsDecidedAfterRestart([answered])])
    expect(sent()[0]).toContain(': allowed, and Bash(npm run db:migrate *) is now allowed for the rest of the task.')
    // Were Claude Code to ask about the call again anyway, it runs without a card, handing the session the rule.
    backend.session.emit(sdk.init())
    const rerun = await callTool(again(MIGRATE))
    await expect(rerun.answer).resolves.toEqual({ ...ALLOWED_BY_YOU, rule })
    expect(requests()).toHaveLength(1)
  })

  it('Deny with a note: tells the agent it was denied, with the note, and a call made again anyway asks', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()

    const answered = await answer(MIGRATE.toolUseId, {
      kind: PermissionDecisionKind.Deny,
      note: '  Not on staging: run them locally.  ',
    })

    expect(answered).toMatchObject({
      state: PermissionRequestState.Denied,
      denyNote: 'Not on staging: run them locally.',
    })
    expect(sent()).toEqual([permissionsDecidedAfterRestart([answered])])
    expect(sent()[0]).toContain(': denied. The user said: Not on staging: run them locally.')
    expect(current().activity).toBe(TaskActivity.Working)
    backend.session.emit(sdk.init())
    const rerun = await callTool(again(MIGRATE))
    expect(await isSettled(rerun.answer)).toBe(false)
    expect(only(`${MIGRATE.toolUseId}_again`).state).toBe(PermissionRequestState.Open)
  })

  it('Deny without a note: just says it was denied', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()

    await answer(MIGRATE.toolUseId, { kind: PermissionDecisionKind.Deny })

    expect(sent()[0]).toContain('"description":"Run the migrations"}: denied.\n')
  })

  it('lets through only the same call: the same tool with the same input, whatever order its keys come in', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    backend.session.emit(sdk.init())

    const other = await callTool({ ...again(MIGRATE, 'toolu_other'), input: { command: 'npm run db:rollback' } })
    const renamed = await callTool({ ...again(MIGRATE, 'toolu_renamed'), toolName: 'Monitor' })
    expect(await isSettled(other.answer)).toBe(false)
    expect(await isSettled(renamed.answer)).toBe(false)
    const reordered = await callTool({
      ...again(MIGRATE, 'toolu_reordered'),
      input: { description: 'Run the migrations', command: 'npm run db:migrate' },
    })
    await expect(reordered.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('lets the call through only in the turn it was told in: once that ends, the same call asks', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    backend.session.emit(sdk.init())
    await finishTurn('I will run them later.')
    expect(restartDeliveryOf(database.db, only(MIGRATE.toolUseId).id)).toBe(RestartDelivery.Settled)

    await startAsking(task.id, 'Run them now.')
    const rerun = await callTool(again(MIGRATE))

    expect(await isSettled(rerun.answer)).toBe(false)
  })

  it('keeps letting the call through when the app quits again before the agent makes it', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    relaunch()

    // The resumed turn carries on, as any turn the app quit in does.
    expect(sent()).toEqual([RESUME_PROMPT])
    backend.session.emit(sdk.init())
    const rerun = await callTool(again(MIGRATE))
    await expect(rerun.answer).resolves.toEqual(ALLOWED_BY_YOU)
  })
})

describe('several requests open at quit', () => {
  /** Two calls in one turn, each waiting on a request, when the app quits. */
  async function twoOpenThenRelaunch(): Promise<void> {
    await startAsking()
    await callTool(MIGRATE)
    await callTool(EDIT)
    relaunch()
  }

  it.each([
    ['in the order they were made', [MIGRATE.toolUseId, EDIT.toolUseId]],
    ['the other way round', [EDIT.toolUseId, MIGRATE.toolUseId]],
  ])('waits for both decisions, answered %s, then sends them in one message', async (_, order) => {
    await twoOpenThenRelaunch()
    const [first = '', second = ''] = order
    const decisions: Record<string, PermissionDecision> = {
      [MIGRATE.toolUseId]: ALLOW_ONCE,
      [EDIT.toolUseId]: { kind: PermissionDecisionKind.Deny, note: 'Leave the changelog to me.' },
    }

    await answer(first, decisions[first] ?? ALLOW_ONCE)

    // One still waits on you: nothing goes to the agent yet.
    expect(backend.sessions).toHaveLength(0)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

    await answer(second, decisions[second] ?? ALLOW_ONCE)

    // Both go, in the order the calls were made, whichever was answered first.
    const decided = [only(MIGRATE.toolUseId), only(EDIT.toolUseId)]
    expect(sent()).toEqual([permissionsDecidedAfterRestart(decided)])
    const [message = ''] = sent()
    expect(message.indexOf('toolu_migrate')).toBeLessThan(message.indexOf('toolu_edit'))
    expect(message).toContain(': allowed once.')
    expect(message).toContain(': denied. The user said: Leave the changelog to me.')
    expect(current()).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    expect(listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.Divider)).toHaveLength(2)
  })

  it('keeps a decision made before the app quit again, and sends it with the last one', async () => {
    await twoOpenThenRelaunch()
    await answer(EDIT.toolUseId, ALLOW_ONCE)

    relaunch()
    expect(backend.sessions).toHaveLength(0)
    expect(only(EDIT.toolUseId).state).toBe(PermissionRequestState.Allowed)
    expect(current().awaitingPermission).toBe(true)
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    expect(sent()).toEqual([permissionsDecidedAfterRestart([only(MIGRATE.toolUseId), only(EDIT.toolUseId)])])
    // Both calls may run once again.
    backend.session.emit(sdk.init())
    await expect((await callTool(again(EDIT))).answer).resolves.toEqual(ALLOWED_BY_YOU)
    await expect((await callTool(again(MIGRATE))).answer).resolves.toEqual(ALLOWED_BY_YOU)
  })

  it('sends decisions on the next launch that the app quit before sending', async () => {
    await twoOpenThenRelaunch()
    await answer(EDIT.toolUseId, ALLOW_ONCE)
    // As if the app died between saving the last decision and sending them.
    closePermissionRequest(database.db, only(MIGRATE.toolUseId).id, {
      state: PermissionRequestState.Denied,
      note: null,
    })

    relaunch()

    expect(sent()).toEqual([permissionsDecidedAfterRestart([only(MIGRATE.toolUseId), only(EDIT.toolUseId)])])
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('one in each of two tasks: each decision resumes only its own task, in its own workspace', async () => {
    const elsewhere = sampleWorkspace(database.db, '/code/acme-dashboard')
    const other = sampleTask(database.db, elsewhere.id)
    updateTask(database.db, other.id, { permissionMode: PermissionMode.AskBeforeEdits })
    await startAsking()
    await callTool(MIGRATE)
    await startAsking(other.id, 'Build the dashboard.')
    await callTool({ ...EDIT, toolUseId: 'toolu_other_edit' })
    // The first task's workspace is the one shown when the app quits.
    setUiState(database.db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
    relaunch()

    for (const id of [task.id, other.id]) {
      expect(current(id)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
      expect(needsYou(current(id))).toBe(true)
    }

    await answer('toolu_other_edit', ALLOW_ONCE, other.id)
    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options.cwd).toBe('/code/acme-dashboard')
    expect(current(other.id).activity).toBe(TaskActivity.Working)
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

    await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.options.cwd).toBe('/code/acme-api')
    expect(current().activity).toBe(TaskActivity.Working)
  })
})

describe('a subagent’s request open at quit', () => {
  it('ends its call and the subagent as interrupted, and tells the agent it was the subagent’s', async () => {
    await startAsking()
    backend.session.emit(sdk.toolUse('toolu_agent', 'Agent', { description: 'Migrations', prompt: 'Run them.' }))
    await settle()
    await callTool({ ...MIGRATE, agentId: 'a1b2c3' }, 'toolu_agent')
    relaunch()

    expect(toolCall(MIGRATE.toolUseId)).toMatchObject({
      state: ToolCallState.Interrupted,
      output: PERMISSION_RESTARTED_NOTE,
    })
    expect(toolCall('toolu_agent')).toMatchObject({ state: ToolCallState.Interrupted, output: RESTARTED_TOOL_NOTE })
    const answered = await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    expect(sent()[0]).toContain(
      "- Your subagent's Bash call (subagent a1b2c3, which ended when Glade quit) toolu_migrate, with input",
    )
    expect(sent()).toEqual([permissionsDecidedAfterRestart([answered])])
    // The agent may make the call itself: it runs without asking.
    backend.session.emit(sdk.init())
    await expect((await callTool(again(MIGRATE))).answer).resolves.toEqual(ALLOWED_BY_YOU)
  })
})

describe('a task that wasn’t just waiting when the app quit', () => {
  it('stays stopped by its error, waiting on you too; deciding resumes it past the error', async () => {
    await startAsking()
    await callTool(MIGRATE)
    const error = {
      kind: AgentErrorKind.Permanent,
      source: TaskErrorSource.Turn,
      status: null,
      code: null,
      details: 'The turn failed (max_turns).',
      retries: 0,
      retryingMs: 0,
    }
    updateTask(database.db, task.id, { activity: TaskActivity.Error, error })
    relaunch()

    expect(current()).toMatchObject({ activity: TaskActivity.Error, error, awaitingPermission: true })
    expect(needsYou(current())).toBe(true)

    await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    expect(sent()).toHaveLength(1)
    expect(current()).toMatchObject({ activity: TaskActivity.Working, error: null })
  })

  it('stays paused until its pause is due, then waits on you rather than retrying; deciding resumes it', async () => {
    await startAsking()
    await callTool(MIGRATE)
    const pause = {
      reason: PauseReason.UsageLimit,
      since: Date.now() - 60_000,
      resumesAt: Date.now() - 1_000,
      checks: 0,
      details: 'You have hit your session limit.',
    }
    updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
    relaunch()
    expect(current()).toMatchObject({ activity: TaskActivity.Paused, awaitingPermission: true })

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, pause: null, awaitingPermission: true })
    expect(backend.sessions).toHaveLength(0)
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    expect(sent()).toHaveLength(1)
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('still resumes a paused task as usual once its pause is due, when nothing waits on you', async () => {
    await startAsking()
    await callTool(MIGRATE)
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    const pause = {
      reason: PauseReason.UsageLimit,
      since: Date.now() - 60_000,
      resumesAt: Date.now() - 1_000,
      checks: 0,
      details: 'You have hit your session limit.',
    }
    backend.session.emit(sdk.toolResult(MIGRATE.toolUseId, 'Applied.'))
    await settle()
    updateTask(database.db, task.id, { activity: TaskActivity.Paused, pause })
    relaunch()

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(sent()).toEqual(['Run the migrations, then note them in the changelog.'])
  })
})

describe('after a relaunch, before you decide', () => {
  it('Stop withdraws the request, and the agent is told nothing', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()

    const stopped = (await glade.invoke(CommandName.TasksStop, { id: task.id })).task

    expect(only(MIGRATE.toolUseId).state).toBe(PermissionRequestState.Withdrawn)
    expect(stopped).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: false })
    expect(backend.sessions).toHaveLength(0)
    await expect(answer(MIGRATE.toolUseId, ALLOW_ONCE)).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
    })
    // The next message starts a turn as usual, and nothing lets the call through without asking.
    await startAsking(task.id, 'Run them after all.')
    expect(sent()).toEqual(['Run them after all.'])
    expect(await isSettled((await callTool(again(MIGRATE))).answer)).toBe(false)
  })

  it('Stop drops the decisions already made on the others too', async () => {
    await startAsking()
    await callTool(MIGRATE)
    await callTool(EDIT)
    relaunch()
    await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    await glade.invoke(CommandName.TasksStop, { id: task.id })

    expect(requests().map(({ state }) => state)).toEqual([
      PermissionRequestState.Allowed,
      PermissionRequestState.Withdrawn,
    ])
    expect(backend.sessions).toHaveLength(0)
    relaunch()
    expect(backend.sessions).toHaveLength(0)
  })

  it('a message sent meanwhile is queued, and follows once the decision has carried the turn on', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()

    await expect(
      glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Also seed the data.' }),
    ).rejects.toMatchObject({
      code: BridgeErrorCode.Busy,
    })
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Also seed the data.' })
    expect(backend.sessions).toHaveLength(0)
    expect(listQueuedMessages(database.db, task.id).map(({ body }) => body)).toEqual(['Also seed the data.'])
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

    await answer(MIGRATE.toolUseId, ALLOW_ONCE)
    expect(sent()).toHaveLength(1)
    backend.session.emit(sdk.init())
    const rerun = await callTool(again(MIGRATE))
    await expect(rerun.answer).resolves.toEqual(ALLOWED_BY_YOU)
    // Once the agent's step is done, the queue goes to it, in the turn the decision carried on.
    backend.session.emit(sdk.toolResult(`${MIGRATE.toolUseId}_again`, 'Applied 3 migrations.'))
    await settle()
    expect(sent().slice(1)).toEqual(['Also seed the data.'])
    expect(listMessages(database.db, task.id).map(({ body, turn }) => [body, turn])).toEqual([
      ['Run the migrations, then note them in the changelog.', 1],
      ['Also seed the data.', 1],
    ])
  })

  it('refuses a decision while the agent is busy compacting, and keeps the request open', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })

    await expect(answer(MIGRATE.toolUseId, ALLOW_ONCE)).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
    expect(only(MIGRATE.toolUseId).state).toBe(PermissionRequestState.Open)

    // Once it has compacted, the decision goes to the same session, which lets the call through with its rule.
    backend.session.emit(...sdk.compaction(40_000, 8_000), sdk.compactResult())
    await settle()
    await answer(MIGRATE.toolUseId, FOR_TASK)
    expect(backend.sessions).toHaveLength(1)
    expect(sent().at(-1)).toContain(PERMISSIONS_DECIDED_AFTER_RESTART_PROMPT)
    backend.session.emit(sdk.init())
    await expect((await callTool(again(MIGRATE))).answer).resolves.toEqual({
      ...ALLOWED_BY_YOU,
      rule: { toolName: 'Bash', ruleContent: 'npm run db:migrate *' },
    })
  })

  it('deciding after the task was marked done carries the turn on, and the task stays done', async () => {
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })
    expect(current()).toMatchObject({ state: TaskState.Done, awaitingPermission: true })

    await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    expect(sent()).toHaveLength(1)
    expect(current()).toMatchObject({ state: TaskState.Done, activity: TaskActivity.Working })
    backend.session.emit(sdk.init())
    await finishTurn()
    expect(current()).toMatchObject({ state: TaskState.Done, activity: TaskActivity.Waiting })
    expect(listMessages(database.db, task.id).at(-1)).toMatchObject({ role: MessageRole.Agent, turn: 1 })
  })

  it('a request that was never left by a restart is answered as before, with no message', async () => {
    await startAsking()
    const asked = await callTool(MIGRATE)

    await answer(MIGRATE.toolUseId, ALLOW_ONCE)

    await expect(asked.answer).resolves.toEqual(ALLOWED_BY_YOU)
    expect(sent()).toEqual(['Run the migrations, then note them in the changelog.'])
    expect(restartDeliveryOf(database.db, only(MIGRATE.toolUseId).id)).toBeNull()
  })

  it('logs and carries on when the decisions can’t be sent on launch', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await startAsking()
    await callTool(MIGRATE)
    relaunch()
    closePermissionRequest(database.db, only(MIGRATE.toolUseId).id, { state: PermissionRequestState.Allowed })
    database.db.pragma('foreign_keys = OFF')
    database.db.prepare('DELETE FROM workspaces').run()

    expect(() => {
      relaunch()
    }).not.toThrow()
    expect(backend.sessions).toHaveLength(0)
    error.mockRestore()
  })
})
