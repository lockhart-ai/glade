// Broadcast (#489): one message to every active task, in every workspace. Scripted agent sessions behind the real
// bridge, saving to a database in a temporary folder, so the command, the runner, the queue and what reaches the
// window are all the app's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import {
  BridgeErrorCode,
  CommandName,
  EVENT_BATCH,
  EventType,
  type GladeBridge,
  type GladeEvent,
  type WindowEvent,
} from '../../shared/bridge'
import { BroadcastDelivery, type BroadcastOutcome } from '../../shared/broadcast'
import {
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionDecisionKind,
  PermissionMode,
  PermissionRequestState,
  QuestionKind,
  QuestionSetState,
  TaskActivity,
  TaskState,
  ToolEventKind,
  type Question,
  type Task,
  type Workspace,
} from '../../shared/domain'
import { FakeAgentBackend, settle, type FakeAgentSession } from '../agent/fake-backend'
import type { AgentRunner } from '../agent/runner'
import * as sdk from '../agent/test-sdk-messages'
import { registerBridge } from '../bridge'
import { CommandFailure } from '../bridge/errors'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { getOpenQuestionSet } from '../db/repositories/question-sets'
import { appendQueuedMessage, listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { createWorkspace } from '../db/repositories/workspaces'
import { LogLevel } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { broadcastMessage } from './broadcast'

const TEXT = "Is anyone restarting Docker? If it's you, stop and tell me why."

let database: TestDatabase
let acme: Workspace
let storefront: Workspace
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
/** Each event the window's store heard on its own, in order. */
let events: GladeEvent[]
/** Each burst the window's store heard as one, in order. */
let batches: (readonly GladeEvent[])[]
/** Everything main sent the window on the event channel, as it sent it. */
let windowMessages: WindowEvent[]
let log: MemoryLog
let clock: number

/** Starts the app's runner on the database, as a launch does. */
function launch(): void {
  backend = new FakeAgentBackend()
  const ipc = fakeIpcPair()
  windowMessages = []
  const window = {
    send(channel: string, event: WindowEvent): void {
      windowMessages.push(event)
      ipc.window.send(channel, event)
    },
  }
  ;({ runner } = registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
    agentBackend: backend,
    log: log.logger,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  batches = []
  glade.subscribe(
    (event) => events.push(event),
    (batch) => batches.push(batch),
  )
}

/** Quits the app, whatever it's doing, and starts it again on the same database, resuming what a launch resumes. */
function relaunch(): void {
  runner.close()
  launch()
  runner.resumeInterrupted()
}

beforeEach(() => {
  log = createMemoryLog()
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  acme = createWorkspace(database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  storefront = createWorkspace(database.db, { name: 'Storefront', rootPath: '/code/storefront' }, 1_100)
  clock = 2_000
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

/** A new active task, waiting on you, later in the list than every task made before it. */
function task(workspace: Workspace = acme): Task {
  clock += 1
  return sampleTask(database.db, workspace.id, clock)
}

function current(id: string): Task {
  const found = getTask(database.db, id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function broadcast(text = TEXT): Promise<readonly BroadcastOutcome[]> {
  return (await glade.invoke(CommandName.TasksBroadcast, { text })).recipients
}

/** A task's chat, as its text and whether each message was a broadcast. */
function chat(id: string): unknown[] {
  return listMessages(database.db, id).map(({ role, body, turn, broadcast: flag }) => ({
    role,
    body,
    turn,
    broadcast: flag,
  }))
}

/** A task's queue, as its text and whether each message is a broadcast. */
function queued(id: string): unknown[] {
  return listQueuedMessages(database.db, id).map(({ body, broadcast: flag }) => ({ body, broadcast: flag }))
}

/** The turn dividers in a task's tool log: one per turn started. */
function turns(id: string): number[] {
  return listToolEvents(database.db, id)
    .filter((event) => event.kind === ToolEventKind.Divider && event.dividerKind === DividerKind.Turn)
    .map(({ turn }) => turn)
}

/** What a session was sent, text only, without the instructions Glade puts ahead of some first messages. */
function sent(session: FakeAgentSession): string[] {
  return session.sent.map(({ text }) => text.split('[end]\n\n').at(-1) ?? text)
}

/** Sends a task its own message, and answers with the session its turn runs in. */
async function start(id: string, text = 'Copy the existing uploads to S3.'): Promise<FakeAgentSession> {
  await glade.invoke(CommandName.TasksSend, { id, text })
  return backend.session
}

/** A task whose agent is mid-turn, waiting on a shell command's result. */
async function working(workspace: Workspace = acme): Promise<{ task: Task; session: FakeAgentSession }> {
  const made = task(workspace)
  const session = await start(made.id)
  session.emit(sdk.init(`session-${made.id}`), sdk.toolUse('toolu_copy', 'Bash', { command: 'python scripts/copy.py' }))
  await settle()
  return { task: made, session }
}

/** A task whose turn is paused on the usage limit. */
function paused(workspace: Workspace = acme): Task {
  const made = task(workspace)
  updateTask(database.db, made.id, {
    activity: TaskActivity.Paused,
    sessionId: `session-${made.id}`,
    pause: {
      reason: PauseReason.UsageLimit,
      since: 1_000,
      resumesAt: Date.now() + 3_600_000,
      checks: 0,
      details: 'Usage limit reached.',
    },
  })
  return made
}

const QUESTIONS: Question[] = [
  { kind: QuestionKind.Pills, prompt: 'Which bucket?', options: ['acme-uploads', 'acme-archive'] },
]

interface AskingTask {
  readonly task: Task
  readonly session: FakeAgentSession
  /** Settles once the agent's `ask` call has returned. */
  readonly returned: Promise<void>
}

/** A task whose agent is mid-turn, waiting on your answers to its question. */
async function asking(workspace: Workspace = acme): Promise<AskingTask> {
  const made = task(workspace)
  const session = await start(made.id)
  session.emit(sdk.init(`session-${made.id}`), sdk.text('One question first.'))
  const returned = session.callTool('toolu_ask', 'mcp__glade__ask', { questions: QUESTIONS }).catch(() => undefined)
  await vi.waitFor(() => {
    if (getOpenQuestionSet(database.db, made.id) === undefined) throw new Error('No question is open yet')
  })
  await settle()
  return { task: made, session, returned }
}

const BASH = { toolUseId: 'toolu_rm', toolName: 'Bash', input: { command: 'rm -rf build' } } as const

/** A task in the ask mode whose agent is mid-turn, waiting on your OK for a shell command. */
async function awaitingPermission(workspace: Workspace = acme): Promise<{ task: Task; session: FakeAgentSession }> {
  const made = task(workspace)
  updateTask(database.db, made.id, { permissionMode: PermissionMode.AskBeforeEdits })
  const session = await start(made.id)
  session.emit(sdk.init(`session-${made.id}`), sdk.toolUse(BASH.toolUseId, BASH.toolName, { ...BASH.input }))
  await settle()
  session.requestPermission(BASH)
  await settle()
  return { task: made, session }
}

/** Forgets what the window has heard so far, so a test reads only what the broadcast sent it. */
function listen(): void {
  events.splice(0)
  batches.splice(0)
  windowMessages.splice(0)
}

describe('an idle task', () => {
  it('starts a turn with the broadcast, saved to its chat as one', async () => {
    const idle = task()

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: idle.id, delivery: BroadcastDelivery.Sent }])
    expect(chat(idle.id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
    expect(turns(idle.id)).toEqual([1])
    expect(current(idle.id).activity).toBe(TaskActivity.Working)
    expect(sent(backend.session)).toEqual([TEXT])
    expect(queued(idle.id)).toEqual([])

    // It's a turn like any other: the agent answers in the task's own chat, which then needs you by the usual rule.
    backend.session.emit(sdk.init(), sdk.result("Not me. I haven't touched Docker in this task."))
    await settle()
    expect(chat(idle.id).at(-1)).toEqual({
      role: MessageRole.Agent,
      body: "Not me. I haven't touched Docker in this task.",
      turn: 1,
      broadcast: false,
    })
    expect(current(idle.id)).toMatchObject({ activity: TaskActivity.Waiting, unread: true })
  })

  it('sends what it had queued first, then the broadcast, in the one turn', async () => {
    // What a failed turn leaves behind: a queue that waits for your next message.
    const idle = task()
    appendQueuedMessage(database.db, { taskId: idle.id, body: 'Keep the original filenames.' })

    await broadcast()

    expect(chat(idle.id)).toEqual([
      { role: MessageRole.User, body: 'Keep the original filenames.', turn: 1, broadcast: false },
      { role: MessageRole.User, body: TEXT, turn: 1, broadcast: true },
    ])
    expect(queued(idle.id)).toEqual([])
    expect(sent(backend.session)).toEqual(['Keep the original filenames.', TEXT])
  })

  it('clears the error that had stopped it, as any message you send does', async () => {
    const stopped = task()
    const session = await start(stopped.id)
    session.fail(new Error('Claude Code process exited with code 1'))
    await settle()
    expect(current(stopped.id).activity).toBe(TaskActivity.Error)

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: stopped.id, delivery: BroadcastDelivery.Sent }])
    expect(current(stopped.id)).toMatchObject({ activity: TaskActivity.Working, error: null })
    expect(chat(stopped.id).at(-1)).toEqual({ role: MessageRole.User, body: TEXT, turn: 2, broadcast: true })
  })

  it('sends it trimmed', async () => {
    const idle = task()

    await broadcast(`\n  ${TEXT}  \n`)

    expect(chat(idle.id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
  })
})

describe('a busy task', () => {
  it('queues the broadcast mid-turn, after what was already queued, and gets it when its step ends', async () => {
    const { task: busy, session } = await working()
    await glade.invoke(CommandName.QueueAdd, { taskId: busy.id, text: 'Keep the original filenames.' })

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: busy.id, delivery: BroadcastDelivery.Queued }])
    expect(queued(busy.id)).toEqual([
      { body: 'Keep the original filenames.', broadcast: false },
      { body: TEXT, broadcast: true },
    ])
    // Nothing reaches the agent mid-step, and no second turn or session starts.
    expect(sent(session)).toEqual(['Copy the existing uploads to S3.'])
    expect(turns(busy.id)).toEqual([1])
    expect(backend.sessions).toHaveLength(1)

    session.emit(sdk.toolResult('toolu_copy', [{ type: 'text', text: 'Copied 3,900 files.' }]))
    await settle()

    expect(queued(busy.id)).toEqual([])
    expect(chat(busy.id)).toEqual([
      { role: MessageRole.User, body: 'Copy the existing uploads to S3.', turn: 1, broadcast: false },
      { role: MessageRole.User, body: 'Keep the original filenames.', turn: 1, broadcast: false },
      { role: MessageRole.User, body: TEXT, turn: 1, broadcast: true },
    ])
    expect(sent(session)).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames.', TEXT])
  })

  it('queues it for a paused task, to go when it resumes', async () => {
    const held = paused()

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: held.id, delivery: BroadcastDelivery.Queued }])
    expect(queued(held.id)).toEqual([{ body: TEXT, broadcast: true }])
    expect(current(held.id).activity).toBe(TaskActivity.Paused)
    expect(chat(held.id)).toEqual([])
    expect(backend.sessions).toHaveLength(0)
  })

  it('queues it for a task waiting on your answers, rather than answering them with it', async () => {
    const { task: waiting, session, returned } = await asking()

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: waiting.id, delivery: BroadcastDelivery.Queued }])
    // The question is still yours to answer: the broadcast went to every task, so it's no answer to this one.
    const open = getOpenQuestionSet(database.db, waiting.id)
    expect(open?.state).toBe(QuestionSetState.Open)
    expect(queued(waiting.id)).toEqual([{ body: TEXT, broadcast: true }])
    expect(chat(waiting.id)).toHaveLength(1)
    expect(current(waiting.id)).toMatchObject({ activity: TaskActivity.Waiting, asking: true })

    // Once you answer, the agent's step ends and it gets the broadcast, tagged as one.
    await glade.invoke(CommandName.QuestionsAnswer, { id: open?.id ?? '', answers: { 0: 'acme-uploads' } })
    await returned
    await settle()
    expect(queued(waiting.id)).toEqual([])
    expect(chat(waiting.id).at(-1)).toEqual({ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true })
    expect(sent(session).at(-1)).toBe(TEXT)
  })

  it('queues it for a task waiting on your OK for a tool call', async () => {
    const { task: waiting, session } = await awaitingPermission()

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: waiting.id, delivery: BroadcastDelivery.Queued }])
    expect(queued(waiting.id)).toEqual([{ body: TEXT, broadcast: true }])
    expect(listPermissionRequests(database.db, waiting.id).map(({ state }) => state)).toEqual([
      PermissionRequestState.Open,
    ])
    expect(current(waiting.id)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(sent(session)).toEqual(['Copy the existing uploads to S3.'])
  })
})

describe('a task waiting on something the app quit on', () => {
  it('holds the broadcast behind the question, and sends it once the question is answered', async () => {
    const { task: waiting } = await asking()
    relaunch()
    expect(current(waiting.id)).toMatchObject({ activity: TaskActivity.Waiting, asking: true })

    const recipients = await broadcast()

    // No turn runs to deliver it, and it must not start one over the open question.
    expect(recipients).toEqual([{ taskId: waiting.id, delivery: BroadcastDelivery.Queued }])
    expect(queued(waiting.id)).toEqual([{ body: TEXT, broadcast: true }])
    expect(backend.sessions).toHaveLength(0)
    expect(turns(waiting.id)).toEqual([1])
    const open = getOpenQuestionSet(database.db, waiting.id)
    expect(open?.state).toBe(QuestionSetState.Open)

    // The answer carries on the turn that asked; when it ends, the queue starts the next one.
    await glade.invoke(CommandName.QuestionsAnswer, { id: open?.id ?? '', answers: { 0: 'acme-uploads' } })
    expect(backend.sessions).toHaveLength(1)
    expect(queued(waiting.id)).toEqual([{ body: TEXT, broadcast: true }])
    backend.session.emit(sdk.init(`session-${waiting.id}`), sdk.result('Copying to acme-uploads.'))
    await settle()

    expect(queued(waiting.id)).toEqual([])
    expect(chat(waiting.id).at(-1)).toEqual({ role: MessageRole.User, body: TEXT, turn: 2, broadcast: true })
    expect(sent(backend.session).at(-1)).toBe(TEXT)
  })

  it('holds the broadcast behind the permission request, and sends it after your decision', async () => {
    const { task: waiting } = await awaitingPermission()
    relaunch()
    expect(current(waiting.id)).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: waiting.id, delivery: BroadcastDelivery.Queued }])
    expect(queued(waiting.id)).toEqual([{ body: TEXT, broadcast: true }])
    expect(backend.sessions).toHaveLength(0)

    const [request] = listPermissionRequests(database.db, waiting.id)
    await glade.invoke(CommandName.PermissionsAnswer, {
      id: request?.id ?? '',
      decision: { kind: PermissionDecisionKind.Deny },
    })
    backend.session.emit(sdk.init(`session-${waiting.id}`), sdk.result('Left the build folder alone.'))
    await settle()

    expect(queued(waiting.id)).toEqual([])
    expect(chat(waiting.id).at(-1)).toEqual({ role: MessageRole.User, body: TEXT, turn: 2, broadcast: true })
  })
})

describe('who gets it', () => {
  it('sends nothing to a done task, pinned or not', async () => {
    const done = task()
    const pinnedDone = task()
    const active = task()
    await glade.invoke(CommandName.TasksMarkDone, { id: done.id })
    await glade.invoke(CommandName.TasksUpdate, { id: pinnedDone.id, patch: { pinned: true } })
    await glade.invoke(CommandName.TasksMarkDone, { id: pinnedDone.id })

    const recipients = await broadcast()

    expect(recipients).toEqual([{ taskId: active.id, delivery: BroadcastDelivery.Sent }])
    for (const { id } of [done, pinnedDone]) {
      expect(chat(id)).toEqual([])
      expect(queued(id)).toEqual([])
      expect(current(id).state).toBe(TaskState.Done)
    }
    expect(backend.sessions).toHaveLength(1)
  })

  it('says so, and sends nothing, with no active task anywhere', async () => {
    const done = task()
    await glade.invoke(CommandName.TasksMarkDone, { id: done.id })
    listen()

    expect(await broadcast()).toEqual([])

    expect(windowMessages).toEqual([])
    expect(backend.sessions).toHaveLength(0)
  })

  it('is decided as it is sent: a task marked done a moment before gets nothing, and a new one gets it', async () => {
    const first = task()
    const second = task(storefront)
    // The window lists both, then one is marked done and another made before Send reaches main.
    await glade.invoke(CommandName.TasksMarkDone, { id: first.id })
    const { task: created } = await glade.invoke(CommandName.TasksCreate, { workspaceId: storefront.id })

    const recipients = await broadcast()

    expect(recipients.map(({ taskId }) => taskId).sort()).toEqual([created.id, second.id].sort())
    expect(chat(first.id)).toEqual([])
    expect(chat(created.id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
  })

  it('reaches every active task in every workspace once, each in its own way, pinned ones first', async () => {
    const idle = task()
    const { task: busy } = await working()
    const held = paused()
    const { task: questioned } = await asking(storefront)
    const { task: permitted } = await awaitingPermission(storefront)
    const done = task(storefront)
    await glade.invoke(CommandName.TasksMarkDone, { id: done.id })
    const pinnedIdle = task(storefront)
    await glade.invoke(CommandName.TasksUpdate, { id: pinnedIdle.id, patch: { pinned: true } })
    const sessionsBefore = backend.sessions.length

    const recipients = await broadcast()

    const delivery = Object.fromEntries(recipients.map((outcome) => [outcome.taskId, outcome.delivery]))
    expect(delivery).toEqual({
      [idle.id]: BroadcastDelivery.Sent,
      [pinnedIdle.id]: BroadcastDelivery.Sent,
      [busy.id]: BroadcastDelivery.Queued,
      [held.id]: BroadcastDelivery.Queued,
      [questioned.id]: BroadcastDelivery.Queued,
      [permitted.id]: BroadcastDelivery.Queued,
    })
    expect(recipients).toHaveLength(6)
    expect(recipients[0]?.taskId).toBe(pinnedIdle.id)
    // Exactly once each: in the chat of the two it started a turn in, in the queue of the four that were busy.
    for (const { id } of [idle, pinnedIdle]) {
      expect(chat(id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
      expect(queued(id)).toEqual([])
    }
    for (const { id } of [busy, held, questioned, permitted]) {
      expect(queued(id)).toEqual([{ body: TEXT, broadcast: true }])
      expect(listMessages(database.db, id).some((message) => message.broadcast)).toBe(false)
    }
    expect(chat(done.id)).toEqual([])
    expect(queued(done.id)).toEqual([])
    // Only the two idle tasks needed a session started.
    expect(backend.sessions).toHaveLength(sessionsBefore + 2)
  })
})

describe('a task that can’t take it', () => {
  it('doesn’t stop the others, and is reported with why', async () => {
    const first = task()
    const broken = task(storefront)
    const last = task()
    // The session for the Storefront task can't be started; the others' can.
    const startSession = backend.start.bind(backend)
    vi.spyOn(backend, 'start').mockImplementation((options) => {
      if (options.cwd === storefront.rootPath) throw new Error('spawn claude ENOENT')
      return startSession(options)
    })

    const recipients = await broadcast()

    const outcome = Object.fromEntries(recipients.map((each) => [each.taskId, each]))
    expect(outcome[first.id]).toEqual({ taskId: first.id, delivery: BroadcastDelivery.Sent })
    expect(outcome[last.id]).toEqual({ taskId: last.id, delivery: BroadcastDelivery.Sent })
    expect(outcome[broken.id]).toEqual({
      taskId: broken.id,
      delivery: BroadcastDelivery.Failed,
      message: 'spawn claude ENOENT',
    })
    // Nothing was saved to the task that failed, and it's as it was.
    expect(chat(broken.id)).toEqual([])
    expect(queued(broken.id)).toEqual([])
    expect(current(broken.id).activity).toBe(TaskActivity.Waiting)
    for (const { id } of [first, last]) {
      expect(chat(id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
      expect(current(id).activity).toBe(TaskActivity.Working)
    }
    // The log says which task, and why, but never what you wrote.
    const [record] = log.withMessage('broadcast not delivered')
    expect(record).toMatchObject({ level: LogLevel.Warn, fields: { taskId: broken.id, error: 'spawn claude ENOENT' } })
    expect(JSON.stringify(record)).not.toContain('Docker')
  })

  it('shows its error card when its session fails once started, as any failed send does, and no other task’s', async () => {
    const failing = task()
    const fine = task(storefront)

    await broadcast()
    const sessionOf = (id: string): FakeAgentSession => {
      const [message] = listMessages(database.db, id)
      const found = backend.sessions.find((session) => session.sent.some(({ uuid }) => uuid === message?.id))
      if (found === undefined) throw new Error(`No session for ${id}`)
      return found
    }
    sessionOf(failing.id).fail(new Error('Claude Code process exited with code 1'))
    sessionOf(fine.id).emit(sdk.init(), sdk.result('Not me.'))
    await settle()

    // Its message is in its chat, with the error under it: Retry sends it again.
    expect(chat(failing.id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
    expect(current(failing.id)).toMatchObject({
      activity: TaskActivity.Error,
      error: { details: 'The agent stopped: Claude Code process exited with code 1' },
    })
    expect(current(fine.id)).toMatchObject({ activity: TaskActivity.Waiting, error: null })
    expect(chat(fine.id).at(-1)).toMatchObject({ role: MessageRole.Agent, body: 'Not me.' })
  })

  it('reports a task whose queue can’t take it, and one that fails with something other than an error', () => {
    const first = task()
    const second = task()
    const stub: Pick<AgentRunner, 'send' | 'queue'> = {
      send: () => {
        throw new CommandFailure(BridgeErrorCode.Busy, 'The agent is working; queue the message instead')
      },
      queue: (taskId) => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- what a broken dependency might throw
        if (taskId === first.id) throw 'database is locked'
        throw new CommandFailure(BridgeErrorCode.NotFound, `No task ${taskId}`)
      },
    }

    const recipients = broadcastMessage({ db: database.db, runner: stub }, TEXT)

    expect(recipients).toEqual([
      { taskId: second.id, delivery: BroadcastDelivery.Failed, message: `No task ${second.id}` },
      { taskId: first.id, delivery: BroadcastDelivery.Failed, message: 'database is locked' },
    ])
  })
})

describe('what the window hears', () => {
  it('is one batch for the whole broadcast, with each task’s changes in it', async () => {
    const idle = task()
    const { task: busy } = await working(storefront)
    listen()

    await broadcast()

    // One message on the event channel, applied by the window in one change.
    expect(windowMessages).toHaveLength(1)
    expect(windowMessages[0]?.type).toBe(EVENT_BATCH)
    expect(events).toEqual([])
    expect(batches).toHaveLength(1)
    const [batch = []] = batches
    expect(batch).toContainEqual({
      type: EventType.MessageAppended,
      message: expect.objectContaining({ taskId: idle.id, body: TEXT, broadcast: true }) as unknown,
    })
    expect(batch).toContainEqual({
      type: EventType.TaskUpdated,
      task: expect.objectContaining({ id: idle.id, activity: TaskActivity.Working }) as unknown,
    })
    expect(batch).toContainEqual({
      type: EventType.QueueChanged,
      taskId: busy.id,
      queuedMessages: [expect.objectContaining({ body: TEXT, broadcast: true })],
    })
  })

  it('is still one message for 60 tasks in 8 workspaces', async () => {
    const workspaces = Array.from({ length: 8 }, (_, index) =>
      createWorkspace(
        database.db,
        { name: `Workspace ${String(index + 1)}`, rootPath: `/code/workspace-${String(index + 1)}` },
        2_000 + index,
      ),
    )
    const tasks = Array.from({ length: 60 }, (_, index) => {
      const workspace = workspaces[index % workspaces.length] ?? acme
      return sampleTask(database.db, workspace.id, 3_000 + index)
    })
    listen()

    const recipients = await broadcast()

    expect(recipients).toHaveLength(60)
    expect(new Set(recipients.map(({ taskId }) => taskId))).toEqual(new Set(tasks.map(({ id }) => id)))
    expect(recipients.every(({ delivery }) => delivery === BroadcastDelivery.Sent)).toBe(true)
    expect(windowMessages).toHaveLength(1)
    expect(batches).toHaveLength(1)
    expect(batches[0]?.filter(({ type }) => type === EventType.MessageAppended)).toHaveLength(60)
    expect(backend.sessions).toHaveLength(60)
    for (const { id } of tasks)
      expect(chat(id)).toEqual([{ role: MessageRole.User, body: TEXT, turn: 1, broadcast: true }])
  })

  it('keeps the broadcast a broadcast across a relaunch, in the chat and in the queue', async () => {
    const idle = task()
    const held = paused(storefront)
    await broadcast()

    runner.close()
    launch()

    const sentHistory = await glade.invoke(CommandName.TasksHistory, { id: idle.id })
    expect(sentHistory.messages).toMatchObject([{ body: TEXT, broadcast: true }])
    const queuedHistory = await glade.invoke(CommandName.TasksHistory, { id: held.id })
    expect(queuedHistory.queuedMessages).toMatchObject([{ body: TEXT, broadcast: true }])
  })
})

describe('the command', () => {
  it('refuses a blank message, sending nothing', async () => {
    const idle = task()

    await expect(broadcast('  \n ')).rejects.toMatchObject({ code: BridgeErrorCode.InvalidRequest })

    expect(chat(idle.id)).toEqual([])
    expect(backend.sessions).toHaveLength(0)
  })

  it('leaves a message you send to one task untagged', async () => {
    const own = task()

    await start(own.id, 'Fix the flaky login test.')
    await glade.invoke(CommandName.QueueAdd, { taskId: own.id, text: 'And say what caused it.' })

    expect(chat(own.id)).toEqual([
      { role: MessageRole.User, body: 'Fix the flaky login test.', turn: 1, broadcast: false },
    ])
    expect(queued(own.id)).toEqual([{ body: 'And say what caused it.', broadcast: false }])
  })

  it('says how many tasks it reached in the log, never what it said', async () => {
    task()
    paused()

    await broadcast()

    expect(log.withMessage('broadcast sent')).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({ tasks: 2, sent: 1, queued: 1, failed: 0 }) as unknown,
      }),
    ])
    expect(JSON.stringify(log.withMessage('broadcast sent'))).not.toContain('Docker')
  })
})
