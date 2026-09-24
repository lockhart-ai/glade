// The agent runner's pauses end to end (`./pauses`): a turn that hits the usage limit or loses the network pauses its
// task, and a timer resumes it on its own. A scripted agent session behind the real bridge, with fake timers and clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge } from '../../shared/bridge'
import {
  API_TOOL_NAME,
  MessageRole,
  PauseReason,
  TaskActivity,
  TaskErrorSource,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Task,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { FakeAgentBackend, settle, type FakeAgentSession } from './fake-backend'
import { OFFLINE_FIRST_CHECK_MS, USAGE_LIMIT_FALLBACK_MS } from './pauses'
import { PAUSED_TOOL_NOTE, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

const NOW = 1_790_000_000_000
/** When the usage limit resets in these tests: half an hour on, to the second, as the SDK gives it. */
const RESETS_AT = NOW + 30 * 60_000

let database: TestDatabase
let workspace: Workspace
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let online: boolean

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
    agentBackend: backend,
    isOnline: () => online,
  }))
  glade = createBridge(ipc.renderer)
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  // Only the timers and the clock: `settle` waits on setImmediate.
  vi.useFakeTimers({ now: NOW, toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  online = true
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function newTask(): Task {
  const task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  return task
}

function current(task: Task): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** The session the runner started for a task, found by the message it was sent. */
function sessionOf(text: string): FakeAgentSession {
  const session = backend.sessions.findLast((candidate) => candidate.sent.some((sent) => sent.text === text))
  if (session === undefined) throw new Error(`No session was sent ${text}`)
  return session
}

async function send(task: Task, text: string): Promise<FakeAgentSession> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  return sessionOf(text)
}

/** Starts a copy in the task that runs into the usage limit after its first tool call. */
async function hitUsageLimit(task: Task, text: string): Promise<void> {
  const session = await send(task, text)
  session.emit(
    sdk.init(),
    ...sdk.turnStartNoise(),
    sdk.text("I'll copy the uploads."),
    sdk.toolUse('toolu_01', 'Bash', { command: 'python copy.py' }),
    sdk.toolResult('toolu_01', 'copied 1,240 of 3,900'),
    sdk.toolUse('toolu_02', 'Bash', { command: 'python copy.py --resume' }),
    ...sdk.usageLimitTurnEnd(RESETS_AT / 1000),
  )
  await settle()
}

/** Finishes the session's running turn with a reply. */
async function finish(session: FakeAgentSession, reply: string): Promise<void> {
  const uuid = session.sent.at(-1)?.uuid
  session.emit(sdk.init(), ...sdk.turnStartNoise(), sdk.text(reply), sdk.result(reply, { user_message_uuids: [uuid] }))
  await settle()
}

function replies(task: Task): string[] {
  return listMessages(database.db, task.id)
    .filter((message) => message.role === MessageRole.Agent)
    .map((message) => message.body)
}

/** Lets the fake clock run on, firing whatever timers fall due. */
async function wait(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

describe('a usage limit', () => {
  it('pauses each task it stops until the limit resets, then resumes them on their own and they finish', async () => {
    const copy = newTask()
    const tests = newTask()
    await hitUsageLimit(copy, 'Move the uploads to S3.')
    await hitUsageLimit(tests, 'Fix the flaky login test.')

    for (const task of [copy, tests]) {
      expect(current(task)).toMatchObject({
        activity: TaskActivity.Paused,
        error: null,
        retrying: null,
        pause: {
          reason: PauseReason.UsageLimit,
          since: NOW,
          resumesAt: RESETS_AT,
          checks: 0,
          details: sdk.USAGE_LIMIT_ERROR,
        },
      })
    }

    await wait(RESETS_AT - NOW - 1)
    expect(current(copy).activity).toBe(TaskActivity.Paused)

    await wait(1)
    for (const [task, text] of [
      [copy, 'Move the uploads to S3.'],
      [tests, 'Fix the flaky login test.'],
    ] as const) {
      expect(current(task)).toMatchObject({ activity: TaskActivity.Working, pause: null })
      // The same turn again, in the same session.
      expect(sessionOf(text).sent.map((sent) => sent.text)).toEqual([text, text])
    }
    expect(backend.sessions).toHaveLength(2)

    await finish(sessionOf('Move the uploads to S3.'), 'All 3,900 files are copied.')
    await finish(sessionOf('Fix the flaky login test.'), 'The login test passes.')
    expect(current(copy)).toMatchObject({ activity: TaskActivity.Waiting, pause: null })
    expect(current(tests)).toMatchObject({ activity: TaskActivity.Waiting, pause: null })
    expect(replies(copy)).toEqual(['All 3,900 files are copied.'])
    expect(replies(tests)).toEqual(['The login test passes.'])
  })

  it('logs no failed API row, ends unfinished calls as paused, and keeps what the turn saved', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')

    const log = listToolEvents(database.db, task.id)
    expect(log.some((event) => event.kind === ToolEventKind.ToolCall && event.name === API_TOOL_NAME)).toBe(false)
    expect(log.filter((event) => event.kind === ToolEventKind.ToolCall)).toMatchObject([
      { state: ToolCallState.Done, output: 'copied 1,240 of 3,900' },
      { state: ToolCallState.Paused, output: PAUSED_TOOL_NOTE },
    ])
    expect(log).toContainEqual(
      expect.objectContaining({ kind: ToolEventKind.Narration, text: "I'll copy the uploads." }),
    )
  })

  it('shows the paused calls as interrupted once the task resumes, and tells the window', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')
    const updated: unknown[] = []
    glade.subscribe((event) => {
      if (event.type === EventType.ToolEventUpdated) updated.push(event.toolEvent)
    })

    await wait(RESETS_AT - NOW)

    expect(current(task).activity).toBe(TaskActivity.Working)
    const calls = listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.ToolCall)
    expect(calls).toMatchObject([
      { state: ToolCallState.Done, output: 'copied 1,240 of 3,900' },
      { state: ToolCallState.Interrupted, output: PAUSED_TOOL_NOTE },
    ])
    expect(updated).toEqual([calls[1]])
  })

  it('queues messages sent meanwhile, and delivers them once the resumed turn ends', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')
    const session = sessionOf('Move the uploads to S3.')

    await expect(
      glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Keep the filenames.' }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.Busy })
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Keep the filenames.' })
    expect(listQueuedMessages(database.db, task.id).map((message) => message.body)).toEqual(['Keep the filenames.'])
    expect(session.sent).toHaveLength(1)
    expect(current(task).activity).toBe(TaskActivity.Paused)

    await wait(RESETS_AT - NOW)
    expect(session.sent.map((sent) => sent.text)).toEqual(['Move the uploads to S3.', 'Move the uploads to S3.'])

    await finish(session, 'All 3,900 files are copied.')
    expect(session.sent.at(-1)?.text).toBe('Keep the filenames.')
    expect(listQueuedMessages(database.db, task.id)).toEqual([])
    expect(current(task).activity).toBe(TaskActivity.Working)
  })

  it('tries again after a while when the SDK gave no reset time, and pauses again if the limit still holds', async () => {
    const task = newTask()
    const session = await send(task, 'Move the uploads to S3.')
    session.emit(
      sdk.init(),
      sdk.apiErrorMessage('rate_limit', sdk.USAGE_LIMIT_ERROR),
      sdk.apiErrorResult(sdk.USAGE_LIMIT_ERROR, 429),
    )
    await settle()
    expect(current(task).pause).toMatchObject({ resumesAt: NOW + USAGE_LIMIT_FALLBACK_MS })

    await wait(USAGE_LIMIT_FALLBACK_MS)
    expect(current(task).activity).toBe(TaskActivity.Working)
    session.emit(sdk.init(), ...sdk.usageLimitTurnEnd(RESETS_AT / 1000 + 3600))
    await settle()

    expect(current(task)).toMatchObject({
      activity: TaskActivity.Paused,
      pause: { reason: PauseReason.UsageLimit, resumesAt: RESETS_AT + 3_600_000 },
    })
  })

  it('stops a 429 with an error card when the limit is not what rejected it', async () => {
    const task = newTask()
    const session = await send(task, 'Move the uploads to S3.')
    session.emit(
      sdk.init(),
      sdk.rateLimit('allowed'),
      sdk.apiErrorMessage('rate_limit', 'Too many requests'),
      sdk.apiErrorResult('Too many requests', 429),
    )
    await settle()

    expect(current(task)).toMatchObject({ activity: TaskActivity.Error, pause: null })
  })

  it('arms the pause again on relaunch, and resumes the saved session when it is due', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')
    runner.close()
    await wait(10 * 60_000)
    launch()

    runner.resumeInterrupted()
    await wait(RESETS_AT - NOW - 10 * 60_000 - 1)
    expect(backend.sessions).toHaveLength(0)

    await wait(1)
    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(backend.session.sent.map((sent) => sent.text)).toEqual(['Move the uploads to S3.'])
    expect(current(task).activity).toBe(TaskActivity.Working)
  })

  it('resumes at once on relaunch when the limit reset while the app was closed', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')
    runner.close()
    await wait(RESETS_AT - NOW + 60_000)
    launch()

    runner.resumeInterrupted()
    await wait(0)
    expect(current(task).activity).toBe(TaskActivity.Working)
  })

  it('leaves a paused task alone when its time comes if it was marked done or resumed meanwhile', async () => {
    const done = newTask()
    const retried = newTask()
    await hitUsageLimit(done, 'Move the uploads to S3.')
    await hitUsageLimit(retried, 'Fix the flaky login test.')
    await glade.invoke(CommandName.TasksMarkDone, { id: done.id })
    await glade.invoke(CommandName.TasksRetry, { id: retried.id })
    const sent = sessionOf('Fix the flaky login test.').sent.length

    await wait(RESETS_AT - NOW)

    expect(current(done).activity).toBe(TaskActivity.Paused)
    expect(sessionOf('Move the uploads to S3.').sent).toHaveLength(1)
    expect(sessionOf('Fix the flaky login test.').sent).toHaveLength(sent)
  })

  it('stops the task on an error when it cannot be resumed', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')
    runner.close()
    launch()
    vi.spyOn(backend, 'start').mockImplementation(() => {
      throw new Error('spawn claude ENOENT')
    })

    runner.resumeInterrupted()
    await wait(RESETS_AT - NOW)

    expect(current(task)).toMatchObject({
      activity: TaskActivity.Error,
      pause: null,
      error: { source: TaskErrorSource.Session, details: "Glade couldn't resume the agent: spawn claude ENOENT" },
    })
  })

  it('refuses to compact a paused task', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')

    await expect(glade.invoke(CommandName.TasksCompact, { id: task.id })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
    })
  })
})

describe('switching model', () => {
  it('resumes a paused task at once on the new model, which becomes its own', async () => {
    const task = newTask()
    await hitUsageLimit(task, 'Move the uploads to S3.')
    const session = sessionOf('Move the uploads to S3.')

    const { task: resumed } = await glade.invoke(CommandName.TasksRetry, { id: task.id, model: 'claude-sonnet-5' })

    expect(resumed).toMatchObject({ model: 'claude-sonnet-5', activity: TaskActivity.Working, pause: null })
    expect(session.sent.at(-1)).toMatchObject({
      text: 'Move the uploads to S3.',
      settings: { model: 'claude-sonnet-5' },
    })
    await finish(session, 'All 3,900 files are copied.')
    expect(current(task)).toMatchObject({ activity: TaskActivity.Waiting, model: 'claude-sonnet-5' })

    // Its old timer is gone: nothing runs the turn again at the reset.
    await wait(RESETS_AT - NOW)
    expect(session.sent).toHaveLength(2)
  })
})

describe('going offline', () => {
  it('pauses the task, checks for the network with growing waits, and resumes once it is back', async () => {
    online = false
    const task = newTask()
    const session = await send(task, 'Move the uploads to S3.')
    session.emit(sdk.init(), ...sdk.offlineTurnEnd())
    await settle()

    expect(current(task)).toMatchObject({
      activity: TaskActivity.Paused,
      pause: {
        reason: PauseReason.Offline,
        resumesAt: NOW + OFFLINE_FIRST_CHECK_MS,
        checks: 0,
        details: sdk.CONNECTION_ERROR,
      },
    })

    await wait(OFFLINE_FIRST_CHECK_MS)
    expect(current(task)).toMatchObject({
      activity: TaskActivity.Paused,
      pause: { checks: 1, resumesAt: NOW + OFFLINE_FIRST_CHECK_MS + 10_000 },
    })
    expect(session.sent).toHaveLength(1)

    online = true
    await wait(10_000)
    expect(current(task)).toMatchObject({ activity: TaskActivity.Working, pause: null })
    expect(session.sent.map((sent) => sent.text)).toEqual(['Move the uploads to S3.', 'Move the uploads to S3.'])

    await finish(session, 'All 3,900 files are copied.')
    expect(current(task).activity).toBe(TaskActivity.Waiting)
  })

  it('pauses the task when the agent process fails for want of the network', async () => {
    const task = newTask()
    const session = await send(task, 'Move the uploads to S3.')
    session.emit(sdk.init(), sdk.toolUse('toolu_01', 'Bash', { command: 'python copy.py' }))
    session.fail(new Error('getaddrinfo ENOTFOUND api.anthropic.com'))
    await settle()

    expect(current(task)).toMatchObject({ activity: TaskActivity.Paused, pause: { reason: PauseReason.Offline } })
    expect(listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.ToolCall)).toMatchObject(
      [{ state: ToolCallState.Paused }],
    )

    await wait(OFFLINE_FIRST_CHECK_MS)
    // The session is gone, so it starts again, resumed.
    expect(backend.sessions).toHaveLength(2)
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
  })
})
