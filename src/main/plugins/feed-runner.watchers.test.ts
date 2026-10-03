// How many watchers a task has running, as a plugin is told it (`PluginTask.watchers`, #490), end to end in main: a
// plugin shown and `ready`, fed what a scripted agent session leaves running behind the real bridge, runner and watcher
// tracker, saving to a database in a temporary folder. Covers the count as watchers start, finish, are stopped and die
// with their session or with Glade, and that nothing of a watcher but the count is sent.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import { TaskActivity, UiStateKey, WatcherKind, WatcherState, type Task, type Workspace } from '../../shared/domain'
import {
  PluginEventType,
  PluginSubagentState,
  type GladeMessage,
  type PluginEvent,
  type PluginTask,
} from '../../shared/plugin-api'
import { gladeMessageSchema } from '../../shared/plugin-api-schema'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { PromptVerdict } from '../agent/backend'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import type { AgentRunner } from '../agent/runner'
import { endNotice, eventNotice } from '../agent/scripted-session'
import * as sdk from '../agent/test-sdk-messages'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { listWatchers } from '../db/repositories/watchers'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { createFakePluginViews, type FakePluginView, type FakePluginViews } from './fake-view'
import { tempPluginsParent, writePlugin } from './test-plugins'

let database: TestDatabase
let workspace: Workspace
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let views: FakePluginViews
let pluginsParent: string

/** Starts Glade on the database, as a launch does, with the plugin placed beside the terminal (not yet `ready`). */
async function launch(): Promise<void> {
  backend = new FakeAgentBackend()
  views = createFakePluginViews()
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
    pluginsFolder: join(pluginsParent, 'plugins'),
    createPluginView: views.create,
    appVersion: '0.23.0',
    agentBackend: backend,
  }))
  glade = createBridge(ipc.renderer)
  await glade.invoke(CommandName.PluginsList, {})
  await glade.invoke(CommandName.PluginsPlaceView, {
    id: 'nekomata',
    bounds: { x: 0, y: 0, width: 600, height: 250 },
  })
}

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  // You're viewing the task: its replies are read as they come, so it needs you for nothing here.
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  pluginsParent = tempPluginsParent()
  writePlugin(join(pluginsParent, 'plugins'), 'nekomata')
  await launch()
})

afterEach(() => {
  runner.close()
  database.close()
  rmSync(pluginsParent, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function view(): FakePluginView {
  return views.last()
}

/** What the plugin was sent since its last hello, checked against the schema, with seq counting up with no gaps. */
function received(): PluginEvent[] {
  const run: GladeMessage[] = []
  for (const message of view().sent) {
    expect(gladeMessageSchema.parse(message)).toEqual(message)
    if (message.event.type === PluginEventType.Hello) run.length = 0
    run.push(message)
  }
  expect(run.map(({ seq }) => seq)).toEqual(run.map((_, index) => index + 1))
  return run.map(({ event }) => event)
}

/** The task as the last snapshot had it. */
function inSnapshot(): PluginTask | undefined {
  const snapshot = received()[1]
  if (snapshot?.type !== PluginEventType.Snapshot) throw new Error('No snapshot')
  return snapshot.tasks.find(({ id }) => id === task.id)
}

/** Each event after the snapshot as a line; a task's with its activity and its count of watchers. */
function lines(): string[] {
  return received()
    .slice(2)
    .map((event) => {
      if (event.type === PluginEventType.TaskUpdated) {
        return `task.updated ${event.task.activity} watchers ${String(event.task.watchers)}`
      }
      if (event.type === PluginEventType.AgentToolCall) return `call ${event.call.tool} ${event.call.state}`
      if (event.type === PluginEventType.SubagentStarted || event.type === PluginEventType.SubagentUpdated) {
        return `${event.type} ${event.subagent.state}`
      }
      return event.type
    })
}

/** The `watchers` of each `task.updated` since the snapshot, in order. */
function counts(): number[] {
  return received()
    .slice(2)
    .flatMap((event) => (event.type === PluginEventType.TaskUpdated ? [event.task.watchers] : []))
}

/** What a plugin that follows its snapshot and the events since knows is alive under the task. */
interface Alive {
  readonly watchers: number
  /** The ids of its subagents that are running. */
  readonly subagents: readonly string[]
}

function alive(): Alive {
  let watchers = 0
  const subagents = new Set<string>()
  for (const event of received()) {
    if (event.type === PluginEventType.Snapshot) {
      watchers = event.tasks.find(({ id }) => id === task.id)?.watchers ?? 0
      for (const subagent of event.subagents) if (subagent.taskId === task.id) subagents.add(subagent.id)
    } else if (event.type === PluginEventType.TaskUpdated) {
      watchers = event.task.watchers
    } else if (event.type === PluginEventType.SubagentStarted) {
      subagents.add(event.subagent.id)
    } else if (event.type === PluginEventType.SubagentUpdated) {
      if (event.subagent.state === PluginSubagentState.Running) subagents.add(event.subagent.id)
      else subagents.delete(event.subagent.id)
    }
  }
  return { watchers, subagents: [...subagents] }
}

/**
 * Checks what a plugin knows against what Glade itself counts: with the task's turn over, it has background work
 * (`Task.backgroundWork`) exactly when the plugin has a running subagent of its or a count of watchers over 0. Both
 * from the events it has been sent, and from a snapshot taken now.
 */
async function expectAlive(expected: Alive): Promise<void> {
  const read = getTask(database.db, task.id)
  expect(read?.activity).toBe(TaskActivity.Waiting)
  const background = expected.watchers > 0 || expected.subagents.length > 0
  expect(alive()).toEqual(expected)
  expect(read?.backgroundWork).toBe(background)
  await ready()
  expect(alive()).toEqual(expected)
}

async function ready(): Promise<void> {
  view().post({ type: 'ready' })
  await settle()
}

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  await settle()
}

const CI = ['toolu_ci', 'bci', 'CI checks on PR #42'] as const
const TESTS = ['toolu_tests', 'btests', 'Integration tests', 'npm run test:integration'] as const

/** A turn that leaves a monitor running, then ends. */
async function leaveMonitor(): Promise<void> {
  await send('Watch the CI on PR #42.')
  backend.session.emit(
    sdk.init(),
    ...sdk.monitorStarted(...CI),
    sdk.text("I'm watching it.", null, 'msg_02'),
    sdk.result("I'm watching it."),
  )
  await settle()
}

/** A turn that leaves a monitor and a command running, then ends. */
async function leaveTwo(): Promise<void> {
  await send('Watch the CI on PR #42 and run the integration tests.')
  backend.session.emit(
    sdk.init(),
    ...sdk.monitorStarted(...CI),
    ...sdk.backgroundCommandStarted(...TESTS),
    sdk.text("I'm on it.", null, 'msg_02'),
    sdk.result("I'm on it."),
  )
  await settle()
}

/** A turn a wake started: straight into a reply. */
function wokenTurn(reply: string, messageId: string): unknown[] {
  return [sdk.init(), sdk.text(reply, null, messageId), sdk.selfStartedResult(reply)]
}

function watcherId(kind: WatcherKind): string {
  const found = listWatchers(database.db, task.id).find((each) => each.kind === kind)
  if (found === undefined) throw new Error(`No ${kind} watcher`)
  return found.id
}

describe('a watcher starting and finishing', () => {
  beforeEach(ready)

  it('sends the task with watchers: 1 as it starts, has it in a snapshot once the turn is over, and 0 when it ends', async () => {
    expect(inSnapshot()).toMatchObject({ watchers: 0, activity: 'waiting' })

    await leaveMonitor()

    expect(lines()).toEqual([
      'task.updated working watchers 0',
      'call Monitor running',
      // The watch starts: one event, for the one task.
      'task.updated working watchers 1',
      'call Monitor done',
      // The turn is over with it still running.
      'task.updated waiting watchers 1',
    ])
    await expectAlive({ watchers: 1, subagents: [] })
    expect(inSnapshot()).toMatchObject({ watchers: 1, activity: 'waiting', needsYou: false })

    // Its command exits: the watch ends.
    backend.session.emit(...sdk.monitorEnded(...CI))
    await settle()

    expect(lines()).toEqual(['task.updated waiting watchers 0'])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('counts two in one task, and each as it finishes or fails', async () => {
    await leaveTwo()
    expect(counts()).toEqual([0, 1, 2, 2])
    await expectAlive({ watchers: 2, subagents: [] })

    backend.session.emit(...sdk.backgroundEnded('toolu_tests', 'btests', 'failed', 'Background command failed'))
    await settle()
    expect(lines()).toEqual(['task.updated waiting watchers 1'])
    await expectAlive({ watchers: 1, subagents: [] })

    backend.session.emit(...sdk.backgroundEnded('toolu_ci', 'bci', 'completed', 'Monitor stream ended'))
    await settle()
    expect(lines()).toEqual(['task.updated waiting watchers 0'])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('counts a command the SDK moves to the background when it runs past its timeout, from then', async () => {
    await send('Run the e2e suite.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_e2e', 'Bash', { command: 'npm run test:e2e', description: 'Run the e2e suite' }),
      sdk.foregroundCommandStarted('toolu_e2e', 'be2e', 'Run the e2e suite'),
    )
    await settle()
    // In the foreground it's a tool call, not a watcher.
    expect(counts()).toEqual([0])

    backend.session.emit(...sdk.movedToBackground('toolu_e2e', 'be2e'), sdk.result('It is running on.'))
    await settle()

    expect(counts()).toEqual([0, 1, 1])
    await expectAlive({ watchers: 1, subagents: [] })
  })

  it('sends nothing for a watcher when the count is as it was: one waking the agent, and jobs being scheduled', async () => {
    await leaveMonitor()
    const before = lines()

    // The monitor reports a line, which wakes the agent: its turn, and no more.
    expect(backend.session.submitPrompt(eventNotice('bci', 'CI checks on PR #42', 'unit-tests\tfail'))).toBe(
      PromptVerdict.Allow,
    )
    backend.session.emit(...wokenTurn('The unit tests failed.', 'msg_03'))
    await settle()
    expect(listWatchers(database.db, task.id)[0]).toMatchObject({ wakes: 1, lastOutput: 'unit-tests\tfail' })
    expect(lines().slice(before.length)).toEqual(['task.updated working watchers 1', 'task.updated waiting watchers 1'])

    // A wakeup and a cron job are scheduled: the Watchers tab lists them, and nothing runs.
    const woken = lines()
    await send('Check the rollout later, and the queue every ten minutes.')
    backend.session.emit(
      sdk.init(),
      ...sdk.wakeupScheduled(
        'toolu_wake',
        { delaySeconds: 300, reason: 'Check the rollout', prompt: 'Check the rollout.', noop: false },
        Date.now() + 300_000,
      ),
      ...sdk.cronCreated(
        'toolu_cron',
        { cron: '*/10 * * * *', prompt: 'Check the staging queue.', recurring: true },
        'c7a1',
        'Every 10 minutes',
      ),
      sdk.text('Scheduled.', null, 'msg_04'),
      sdk.result('Scheduled.'),
    )
    await settle()

    expect(listWatchers(database.db, task.id).map(({ state }) => state)).toEqual([
      WatcherState.Running,
      WatcherState.Scheduled,
      WatcherState.Scheduled,
    ])
    expect(lines().slice(woken.length)).toEqual([
      'task.updated working watchers 1',
      'call ScheduleWakeup running',
      'call ScheduleWakeup done',
      'call CronCreate running',
      'call CronCreate done',
      'task.updated waiting watchers 1',
    ])
    await expectAlive({ watchers: 1, subagents: [] })
  })

  it('counts nothing for a task that only has jobs scheduled: it waits on nothing that runs', async () => {
    await send('Check the rollout later.')
    backend.session.emit(
      sdk.init(),
      ...sdk.wakeupScheduled(
        'toolu_wake',
        { delaySeconds: 300, reason: 'Check the rollout', prompt: 'Check the rollout.', noop: false },
        Date.now() + 300_000,
      ),
      sdk.result('Scheduled.'),
    )
    await settle()

    expect(listWatchers(database.db, task.id).map(({ state }) => state)).toEqual([WatcherState.Scheduled])
    expect(counts()).toEqual([0, 0])
    await expectAlive({ watchers: 0, subagents: [] })
  })
})

describe('Stop', () => {
  beforeEach(ready)

  it('sends 0 when the SDK says the watcher stopped, not when you press Stop', async () => {
    await leaveTwo()
    const before = lines()

    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcherId(WatcherKind.Monitor) })
    await settle()
    // Asked to stop, and still running until the SDK says otherwise.
    expect(backend.session.stoppedTasks).toEqual(['bci'])
    expect(lines().slice(before.length)).toEqual([])

    backend.session.emit(...sdk.backgroundEnded('toolu_ci', 'bci', 'stopped', 'CI checks on PR #42'))
    await settle()
    expect(lines().slice(before.length)).toEqual(['task.updated waiting watchers 1'])

    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcherId(WatcherKind.Command) })
    backend.session.emit(...sdk.backgroundEnded('toolu_tests', 'btests', 'stopped', 'Integration tests'))
    await settle()
    expect(lines().slice(before.length)).toEqual(['task.updated waiting watchers 1', 'task.updated waiting watchers 0'])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('sends 0 when the agent’s session fails, which takes its watchers with it', async () => {
    await leaveTwo()

    backend.session.fail(new Error('exit 1'))
    await settle()

    expect(listWatchers(database.db, task.id).map(({ state }) => state)).toEqual([
      WatcherState.Stopped,
      WatcherState.Stopped,
    ])
    expect(counts().at(-1)).toBe(0)
    await ready()
    expect(inSnapshot()).toMatchObject({ watchers: 0 })
  })
})

describe('subagents', () => {
  beforeEach(ready)

  it('aren’t counted: a task with only a running subagent has watchers: 0', async () => {
    await send('Find why checkout is slow.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.text('I started it in the background.', null, 'msg_02'),
      sdk.result('I started it in the background.'),
    )
    await settle()

    expect(lines()).toEqual([
      'task.updated working watchers 0',
      'call Agent running',
      'subagent.started running',
      'task.updated waiting watchers 0',
    ])
    // Glade counts the task as working: the subagent's own events are how a plugin knows.
    await expectAlive({ watchers: 0, subagents: ['toolu_q'] })
    expect(inSnapshot()).toMatchObject({ watchers: 0 })

    backend.session.emit(...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'))
    await settle()
    expect(lines()).toEqual(['call Agent done', 'subagent.updated done'])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('leave their watchers to the task’s count: a command a subagent started runs on after it has finished', async () => {
    await send('Get PR #42 green.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_sub', 'a91c', 'Fix the flaky checkout test'),
      sdk.result('On it.'),
    )
    await settle()
    backend.session.emit(
      ...sdk.backgroundCommandStarted('toolu_e2e', 'be2e', 'Run the e2e suite', 'npm run test:e2e', 'toolu_sub'),
    )
    await settle()
    await expectAlive({ watchers: 1, subagents: ['toolu_sub'] })

    // The subagent finishes; the SDK keeps its command running. Only the count says the task still waits on something.
    backend.session.emit(...sdk.subagentEnded('toolu_sub', 'a91c', 'completed', 'Started the suite.'))
    await settle()
    await expectAlive({ watchers: 1, subagents: [] })

    backend.session.emit(...sdk.backgroundEnded('toolu_e2e', 'be2e', 'completed', 'Background command completed'))
    await settle()
    expect(lines()).toEqual(['task.updated waiting watchers 0'])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('take their watchers with them when they’re stopped', async () => {
    await send('Get PR #42 green.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_sub', 'a91c', 'Fix the flaky checkout test'),
      ...sdk.backgroundCommandStarted(...TESTS),
      sdk.result('On it.'),
    )
    await settle()
    backend.session.emit(
      ...sdk.backgroundCommandStarted('toolu_e2e', 'be2e', 'Run the e2e suite', 'npm run test:e2e', 'toolu_sub'),
    )
    await settle()
    await expectAlive({ watchers: 2, subagents: ['toolu_sub'] })

    await glade.invoke(CommandName.SubagentsStop, { taskId: task.id, toolUseId: 'toolu_sub' })
    backend.session.emit(...sdk.subagentEnded('toolu_sub', 'a91c', 'stopped', 'Fix the flaky checkout test'))
    await settle()

    // The task's own command runs on.
    expect(counts()).toEqual([1])
    await expectAlive({ watchers: 1, subagents: [] })
  })
})

describe('a restart of Glade with a watcher still running', () => {
  it('has none in the snapshot: its process died with the session', async () => {
    await ready()
    await leaveTwo()
    expect(inSnapshot()).toMatchObject({ watchers: 0 })
    expect(counts().at(-1)).toBe(2)
    runner.close()

    await launch()
    expect(runner.resumeInterrupted()).toEqual([])
    await ready()

    expect(listWatchers(database.db, task.id).map(({ state }) => state)).toEqual([
      WatcherState.Stopped,
      WatcherState.Stopped,
    ])
    expect(inSnapshot()).toMatchObject({ watchers: 0, activity: 'waiting' })
    expect(lines()).toEqual([])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('sends 0 to a plugin that was ready before Glade cleaned up, in one task.updated', async () => {
    await leaveTwo()
    runner.close()

    await launch()
    await ready()
    // Nothing has cleaned up yet: the snapshot says what Glade's own task list would, from the same watchers.
    expect(inSnapshot()).toMatchObject({ watchers: 2 })
    expect(getTask(database.db, task.id)?.backgroundWork).toBe(true)

    expect(runner.resumeInterrupted()).toEqual([])
    await settle()

    expect(lines()).toEqual(['task.updated waiting watchers 0'])
    await expectAlive({ watchers: 0, subagents: [] })
  })

  it('counts the watchers the resumed session starts, from 0', async () => {
    await leaveMonitor()
    runner.close()
    await launch()
    runner.resumeInterrupted()
    await ready()

    await send('Watch it again.')
    backend.session.emit(
      sdk.init(),
      ...sdk.monitorStarted('toolu_ci_2', 'bci2', 'CI checks on PR #42'),
      sdk.result('Watching again.'),
    )
    await settle()

    expect(counts()).toEqual([0, 1, 1])
    await expectAlive({ watchers: 1, subagents: [] })
  })
})

describe('what reaches the plugin of a watcher', () => {
  beforeEach(ready)

  it('is the count alone: nothing of its name, command, output or how it ended, in anything sent', async () => {
    await leaveTwo()
    expect(backend.session.submitPrompt(eventNotice('bci', 'CI checks on PR #42', 'unit-tests\tfail\t2m13s'))).toBe(
      PromptVerdict.Allow,
    )
    backend.session.emit(...wokenTurn('The unit tests failed.', 'msg_03'))
    await settle()
    backend.session.emit(...sdk.backgroundEnded('toolu_tests', 'btests', 'failed', 'Exited with code 1'))
    backend.session.submitPrompt(endNotice('btests', 'toolu_tests', 'failed', 'Exited with code 1'))
    backend.session.emit(...wokenTurn('The integration tests failed.', 'msg_04'))
    await settle()
    await glade.invoke(CommandName.WatchersStop, { taskId: task.id, id: watcherId(WatcherKind.Monitor) })
    backend.session.emit(...sdk.backgroundEnded('toolu_ci', 'bci', 'stopped', 'CI checks on PR #42'))
    await settle()
    await ready()

    // What the Watchers tab shows of them, which Glade has.
    const kept = JSON.stringify(listWatchers(database.db, task.id))
    const secrets = [
      'CI checks on PR #42',
      'npm run ci:status',
      'unit-tests',
      'Integration tests',
      'Exited with code 1',
      'You stopped it.',
      'bci',
      'btests',
    ]
    for (const text of secrets) expect(kept).toContain(text)

    const everything = JSON.stringify(view().sent)
    for (const text of secrets) expect(everything).not.toContain(text)
    for (const id of listWatchers(database.db, task.id).map(({ id }) => id)) expect(everything).not.toContain(id)
    // A background command is a `Bash` call too: its command is that call's summary, as for any `Bash` call, and
    // reaches a plugin there and nowhere else.
    const events = view().sent.map(({ event }) => event)
    const calls = events.filter((event) => event.type === PluginEventType.AgentToolCall)
    const others = events.filter((event) => event.type !== PluginEventType.AgentToolCall)
    expect(JSON.stringify(calls)).toContain('npm run test:integration')
    expect(JSON.stringify(others)).not.toContain('npm run test:integration')
    // Every task sent, in a snapshot or an event, has the count as a number and no field the schema hasn't.
    const tasks = events.flatMap((event) => {
      if (event.type === PluginEventType.Snapshot) return [...event.tasks]
      return event.type === PluginEventType.TaskUpdated || event.type === PluginEventType.TaskCreated
        ? [event.task]
        : []
    })
    expect(tasks.length).toBeGreaterThan(8)
    expect(new Set(tasks.map(({ watchers }) => watchers))).toEqual(new Set([0, 1, 2]))
    expect(new Set(tasks.map((sent) => Object.keys(sent).sort().join(' ')))).toEqual(
      new Set([
        'activity createdAt doneAt id needsYou state status title updatedAt waitingOn watchers workspaceId workspaceName',
      ]),
    )
  })
})
