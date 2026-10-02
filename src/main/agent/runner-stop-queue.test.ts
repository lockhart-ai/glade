// Stop with messages queued (#441): Stop ends the turn, and the queue then starts the next one, as it does when a turn
// ends on its own. A task already stuck with its queue (stopped before the fix) sends it on launch. A scripted agent
// session behind the real bridge, saving to a database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  PauseReason,
  PermissionMode,
  PermissionRequestState,
  QuestionKind,
  QuestionSetState,
  TaskActivity,
  TaskErrorSource,
  AgentErrorKind,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Question,
  type Task,
  type ToolCallEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { listPermissionRequests } from '../db/repositories/permission-requests'
import { getOpenQuestionSet, listQuestionSets } from '../db/repositories/question-sets'
import { appendQueuedMessage, listQueuedMessages } from '../db/repositories/queued-messages'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { LogLevel } from '../logging/logger'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle, type AskedPermission } from './fake-backend'
import { COMPACT_COMMAND, STOPPED_NOTE, type AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]
let log: MemoryLog

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
    log: log.logger,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
}

/** Quits the app, whatever it's doing, and starts it again on the same database, without resuming anything yet. */
function relaunch(): void {
  runner.close()
  launch()
}

beforeEach(() => {
  log = createMemoryLog()
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

function current(id = task.id): Task {
  const found = getTask(database.db, id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
}

async function queue(text: string): Promise<string> {
  return (await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text })).queuedMessage.id
}

async function stop(): Promise<Task> {
  return (await glade.invoke(CommandName.TasksStop, { id: task.id })).task
}

function queued(id = task.id): string[] {
  return listQueuedMessages(database.db, id).map(({ body }) => body)
}

/**
 * What a session was sent, text only, the task's latest unless given: each message without the instructions Glade puts
 * ahead of the first one a session it didn't start gets (`contextBlock`).
 */
function sent(session = backend.session): string[] {
  return session.sent.map(({ text }) => text.split('[end]\n\n').at(-1) ?? text)
}

function chat(id = task.id): unknown[] {
  return listMessages(database.db, id).map(({ role, body, turn }) => ({ role, body, turn }))
}

function toolCall(toolUseId: string): ToolCallEvent {
  const found = listToolEvents(database.db, task.id).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

/** The turn dividers in the tool log: one per turn started. */
function turns(id = task.id): number[] {
  return listToolEvents(database.db, id)
    .filter((event) => event.kind === ToolEventKind.Divider && event.dividerKind === DividerKind.Turn)
    .map(({ turn }) => turn)
}

/** The activity of each change to the task the window heard of, in order. */
function activities(): TaskActivity[] {
  return events.flatMap((event) => (event.type === EventType.TaskUpdated ? [event.task.activity] : []))
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

/** The session ends its turn as the SDK does when interrupted with a call running, once `before` has happened. */
function abortOnInterrupt(before: Promise<unknown> = Promise.resolve()): void {
  backend.session.onInterrupt = async () => {
    await before
    backend.session.emit(sdk.interruptMarker(true), sdk.abortedResult('aborted_tools'))
  }
}

/** A task as a Stop before #441 left it: waiting on you after a turn, with messages still queued. */
function stuck(bodies: readonly string[], createdAt = 5_000): Task {
  const other = sampleTask(database.db, workspace.id)
  updateTask(database.db, other.id, { activity: TaskActivity.Waiting, sessionId: `session-${other.id}` })
  for (const [index, body] of bodies.entries()) {
    appendQueuedMessage(database.db, { taskId: other.id, body }, createdAt + index)
  }
  return current(other.id)
}

describe('Stop with messages queued', () => {
  // The bug (#441): the queue stayed queued after Stop, and nothing ever sent it.
  it('stops the turn, then sends the queued message as the next turn, leaving the queue empty', async () => {
    await startCopy()
    await queue('Keep the original filenames.')
    abortOnInterrupt()
    events.splice(0)

    const stopped = await stop()

    expect(backend.session.interrupts).toBe(1)
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames.'])
    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Copy the existing uploads to S3.', turn: 1 },
      { role: MessageRole.User, body: 'Keep the original filenames.', turn: 2 },
    ])
    // The stopped turn ended as a stopped turn does; the next one is running, in the same session.
    expect(toolCall('toolu_01')).toMatchObject({ state: ToolCallState.Error, output: STOPPED_NOTE, turn: 1 })
    expect(turns()).toEqual([1, 2])
    expect(backend.sessions).toHaveLength(1)
    expect(stopped.activity).toBe(TaskActivity.Working)
    expect(current().activity).toBe(TaskActivity.Working)
    // The window is told the queue is empty, and never that the task waits on you in between.
    expect(events).toContainEqual({ type: EventType.QueueChanged, taskId: task.id, queuedMessages: [] })
    expect(activities()).not.toContain(TaskActivity.Waiting)

    // It's a turn like any other: it ends on its reply, with nothing left to send.
    backend.session.emit(sdk.result('The keys keep the original filenames.'))
    await settle()
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'The keys keep the original filenames.', turn: 2 })
    expect(sent()).toHaveLength(2)
  })

  it('sends several queued messages together, in the order they were queued, as one turn', async () => {
    await startCopy()
    await queue('Keep the original filenames.')
    const dropped = await queue('Use the Glacier storage class.')
    const edited = await queue('Then check a sample.')
    await queue('And tell me how many failed.')
    // What you changed in the queue before Stop is what's sent.
    await glade.invoke(CommandName.QueueRemove, { id: dropped })
    await glade.invoke(CommandName.QueueEdit, { id: edited, text: 'Then check a sample of fifty.' })
    abortOnInterrupt()

    await stop()

    const order = ['Keep the original filenames.', 'Then check a sample of fifty.', 'And tell me how many failed.']
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Copy the existing uploads to S3.', ...order])
    expect(chat().slice(1)).toEqual(order.map((body) => ({ role: MessageRole.User, body, turn: 2 })))
    expect(turns()).toEqual([1, 2])
  })

  it('sends a message queued while the stop was under way, too', async () => {
    await startCopy()
    let release = (): void => undefined
    abortOnInterrupt(new Promise<void>((resolve) => (release = resolve)))

    const stopping = stop()
    await settle()
    await queue('Keep the original filenames.')
    // The turn is stopping: the message isn't folded into it.
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])
    release()
    await stopping

    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames.'])
  })

  it('leaves a stop with nothing queued as it was: the task waits on you, and nothing is sent', async () => {
    await startCopy()
    abortOnInterrupt()
    events.splice(0)

    const stopped = await stop()

    expect(stopped.activity).toBe(TaskActivity.Waiting)
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])
    expect(turns()).toEqual([1])
    expect(events.some((event) => event.type === EventType.QueueChanged)).toBe(false)
    expect(activities().at(-1)).toBe(TaskActivity.Waiting)

    // And a second Stop, with no turn running and nothing queued, does nothing.
    expect((await stop()).activity).toBe(TaskActivity.Waiting)
    expect(backend.session.interrupts).toBe(1)
    expect(sent()).toHaveLength(1)
  })

  it('sends the queue when the SDK aborts the turn without Glade asking', async () => {
    await startCopy()
    await queue('Keep the original filenames.')

    backend.session.emit(sdk.interruptMarker(true), sdk.abortedResult('aborted_tools'))
    await settle()

    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames.'])
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('keeps the queue of a task marked done meanwhile, as a turn that ends on its own does', async () => {
    await startCopy()
    await queue('Keep the original filenames.')
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })
    abortOnInterrupt()

    await stop()

    expect(current()).toMatchObject({ state: TaskState.Done, activity: TaskActivity.Waiting })
    expect(queued()).toEqual(['Keep the original filenames.'])
    expect(sent()).toEqual(['Copy the existing uploads to S3.'])
  })

  it('sends the queue after a compaction you stopped', async () => {
    await send('Hi')
    backend.session.emit(sdk.init(), sdk.result('Hello.'))
    await settle()
    await glade.invoke(CommandName.TasksCompact, { id: task.id })
    await queue('Now copy the uploads.')
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.abortedResult())
      return Promise.resolve()
    }

    await stop()

    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Hi', COMPACT_COMMAND, 'Now copy the uploads.'])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Now copy the uploads.', turn: 2 })
    expect(current().activity).toBe(TaskActivity.Working)
  })
})

describe('Stop with messages queued, while the turn waits on you', () => {
  const QUESTIONS: Question[] = [
    { kind: QuestionKind.Pills, prompt: 'Which bucket?', options: ['acme-uploads', 'acme-archive'] },
  ]

  it('withdraws an open question, as Stop does, then sends the queue', async () => {
    await send('Copy the existing uploads to S3.')
    backend.session.emit(sdk.init(), sdk.text('One question first.'))
    const returned = backend.session
      .callTool('toolu_ask', 'mcp__glade__ask', { questions: QUESTIONS })
      .catch(() => undefined)
    await vi.waitFor(() => {
      if (getOpenQuestionSet(database.db, task.id) === undefined) throw new Error('No question is open yet')
    })
    await settle()
    // A message queued, not sent: sending would answer the question in your own words.
    await queue('Keep the original filenames.')
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, asking: true })
    abortOnInterrupt(returned)

    const stopped = await stop()

    expect(listQuestionSets(database.db, task.id).map(({ state }) => state)).toEqual([QuestionSetState.Withdrawn])
    expect(toolCall('toolu_ask')).toMatchObject({ state: ToolCallState.Error, output: STOPPED_NOTE })
    expect(stopped).toMatchObject({ activity: TaskActivity.Working, asking: false })
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames.'])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Keep the original filenames.', turn: 2 })
  })

  const BASH = { toolUseId: 'toolu_copy', toolName: 'Bash', input: { command: 'python scripts/copy.py' } } as const

  /** A turn in the ask mode whose `Bash` call waits on its permission card. */
  async function waitOnPermission(): Promise<AskedPermission> {
    updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
    await send('Copy the existing uploads to S3.')
    backend.session.emit(sdk.init(), sdk.toolUse(BASH.toolUseId, BASH.toolName, { ...BASH.input }))
    await settle()
    const asked = backend.session.requestPermission(BASH)
    await settle()
    return asked
  }

  function requestStates(): PermissionRequestState[] {
    return listPermissionRequests(database.db, task.id).map(({ state }) => state)
  }

  it('withdraws an open permission request, as Stop does, then sends the queue', async () => {
    const asked = await waitOnPermission()
    await queue('Keep the original filenames.')
    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    abortOnInterrupt(asked.answer)

    const stopped = await stop()

    expect(requestStates()).toEqual([PermissionRequestState.Withdrawn])
    expect(toolCall(BASH.toolUseId)).toMatchObject({ state: ToolCallState.Error, output: STOPPED_NOTE })
    expect(stopped).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Copy the existing uploads to S3.', 'Keep the original filenames.'])
    // The next turn's calls ask again: nothing was allowed.
    backend.session.emit(sdk.toolUse('toolu_again', BASH.toolName, { ...BASH.input }, null, 'msg_02'))
    await settle()
    backend.session.requestPermission({ ...BASH, toolUseId: 'toolu_again' })
    await settle()
    expect(requestStates()).toEqual([PermissionRequestState.Withdrawn, PermissionRequestState.Open])
  })

  it('withdraws a permission request the app quit on, then sends the queue it was holding', async () => {
    await waitOnPermission()
    relaunch()
    runner.resumeInterrupted()
    // Queued behind the request, to follow your decision on it.
    await queue('Keep the original filenames.')
    expect(backend.sessions).toHaveLength(0)

    const stopped = await stop()

    expect(requestStates()).toEqual([PermissionRequestState.Withdrawn])
    expect(stopped).toMatchObject({ activity: TaskActivity.Working, awaitingPermission: false })
    expect(queued()).toEqual([])
    // The decision never reaches the agent: only your message does, in a resumed session.
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(sent()).toEqual(['Keep the original filenames.'])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Keep the original filenames.', turn: 2 })
  })
})

describe('Stop with messages queued, while a background subagent runs', () => {
  it('stops only the turn: the subagent carries on, and the queue starts the next turn', async () => {
    await send('Find why checkout is slow.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.text('I started it in the background.', null, 'msg_02'),
      sdk.result('I started it in the background.'),
    )
    await settle()
    await send('Also check the logs.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_02', 'Bash', { command: 'tail -f app.log' }, null, 'msg_05'))
    await settle()
    await queue('Only the last hour of them.')
    abortOnInterrupt()

    await stop()

    expect(toolCall('toolu_02')).toMatchObject({ state: ToolCallState.Error, output: STOPPED_NOTE })
    expect(toolCall('toolu_q').state).toBe(ToolCallState.Running)
    expect(backend.session.stoppedTasks).toEqual([])
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Find why checkout is slow.', 'Also check the logs.', 'Only the last hour of them.'])
    expect(current().activity).toBe(TaskActivity.Working)

    // The subagent still ends as the SDK says, during the turn the queue started.
    backend.session.emit(...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'))
    await settle()
    expect(toolCall('toolu_q')).toMatchObject({ state: ToolCallState.Done, output: 'An N+1 in load_cart.' })
  })

  it('sends a queue left behind when Stop is pressed with only the subagent running', async () => {
    await send('Find why checkout is slow.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.result('I started it in the background.'),
    )
    await settle()
    // As a Stop before #441 left it: the turn over, the message still queued.
    appendQueuedMessage(database.db, { taskId: task.id, body: 'Only the last hour of logs.' })

    const stopped = await stop()

    expect(backend.session.interrupts).toBe(0)
    expect(toolCall('toolu_q').state).toBe(ToolCallState.Running)
    expect(stopped.activity).toBe(TaskActivity.Working)
    expect(queued()).toEqual([])
    expect(sent()).toEqual(['Find why checkout is slow.', 'Only the last hour of logs.'])
  })
})

describe('a task already stuck with its queue, on launch', () => {
  it('sends the queue as its next turn, in order, in its resumed session', () => {
    const other = stuck(['Keep the original filenames.', 'Then check a sample.'])
    relaunch()

    // It isn't a turn the app quit in, so it isn't one of the resumed tasks.
    expect(runner.resumeInterrupted()).toEqual([])

    expect(backend.sessions).toHaveLength(1)
    expect(backend.session.options.resumeSessionId).toBe(other.sessionId)
    expect(sent()).toEqual(['Keep the original filenames.', 'Then check a sample.'])
    expect(queued(other.id)).toEqual([])
    expect(chat(other.id)).toEqual([
      { role: MessageRole.User, body: 'Keep the original filenames.', turn: 1 },
      { role: MessageRole.User, body: 'Then check a sample.', turn: 1 },
    ])
    expect(current(other.id).activity).toBe(TaskActivity.Working)
    expect(events).toContainEqual({ type: EventType.QueueChanged, taskId: other.id, queuedMessages: [] })
    expect(log.withMessage('queue left by a stopped turn sent on launch')).toHaveLength(1)
  })

  it('sends the queue a Stop left in a turn stopped just before the app quit', async () => {
    await startCopy()
    abortOnInterrupt()
    await stop()
    appendQueuedMessage(database.db, { taskId: task.id, body: 'Keep the original filenames.' })
    relaunch()

    runner.resumeInterrupted()

    expect(queued()).toEqual([])
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    expect(sent()).toEqual(['Keep the original filenames.'])
    expect(chat().at(-1)).toEqual({ role: MessageRole.User, body: 'Keep the original filenames.', turn: 2 })
  })

  it('sends each stuck task its own queue, the longest-waiting first', () => {
    const later = stuck(['Second task.'], 9_000)
    const earlier = stuck(['First task.'], 7_000)
    relaunch()

    runner.resumeInterrupted()

    expect(backend.sessions.map(({ options }) => options.resumeSessionId)).toEqual([earlier.sessionId, later.sessionId])
    expect(backend.sessions.map((session) => sent(session))).toEqual([['First task.'], ['Second task.']])
  })

  it('leaves the queue of a task in error, paused or done where it is', () => {
    const errored = stuck(['After the error.'])
    updateTask(database.db, errored.id, {
      activity: TaskActivity.Error,
      error: {
        kind: AgentErrorKind.Permanent,
        source: TaskErrorSource.Turn,
        status: null,
        code: null,
        details: 'The turn failed.',
        retries: 0,
        retryingMs: 0,
      },
    })
    const paused = stuck(['After the pause.'])
    updateTask(database.db, paused.id, {
      activity: TaskActivity.Paused,
      pause: {
        reason: PauseReason.UsageLimit,
        since: 1_000,
        resumesAt: Date.now() + 3_600_000,
        checks: 0,
        details: 'Usage limit reached.',
      },
    })
    const done = stuck(['After it was done.'])
    updateTask(database.db, done.id, { state: TaskState.Done })
    relaunch()

    runner.resumeInterrupted()

    expect(backend.sessions).toHaveLength(0)
    for (const { id } of [errored, paused, done]) expect(queued(id)).toHaveLength(1)
  })

  it('leaves a queue that waits behind a question or a permission request the app quit on', async () => {
    updateTask(database.db, task.id, { permissionMode: PermissionMode.AskBeforeEdits })
    await send('Copy the existing uploads to S3.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_copy', 'Bash', { command: 'python scripts/copy.py' }))
    await settle()
    backend.session.requestPermission({
      toolUseId: 'toolu_copy',
      toolName: 'Bash',
      input: { command: 'python scripts/copy.py' },
    })
    await settle()
    await queue('Keep the original filenames.')
    relaunch()

    runner.resumeInterrupted()

    expect(current()).toMatchObject({ activity: TaskActivity.Waiting, awaitingPermission: true })
    expect(backend.sessions).toHaveLength(0)
    expect(queued()).toEqual(['Keep the original filenames.'])
    // And again on the launch after: still held by the request.
    relaunch()
    runner.resumeInterrupted()
    expect(backend.sessions).toHaveLength(0)
    expect(queued()).toEqual(['Keep the original filenames.'])
  })

  it('leaves the queue, and says so in the log, when the session cannot be started', () => {
    const other = stuck(['Keep the original filenames.'])
    relaunch()
    vi.spyOn(backend, 'start').mockImplementation(() => {
      throw new Error('spawn claude ENOENT')
    })

    expect(runner.resumeInterrupted()).toEqual([])

    expect(log.withMessage('failed to send the queue left by a stopped turn')).toEqual([
      expect.objectContaining({ level: LogLevel.Error }),
    ])
    expect(queued(other.id)).toEqual(['Keep the original filenames.'])
    expect(current(other.id).activity).toBe(TaskActivity.Waiting)
  })
})
