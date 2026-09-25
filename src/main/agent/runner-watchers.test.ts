// The watchers through the runner and the bridge (#250): what the agent leaves running or scheduled with the SDK's own
// tools, streamed and hooked in the shapes the SDK was probed to send (`docs/sdk-notes.md` §13), saving to a database
// in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  TaskState,
  ToolEventKind,
  WatcherKind,
  WatcherState,
  type Task,
  type Watcher,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { listWatchers } from '../db/repositories/watchers'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { CANCELLED_BY_AGENT, FIRED, STOPPED_BY_RELAUNCH, STOPPED_BY_YOU } from '../watchers/watchers'
import { PromptVerdict } from './backend'
import { FakeAgentBackend, settle } from './fake-backend'
import { RESUME_PROMPT, type AgentRunner } from './runner'
import { BLOCKED_PROMPT_REASON } from './sdk-backend'
import { endNotice, eventNotice } from './scripted-session'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]

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
  events = []
  glade.subscribe((event) => events.push(event))
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  launch()
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
}

/** The task's watchers, briefly: kind, state, wakes. */
function watchers(): unknown[] {
  return listWatchers(database.db, task.id).map(({ kind, state, wakes }) => [kind, state, wakes])
}

function watcher(kind: WatcherKind): Watcher {
  const found = listWatchers(database.db, task.id).find((each) => each.kind === kind)
  if (found === undefined) throw new Error(`No ${kind} watcher`)
  return found
}

/** The watchers the window was last told of, for the task. */
function told(): readonly Watcher[] | undefined {
  return events
    .filter((event) => event.type === EventType.WatchersChanged && event.taskId === task.id)
    .map((event) => (event.type === EventType.WatchersChanged ? event.watchers : []))
    .at(-1)
}

const CI = ['toolu_ci', 'bci', 'CI checks on PR #42'] as const
const ROLLOUT = { delaySeconds: 300, reason: 'Check the rollout', prompt: 'Check the rollout.', noop: false }
const QUEUE = { cron: '*/10 * * * *', prompt: 'Check the staging queue.', recurring: true }

/** A first turn that leaves one of each watcher, as the probe saw each start, then ends. */
async function leaveOneOfEach(): Promise<void> {
  await send('Watch CI, run the tests, check the rollout later and keep an eye on the queue.')
  expect(backend.session.submitPrompt(backend.session.sent[0]?.text ?? '')).toBe(PromptVerdict.Allow)
  backend.session.emit(
    sdk.init(),
    ...sdk.monitorStarted(...CI),
    ...sdk.backgroundCommandStarted('toolu_tests', 'btests', 'Integration tests', 'npm run test:integration'),
    ...sdk.wakeupScheduled('toolu_wake', ROLLOUT, Date.now() + 300_000),
    ...sdk.cronCreated('toolu_cron', QUEUE, 'c7a1', 'Every 10 minutes'),
    sdk.text("I'm on it.", null, 'msg_02'),
  )
  await settle()
  backend.session.endTurn([
    { id: 'w1', schedule: '12 13 * * *', recurring: false, prompt: 'Check the rollout.' },
    { id: 'c7a1', schedule: '*/10 * * * *', recurring: true, prompt: 'Check the staging queue.' },
  ])
  backend.session.emit(sdk.result("I'm on it."))
  await settle()
}

/** A turn a wake started: straight into a reply. */
function wokenTurn(reply: string, messageId: string): unknown[] {
  return [sdk.init(), sdk.text(reply, null, messageId), sdk.selfStartedResult(reply)]
}

describe('following what the agent leaves running or scheduled', () => {
  it('lists one of each, live, and tells the window as each starts', async () => {
    await leaveOneOfEach()

    expect(watchers()).toEqual([
      [WatcherKind.Monitor, WatcherState.Running, 0],
      [WatcherKind.Command, WatcherState.Running, 0],
      [WatcherKind.Wakeup, WatcherState.Scheduled, 0],
      [WatcherKind.Cron, WatcherState.Scheduled, 0],
    ])
    expect(told()?.map(({ label }) => label)).toEqual([
      'CI checks on PR #42',
      'Integration tests',
      'Check the rollout',
      'Check the staging queue.',
    ])
    expect(watcher(WatcherKind.Wakeup)).toMatchObject({ sdkId: 'w1' })
    // The bridge answers with them: all of a task's with its history, every task's live ones on their own.
    const history = await glade.invoke(CommandName.TasksHistory, { id: task.id })
    expect(history.watchers).toEqual(told())
    const { watchers: live } = await glade.invoke(CommandName.WatchersListLive, {})
    expect(live).toHaveLength(4)
    expect(live[0]).not.toHaveProperty('sdkId')
  })

  it('counts each wake on its watcher, and never counts a message of yours', async () => {
    await leaveOneOfEach()

    expect(backend.session.submitPrompt(eventNotice('bci', 'CI checks on PR #42', 'unit-tests\tfail'))).toBe(
      PromptVerdict.Allow,
    )
    backend.session.emit(...wokenTurn('The unit tests failed.', 'msg_03'))
    await settle()
    backend.session.emit(...sdk.backgroundEnded('toolu_tests', 'btests', 'completed', 'Background command completed'))
    backend.session.submitPrompt(endNotice('btests', 'toolu_tests', 'completed', 'Background command completed'))
    backend.session.emit(...wokenTurn('The tests pass.', 'msg_04'))
    await settle()
    backend.session.emit(sdk.scheduledFire())
    backend.session.submitPrompt('Check the staging queue.')
    backend.session.emit(...wokenTurn('The queue is at 212.', 'msg_05'))
    await settle()

    // You send the same words as the job's prompt: it's your message, not a fire.
    await send('Check the staging queue.')
    expect(backend.session.submitPrompt('Check the staging queue.')).toBe(PromptVerdict.Allow)

    expect(watchers()).toEqual([
      [WatcherKind.Monitor, WatcherState.Running, 1],
      [WatcherKind.Command, WatcherState.Finished, 1],
      [WatcherKind.Wakeup, WatcherState.Scheduled, 0],
      [WatcherKind.Cron, WatcherState.Scheduled, 1],
    ])
    expect(watcher(WatcherKind.Monitor).lastOutput).toBe('unit-tests\tfail')
    expect(listMessages(database.db, task.id).map(({ role }) => role)).toEqual([
      MessageRole.User,
      MessageRole.Agent,
      MessageRole.Agent,
      MessageRole.Agent,
      MessageRole.Agent,
      MessageRole.User,
    ])
  })

  it('follows the agent deleting a job and cancelling its wakeups', async () => {
    await leaveOneOfEach()
    await send('Stop checking.')
    backend.session.emit(
      sdk.init(),
      ...sdk.cronDeleted('toolu_del', 'c7a1'),
      sdk.toolUse('toolu_stop', 'ScheduleWakeup', { stop: true }),
      {
        ...(sdk.toolResult('toolu_stop', 'Stopped.') as object),
        tool_use_result: { scheduledFor: 0, stopped: true, cancelledWakeups: 1 },
      },
      sdk.text('Stopped.', null, 'msg_03'),
      sdk.result('Stopped.'),
    )
    await settle()

    expect(watcher(WatcherKind.Cron)).toMatchObject({ state: WatcherState.Stopped, outcome: CANCELLED_BY_AGENT })
    expect(watcher(WatcherKind.Wakeup)).toMatchObject({ state: WatcherState.Stopped, outcome: CANCELLED_BY_AGENT })
  })

  it('finishes a wakeup when it fires', async () => {
    await leaveOneOfEach()
    backend.session.emit(sdk.scheduledFire())
    backend.session.submitPrompt('Check the rollout.')
    backend.session.emit(...wokenTurn('The rollout is done.', 'msg_03'))
    await settle()
    expect(watcher(WatcherKind.Wakeup)).toMatchObject({ state: WatcherState.Finished, wakes: 1, outcome: FIRED })
  })
})

describe('Stop', () => {
  it('stops a monitor and a command by their SDK tasks, and they end as the SDK says', async () => {
    await leaveOneOfEach()
    const monitor = watcher(WatcherKind.Monitor)
    const command = watcher(WatcherKind.Command)

    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: monitor.id })
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: command.id })
    expect(backend.session.stoppedTasks).toEqual(['bci', 'btests'])
    // Running until the SDK says they stopped, which doesn't wake the agent.
    expect(watcher(WatcherKind.Monitor).state).toBe(WatcherState.Running)
    backend.session.emit(
      ...sdk.backgroundEnded('toolu_ci', 'bci', 'stopped', 'CI checks on PR #42'),
      ...sdk.backgroundEnded('toolu_tests', 'btests', 'stopped', 'Integration tests'),
    )
    await settle()

    expect(watcher(WatcherKind.Monitor)).toMatchObject({ state: WatcherState.Stopped, outcome: STOPPED_BY_YOU })
    expect(watcher(WatcherKind.Command)).toMatchObject({ state: WatcherState.Stopped, outcome: STOPPED_BY_YOU })
    expect(listMessages(database.db, task.id)).toHaveLength(2)
  })

  it('stops a wakeup and a cron job at once, and turns their fires away before they start a turn', async () => {
    await leaveOneOfEach()
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcher(WatcherKind.Wakeup).id })
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcher(WatcherKind.Cron).id })
    expect(backend.session.stoppedTasks).toEqual([])
    expect(
      told()
        ?.slice(2)
        .map(({ state, outcome }) => [state, outcome]),
    ).toEqual([
      [WatcherState.Stopped, STOPPED_BY_YOU],
      [WatcherState.Stopped, STOPPED_BY_YOU],
    ])

    for (const prompt of ['Check the rollout.', 'Check the staging queue.', 'Check the staging queue.']) {
      backend.session.emit(sdk.scheduledFire())
      expect(backend.session.submitPrompt(prompt)).toBe(PromptVerdict.Block)
      // What the SDK streams for a prompt turned away: no turn, just a note and a bare result.
      backend.session.emit(
        sdk.init(),
        { type: 'system', subtype: 'informational', content: BLOCKED_PROMPT_REASON, level: 'warning' },
        sdk.result(`UserPromptSubmit operation blocked by hook:\n${BLOCKED_PROMPT_REASON}`, { num_turns: 0 }),
      )
      await settle()
    }

    expect(listMessages(database.db, task.id)).toHaveLength(2)
    expect(listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.Divider)).toHaveLength(1)
    expect(watchers().slice(2)).toEqual([
      [WatcherKind.Wakeup, WatcherState.Stopped, 0],
      [WatcherKind.Cron, WatcherState.Stopped, 0],
    ])
    // A message of yours with the same words still goes ahead.
    await send('Check the staging queue.')
    expect(backend.session.submitPrompt('Check the staging queue.')).toBe(PromptVerdict.Allow)
  })

  it('refuses a watcher that has ended, one that isn’t the task’s, and a task or watcher that doesn’t exist', async () => {
    await leaveOneOfEach()
    const { id } = watcher(WatcherKind.Wakeup)
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id })

    await expect(glade.invoke(CommandName.WatchersStop, { taskId: task.id, id })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
    })
    await expect(glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: 'nope' })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    const other = sampleTask(database.db, task.workspaceId)
    await expect(glade.invoke(CommandName.WatchersStop, { taskId: other.id, id })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    await expect(glade.invoke(CommandName.WatchersStop, { taskId: 'gone', id })).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })

  it('refuses a monitor or command whose session isn’t running, before anything is marked', async () => {
    await leaveOneOfEach()
    runner.close()
    launch()
    const { id } = watcher(WatcherKind.Monitor)
    await expect(glade.invoke(CommandName.WatchersStop, { taskId: task.id, id })).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
    })
    expect(listWatchers(database.db, task.id)[0]).toMatchObject({ stoppedByYou: false, state: WatcherState.Running })
    // A job needs no session: it's stopped where Glade keeps it.
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcher(WatcherKind.Cron).id })
    expect(watcher(WatcherKind.Cron).state).toBe(WatcherState.Stopped)
  })
})

describe('a relaunch', () => {
  it('ends what died with the session, suspends its cron job, and brings it back when the session resumes', async () => {
    await leaveOneOfEach()
    runner.close()
    launch()
    expect(runner.resumeInterrupted()).toEqual([])

    expect(listWatchers(database.db, task.id).map(({ state, outcome }) => [state, outcome])).toEqual([
      [WatcherState.Stopped, STOPPED_BY_RELAUNCH],
      [WatcherState.Stopped, STOPPED_BY_RELAUNCH],
      [WatcherState.Stopped, STOPPED_BY_RELAUNCH],
      [WatcherState.Suspended, null],
    ])
    expect(told()?.map(({ state }) => state)).toEqual([
      WatcherState.Stopped,
      WatcherState.Stopped,
      WatcherState.Stopped,
      WatcherState.Suspended,
    ])

    // Your next message resumes the session, and the SDK has the job back.
    await send('How is the queue?')
    expect(backend.session.options.resumeSessionId).toBe(sdk.SESSION_ID)
    backend.session.emit(sdk.init(), sdk.text('It is at 212.', null, 'msg_09'))
    await settle()
    backend.session.endTurn([
      { id: 'c7a1', schedule: '*/10 * * * *', recurring: true, prompt: 'Check the staging queue.' },
    ])
    backend.session.emit(sdk.result('It is at 212.'))
    await settle()
    expect(watcher(WatcherKind.Cron)).toMatchObject({ state: WatcherState.Scheduled })
  })

  it('carries a turn the app quit in on, and the resumed session’s jobs come back the same way', async () => {
    await leaveOneOfEach()
    await send('Keep going.')
    runner.close()
    launch()
    expect(runner.resumeInterrupted()).toEqual([task.id])
    expect(backend.session.sent.map(({ text }) => text)).toEqual([RESUME_PROMPT])
    // The resume prompt is Glade's own.
    expect(backend.session.submitPrompt(RESUME_PROMPT)).toBe(PromptVerdict.Allow)
    expect(watcher(WatcherKind.Cron).state).toBe(WatcherState.Suspended)
    backend.session.endTurn([
      { id: 'c7a1', schedule: '*/10 * * * *', recurring: true, prompt: 'Check the staging queue.' },
    ])
    expect(watcher(WatcherKind.Cron).state).toBe(WatcherState.Scheduled)
  })
})

describe('the session failing', () => {
  it('stops its running watchers and wakeups with it, and suspends its cron jobs', async () => {
    await leaveOneOfEach()
    backend.session.fail(new Error('exit 1'))
    await settle()
    expect(listWatchers(database.db, task.id).map(({ state, outcome }) => [state, outcome])).toEqual([
      [WatcherState.Stopped, 'The agent stopped: exit 1'],
      [WatcherState.Stopped, 'The agent stopped: exit 1'],
      [WatcherState.Stopped, 'The agent stopped: exit 1'],
      [WatcherState.Suspended, null],
    ])
  })
})

describe('a done task', () => {
  it('keeps its watchers, which still wake the agent, list as live and can be stopped', async () => {
    await leaveOneOfEach()
    await glade.invoke(CommandName.TasksMarkDone, { id: task.id })

    backend.session.submitPrompt(eventNotice('bci', 'CI checks on PR #42', 'lint\tpass'))
    backend.session.emit(...wokenTurn('Lint passed.', 'msg_03'))
    await settle()

    expect(watcher(WatcherKind.Monitor)).toMatchObject({ state: WatcherState.Running, wakes: 1 })
    const { watchers: live } = await glade.invoke(CommandName.WatchersListLive, {})
    expect(live.map(({ taskId }) => taskId)).toEqual([task.id, task.id, task.id, task.id])
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcher(WatcherKind.Monitor).id })
    expect(backend.session.stoppedTasks).toEqual(['bci'])
    const [done] = (await glade.invoke(CommandName.TasksGet, { ids: [task.id] })).tasks
    expect(done?.state).toBe(TaskState.Done)
  })
})

describe('a session Glade has let go of', () => {
  it('turns nothing away and counts nothing, once the task is deleted', async () => {
    await leaveOneOfEach()
    const session = backend.session
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcher(WatcherKind.Cron).id })
    await glade.invoke(CommandName.TasksDelete, { id: task.id })
    expect(session.submitPrompt('Check the staging queue.')).toBe(PromptVerdict.Allow)
    session.endTurn([])
    expect(listWatchers(database.db, task.id)).toEqual([])
  })

  it('remembers the last twenty prompts of its own the hook hasn’t seen, and each only once', async () => {
    await leaveOneOfEach()
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcher(WatcherKind.Cron).id })
    // 21 messages of yours with the job's words: one starts a turn, and the other 20 follow it together.
    for (let index = 0; index < 21; index += 1) {
      await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Check the staging queue.' })
    }
    backend.session.emit(sdk.result('Checked.'))
    await settle()
    expect(backend.session.sent.filter(({ text }) => text === 'Check the staging queue.')).toHaveLength(21)

    // Only the last 20 are remembered as Glade's: past them, the words are the stopped job's.
    for (let index = 0; index < 20; index += 1) {
      expect(backend.session.submitPrompt('Check the staging queue.')).toBe(PromptVerdict.Allow)
    }
    expect(backend.session.submitPrompt('Check the staging queue.')).toBe(PromptVerdict.Block)
    expect(
      listToolEvents(database.db, task.id).filter(
        (event) => event.kind === ToolEventKind.Divider && event.dividerKind === DividerKind.Turn,
      ),
    ).toHaveLength(3)
  })
})
