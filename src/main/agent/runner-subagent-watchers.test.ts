// What a task's subagents leave running (#291), through the runner and the bridge, streamed in the shapes the SDK was
// probed to send (`docs/sdk-notes.md`, "Background work inside a subagent"), saving to a database in a temporary folder:
// a subagent's background commands are its own, not the task's, a foreground command's task is never a watcher, and
// every watcher ends when its end arrives, or with its subagent when that's stopped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { ToolCallState, WatcherKind, WatcherState, type Task, type Watcher } from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { getToolCall } from '../db/repositories/tool-events'
import { listWatchers } from '../db/repositories/watchers'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { ENDED_WITH_SUBAGENT } from '../watchers/watchers'
import { FakeAgentBackend, settle } from './fake-backend'
import type { AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let task: Task
let backend: FakeAgentBackend
let glade: GladeBridge
let runner: AgentRunner
let events: GladeEvent[]

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
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
})

afterEach(() => {
  runner.close()
  database.close()
  vi.restoreAllMocks()
})

/** The task's watchers, briefly: whose (the subagent's `Agent` call, or null), label and state. */
function watchers(): unknown[] {
  return listWatchers(database.db, task.id).map(({ parentToolUseId, label, state }) => [parentToolUseId, label, state])
}

function watcher(label: string): Watcher {
  const found = listWatchers(database.db, task.id).find((each) => each.label === label)
  if (found === undefined) throw new Error(`No watcher ${label}`)
  return found
}

/** The watchers the window was last told of, for the task. */
function told(): readonly Watcher[] | undefined {
  return events
    .filter((event) => event.type === EventType.WatchersChanged && event.taskId === task.id)
    .map((event) => (event.type === EventType.WatchersChanged ? event.watchers : []))
    .at(-1)
}

const SUB = 'toolu_sub'
const SUB_TASK = 'a91c'

/** A first turn that starts a subagent in the background and ends, as the probe saw. */
async function launchSubagent(): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Get PR #42 green.' })
  backend.session.emit(
    sdk.init(),
    ...sdk.backgroundLaunch(SUB, SUB_TASK, 'Fix the flaky checkout test'),
    sdk.text('On it.', null, 'msg_02'),
    sdk.result('On it.'),
  )
  await settle()
}

describe("a subagent's background work", () => {
  it('is the subagent’s, not the task’s, and ends when its end arrives, after the subagent has finished', async () => {
    await launchSubagent()
    backend.session.emit(
      ...sdk.backgroundCommandStarted('toolu_e2e', 'be2e', 'Run the e2e suite', 'npm run test:e2e', SUB),
      sdk.text('Started the suite; done for now.', SUB, 'msg_s2'),
      ...sdk.subagentEnded(SUB, SUB_TASK, 'completed', 'Started the suite.'),
    )
    await settle()

    expect(watchers()).toEqual([[SUB, 'Run the e2e suite', WatcherState.Running]])
    expect(told()?.map(({ parentToolUseId }) => parentToolUseId)).toEqual([SUB])
    // The SDK keeps it running past its subagent, and reports its end to the task's session.
    expect(getToolCall(database.db, task.id, SUB)?.state).toBe(ToolCallState.Done)
    backend.session.emit(
      ...sdk.backgroundEnded('toolu_e2e', 'be2e', 'completed', 'Background command "Run the e2e suite" completed'),
    )
    await settle()
    expect(watcher('Run the e2e suite')).toMatchObject({
      state: WatcherState.Finished,
      outcome: 'Background command "Run the e2e suite" completed',
    })
  })

  it('belongs to the subagent whose call started it, however deep, and the task’s own stays the task’s', async () => {
    await launchSubagent()
    backend.session.emit(
      sdk.toolUse('toolu_nested', 'Agent', { description: 'Bisect the failure' }, SUB, 'msg_s1'),
      ...sdk.backgroundCommandStarted('toolu_bisect', 'bbis', 'Bisect', 'git bisect run npm test', 'toolu_nested'),
      ...sdk.backgroundCommandStarted('toolu_own', 'bown', 'Tail the deploy log', 'tail -F deploy.log'),
    )
    await settle()

    expect(watchers()).toEqual([
      ['toolu_nested', 'Bisect', WatcherState.Running],
      [null, 'Tail the deploy log', WatcherState.Running],
    ])
  })

  it('belongs to its subagent even when its call isn’t in the tool log', async () => {
    await launchSubagent()
    backend.session.emit(...sdk.subagentEnded(SUB, SUB_TASK, 'completed', 'Done.'))
    await settle()
    // A subagent Glade no longer follows carries on (it was sent a message): its call isn't logged between turns.
    backend.session.emit(
      ...sdk.backgroundCommandStarted('toolu_late', 'blate', 'Wait for CI', 'gh pr checks 42 --watch', SUB),
    )
    await settle()

    expect(getToolCall(database.db, task.id, 'toolu_late')).toBeUndefined()
    expect(watchers()).toEqual([[SUB, 'Wait for CI', WatcherState.Running]])
  })

  it('ends with its subagent when that’s stopped, and its task is stopped too', async () => {
    await launchSubagent()
    backend.session.emit(
      sdk.toolUse('toolu_nested', 'Agent', { description: 'Bisect the failure' }, SUB, 'msg_s1'),
      ...sdk.backgroundCommandStarted('toolu_e2e', 'be2e', 'Run the e2e suite', 'npm run test:e2e', SUB),
      ...sdk.backgroundCommandStarted('toolu_bisect', 'bbis', 'Bisect', 'git bisect run npm test', 'toolu_nested'),
      ...sdk.backgroundCommandStarted('toolu_own', 'bown', 'Tail the deploy log', 'tail -F deploy.log'),
      ...sdk.backgroundCommandStarted('toolu_done', 'bdone', 'Lint', 'npm run lint', SUB),
      ...sdk.backgroundEnded('toolu_done', 'bdone', 'completed', 'Background command "Lint" completed'),
    )
    await settle()

    await glade.invoke(CommandName.SubagentsStop, { taskId: task.id, toolUseId: SUB })
    expect(backend.session.stoppedTasks).toEqual([SUB_TASK])
    backend.session.emit(...sdk.subagentEnded(SUB, SUB_TASK, 'stopped', 'Fix the flaky checkout test'))
    await settle()

    expect(watchers()).toEqual([
      [SUB, 'Run the e2e suite', WatcherState.Stopped],
      ['toolu_nested', 'Bisect', WatcherState.Stopped],
      [null, 'Tail the deploy log', WatcherState.Running],
      [SUB, 'Lint', WatcherState.Finished],
    ])
    expect(watcher('Bisect').outcome).toBe(ENDED_WITH_SUBAGENT)
    expect(backend.session.stoppedTasks).toEqual([SUB_TASK, 'be2e', 'bbis'])
    // Their own stopped notifications, when the SDK sends them, change nothing.
    backend.session.emit(...sdk.backgroundEnded('toolu_e2e', 'be2e', 'stopped', 'Run the e2e suite'))
    await settle()
    expect(watcher('Run the e2e suite')).toMatchObject({ state: WatcherState.Stopped, outcome: ENDED_WITH_SUBAGENT })
  })

  it('lives on when its subagent fails or finishes, until its own end arrives', async () => {
    await launchSubagent()
    backend.session.emit(
      ...sdk.backgroundCommandStarted('toolu_e2e', 'be2e', 'Run the e2e suite', 'npm run test:e2e', SUB),
      ...sdk.subagentEnded(SUB, SUB_TASK, 'failed', 'API Error: 529'),
    )
    await settle()
    expect(watchers()).toEqual([[SUB, 'Run the e2e suite', WatcherState.Running]])
    expect(backend.session.stoppedTasks).toEqual([])
  })
})

describe('a foreground command', () => {
  it('is a tool call, not a watcher, though the SDK runs it as a task: the task’s own and a subagent’s', async () => {
    await launchSubagent()
    backend.session.emit(
      ...sdk.foregroundCommand('toolu_fg', 'bfg', 'Run the unit tests', '312 passed', SUB),
      sdk.init(),
      ...sdk.foregroundCommand('toolu_top', 'btop', 'Check the PR', 'open'),
      sdk.result('Checked.'),
    )
    await settle()

    expect(watchers()).toEqual([])
    expect(events.some((event) => event.type === EventType.WatchersChanged)).toBe(false)
    expect(getToolCall(database.db, task.id, 'toolu_fg')).toMatchObject({ state: ToolCallState.Done })
  })

  it('becomes a watcher when the SDK moves it to the background, and ends as a background command does', async () => {
    await launchSubagent()
    backend.session.emit(
      sdk.toolUse('toolu_ci', 'Bash', { command: 'gh pr checks 42 --watch', description: 'Wait for CI' }, SUB, 'm1'),
      sdk.foregroundCommandStarted('toolu_ci', 'bci', 'Wait for CI', SUB),
    )
    await settle()
    expect(watchers()).toEqual([])

    backend.session.emit(...sdk.movedToBackground('toolu_ci', 'bci', SUB))
    await settle()
    expect(watchers()).toEqual([[SUB, 'Wait for CI', WatcherState.Running]])
    expect(watcher('Wait for CI')).toMatchObject({ kind: WatcherKind.Command, detail: 'gh pr checks 42 --watch' })

    backend.session.emit(...sdk.backgroundEnded('toolu_ci', 'bci', 'failed', 'Background command "Wait for CI" failed'))
    await settle()
    expect(watcher('Wait for CI')).toMatchObject({ state: WatcherState.Failed })
  })

  it('becomes a watcher from its result alone, when that says it moved to the background', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Wait for CI.' })
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_ci', 'Bash', { command: 'gh pr checks 42 --watch', description: 'Wait for CI' }),
      sdk.foregroundCommandStarted('toolu_ci', 'bci', 'Wait for CI'),
      // The move's own update doesn't come: only the call's result says so.
      sdk.movedToBackground('toolu_ci', 'bci')[1],
    )
    await settle()
    expect(watchers()).toEqual([[null, 'Wait for CI', WatcherState.Running]])
  })
})
