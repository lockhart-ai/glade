// A running subagent's progress summary (#278): the SDK's `task_progress.summary`, kept on its `Agent` call while it
// runs, for the Subagents tab. Several subagents, a summary after one finished, one between turns, calls that aren't
// subagents, and a relaunch: a scripted agent session behind the real bridge, saving to a database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { TaskActivity, ToolCallState, ToolEventKind, type Task, type ToolCallEvent } from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import { RESTARTED_TOOL_NOTE, type AgentRunner } from './runner'
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

/** Each call in the tool log as the renderer loads it: its id, state and summary. */
async function summaries(): Promise<(string | null)[][]> {
  const { toolEvents } = await glade.invoke(CommandName.TasksHistory, { id: task.id })
  return toolEvents.flatMap((event) =>
    event.kind === ToolEventKind.ToolCall ? [[event.toolUseId, event.state, event.progressSummary]] : [],
  )
}

/** The summaries main told the window about, in order, as `id: summary`. */
function updates(): string[] {
  return events.flatMap((event) =>
    event.type === EventType.ToolEventUpdated &&
    event.toolEvent.kind === ToolEventKind.ToolCall &&
    event.toolEvent.state === ToolCallState.Running
      ? [`${event.toolEvent.toolUseId}: ${event.toolEvent.progressSummary ?? ''}`]
      : [],
  )
}

function call(toolUseId: string): ToolCallEvent {
  const found = listToolEvents(database.db, task.id).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

/** A turn that starts two subagents side by side, and a Bash call of its own, all still running. */
async function twoSubagents(): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Draft the 2.4 release notes.' })
  backend.session.emit(
    sdk.init(),
    sdk.toolUse('toolu_api', 'Agent', { description: 'API changes', prompt: 'Sort the API PRs.' }),
    sdk.toolUse('toolu_web', 'Agent', { description: 'Dashboard changes', prompt: 'Sort the dashboard PRs.' }),
    sdk.toolUse('toolu_own', 'Bash', { command: 'git tag --list' }, null, 'msg_02'),
  )
  await settle()
}

describe("a running subagent's progress summary", () => {
  it('is kept on each subagent’s own call, the latest replacing the one before, and sent to the window', async () => {
    await twoSubagents()

    backend.session.emit(
      sdk.subagentProgress('toolu_api', 'a1', 'Reading the API PRs, newest first'),
      sdk.subagentProgress('toolu_web', 'a2', 'Listing the merged dashboard PRs'),
      // Most progress messages carry no summary: they leave the one it has alone.
      sdk.subagentProgress('toolu_api', 'a1'),
      sdk.subagentProgress('toolu_api', 'a1', 'Sorting 14 API PRs into features and fixes'),
    )
    await settle()

    expect(await summaries()).toEqual([
      ['toolu_api', ToolCallState.Running, 'Sorting 14 API PRs into features and fixes'],
      ['toolu_web', ToolCallState.Running, 'Listing the merged dashboard PRs'],
      ['toolu_own', ToolCallState.Running, null],
    ])
    expect(updates()).toEqual([
      'toolu_api: Reading the API PRs, newest first',
      'toolu_web: Listing the merged dashboard PRs',
      'toolu_api: Sorting 14 API PRs into features and fixes',
    ])
  })

  it('tells the window nothing when the summary is the one it already has', async () => {
    await twoSubagents()
    backend.session.emit(
      sdk.subagentProgress('toolu_api', 'a1', 'Reading the API PRs'),
      sdk.subagentProgress('toolu_api', 'a1', 'Reading the API PRs'),
    )
    await settle()

    expect(updates()).toEqual(['toolu_api: Reading the API PRs'])
  })

  it('goes once its subagent finishes, and one that arrives after that is ignored', async () => {
    await twoSubagents()
    backend.session.emit(sdk.subagentProgress('toolu_api', 'a1', 'Reading the API PRs'))
    await settle()

    backend.session.emit(
      sdk.toolResult('toolu_api', 'Sorted 14 API PRs.'),
      sdk.subagentProgress('toolu_api', 'a1', 'Wrapping up the API PRs'),
    )
    await settle()

    expect(call('toolu_api')).toMatchObject({
      state: ToolCallState.Done,
      output: 'Sorted 14 API PRs.',
      progressSummary: null,
    })
    expect(updates()).toEqual(['toolu_api: Reading the API PRs'])
  })

  it('is not kept for a call that starts no subagent, or for one Glade never logged', async () => {
    await twoSubagents()
    backend.session.emit(
      sdk.subagentProgress('toolu_own', 'b1', 'Listing the tags'),
      sdk.subagentProgress('toolu_missing', 'a9', 'Reading'),
    )
    await settle()

    expect(call('toolu_own').progressSummary).toBeNull()
    expect(updates()).toEqual([])
  })

  it('goes when the turn is stopped with its subagents still running', async () => {
    await twoSubagents()
    backend.session.emit(sdk.subagentProgress('toolu_api', 'a1', 'Reading the API PRs'))
    await settle()

    backend.session.onInterrupt = () => {
      setTimeout(() => {
        backend.session.emit(sdk.interruptMarker(true), sdk.abortedResult('aborted_tools'))
      }, 0)
      return Promise.resolve()
    }
    await glade.invoke(CommandName.TasksStop, { id: task.id })
    await settle()

    expect(call('toolu_api')).toMatchObject({ state: ToolCallState.Error, progressSummary: null })
  })

  it('of a background subagent arrives between turns, and is kept without opening a turn', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Find why checkout is slow.' })
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.text('Started it.', null, 'msg_02'),
      sdk.result('Started it.'),
    )
    await settle()

    backend.session.emit(sdk.subagentProgress('toolu_q', 'aq1', 'Timing the checkout queries'))
    await settle()

    expect(getTask(database.db, task.id)?.activity).toBe(TaskActivity.Waiting)
    expect(call('toolu_q')).toMatchObject({
      state: ToolCallState.Running,
      progressSummary: 'Timing the checkout queries',
    })

    backend.session.emit(...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'load_cart runs 38 queries.'))
    await settle()
    expect(call('toolu_q')).toMatchObject({ state: ToolCallState.Done, progressSummary: null })
  })

  it('survives the window loading the log again, and goes with the subagent when the app relaunches', async () => {
    await twoSubagents()
    backend.session.emit(sdk.subagentProgress('toolu_api', 'a1', 'Reading the API PRs'))
    await settle()

    runner.close()
    launch()
    // Before the relaunch finishes its checks, the log is as the app left it.
    expect(await summaries()).toContainEqual(['toolu_api', ToolCallState.Running, 'Reading the API PRs'])

    runner.resumeInterrupted()

    expect(call('toolu_api')).toMatchObject({
      state: ToolCallState.Interrupted,
      output: RESTARTED_TOOL_NOTE,
      progressSummary: null,
    })
  })
})
