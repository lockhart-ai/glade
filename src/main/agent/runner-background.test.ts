// Background subagents end to end (`docs/sdk-notes.md`, "Background subagents"): an `Agent` call that returns as soon
// as its subagent is launched. A scripted agent session behind the real bridge, saving to a database in a temporary
// folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import {
  DividerKind,
  MessageRole,
  TaskActivity,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Task,
  type ToolCallEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { listMessages } from '../db/repositories/messages'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import {
  RESTARTED_TOOL_NOTE,
  STOPPED_NOTE,
  STOPPED_SUBAGENT_NOTE,
  SUBAGENT_ENDED_NOTE,
  type AgentRunner,
} from './runner'
import * as sdk from './test-sdk-messages'

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
    agentBackend: backend,
  }))
  glade = createBridge(ipc.renderer)
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

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
}

async function stopSubagent(toolUseId: string): Promise<null> {
  return glade.invoke(CommandName.SubagentsStop, { taskId: task.id, toolUseId })
}

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}

/** The task's tool calls, by their id. */
function calls(): Map<string, ToolCallEvent> {
  const found = listToolEvents(database.db, task.id).filter(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall,
  )
  return new Map(found.map((call) => [call.toolUseId, call]))
}

function call(toolUseId: string): ToolCallEvent {
  const found = calls().get(toolUseId)
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

/** A call's state and output. */
function outcome(toolUseId: string): [ToolCallState, string | null] {
  const { state, output } = call(toolUseId)
  return [state, output]
}

function chat(): unknown[] {
  return listMessages(database.db, task.id).map(({ role, body, turn }) => ({ role, body, turn }))
}

/**
 * A first turn that starts the given subagents in the background (each `[Agent call id, SDK task id, description]`)
 * and replies at once, as the probe saw it do.
 */
async function launchInBackground(...subagents: readonly (readonly [string, string, string])[]): Promise<void> {
  await send('Find why checkout is slow.')
  backend.session.emit(
    sdk.init(),
    ...subagents.flatMap(([toolUseId, sdkTaskId, description]) =>
      sdk.backgroundLaunch(toolUseId, sdkTaskId, description),
    ),
    sdk.text('I started them in the background.', null, 'msg_02'),
    sdk.result('I started them in the background.'),
  )
  await settle()
}

const QUERIES = ['toolu_q', 'aq1', 'Profile the checkout queries'] as const
const CACHE = ['toolu_c', 'ac2', 'Check the cart cache'] as const
const BISECT = ['toolu_b', 'ab3', 'Bisect the slowdown'] as const

describe('a background subagent', () => {
  it("isn't done when its launching call returns: it runs until the SDK says it ended", async () => {
    await launchInBackground(QUERIES)

    expect(call('toolu_q')).toMatchObject({ state: ToolCallState.Running, output: null, finishedAt: null })

    backend.session.emit(...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'))
    await settle()

    expect(call('toolu_q')).toMatchObject({ state: ToolCallState.Done, output: 'An N+1 in load_cart.' })
    expect(call('toolu_q').finishedAt).not.toBeNull()
  })

  it("doesn't leave the parent working: its turn ends on its result, and it takes messages while the subagent runs", async () => {
    await launchInBackground(QUERIES)

    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(chat()).toEqual([
      { role: MessageRole.User, body: 'Find why checkout is slow.', turn: 1 },
      { role: MessageRole.Agent, body: 'I started them in the background.', turn: 1 },
    ])

    // A message goes straight to the agent, as the next turn, not into the queue.
    await send('Anything yet?')
    expect(backend.session.sent.map(({ text }) => text)).toEqual(['Find why checkout is slow.', 'Anything yet?'])
    backend.session.emit(sdk.init(), sdk.text('Still profiling.', null, 'msg_03'), sdk.result('Still profiling.'))
    await settle()

    expect(chat().at(-1)).toEqual({ role: MessageRole.Agent, body: 'Still profiling.', turn: 2 })
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(call('toolu_q').state).toBe(ToolCallState.Running)
  })

  it('logs what it does between turns under its call, in the turn that started it, without opening a turn', async () => {
    await launchInBackground(QUERIES)

    backend.session.emit(
      sdk.text('Timing the checkout queries.', 'toolu_q', 'msg_s1'),
      sdk.text('  ', 'toolu_q', 'msg_s1'),
      sdk.toolUse('toolu_q1', 'Bash', { command: 'python time_queries.py' }, 'toolu_q', 'msg_s1'),
      { type: 'system', subtype: 'task_progress', task_id: 'aq1', tool_use_id: 'toolu_q', session_id: sdk.SESSION_ID },
    )
    await settle()

    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(call('toolu_q1')).toMatchObject({ state: ToolCallState.Running, parentToolUseId: 'toolu_q', turn: 1 })
    const note = listToolEvents(database.db, task.id).at(-2)
    expect(note).toMatchObject({ kind: ToolEventKind.Narration, text: 'Timing the checkout queries.', turn: 1 })
    expect(note).toMatchObject({ parentToolUseId: 'toolu_q' })

    backend.session.emit(sdk.toolResult('toolu_q1', 'load_cart  38 queries', false, 'toolu_q'))
    await settle()
    expect(outcome('toolu_q1')).toEqual([ToolCallState.Done, 'load_cart  38 queries'])
    expect(listToolEvents(database.db, task.id).filter((event) => event.kind === ToolEventKind.Divider)).toHaveLength(1)
  })

  it("isn't cut off when a turn it runs through ends: its calls keep running", async () => {
    await launchInBackground(QUERIES)
    await send('Anything yet?')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_q1', 'Bash', { command: 'python time_queries.py' }, 'toolu_q', 'msg_s1'),
      sdk.text('Still profiling.', null, 'msg_03'),
      sdk.result('Still profiling.'),
    )
    await settle()

    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(call('toolu_q1')).toMatchObject({ state: ToolCallState.Running, turn: 1 })

    backend.session.emit(sdk.toolResult('toolu_q1', 'load_cart  38 queries', false, 'toolu_q'))
    await settle()
    expect(outcome('toolu_q1')).toEqual([ToolCallState.Done, 'load_cart  38 queries'])
  })

  it("ends in the turn the agent starts to report it, which opens on the agent's own words", async () => {
    await launchInBackground(QUERIES)

    backend.session.emit(
      ...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'),
      sdk.init(),
      sdk.text('The profile is back: an N+1 in load_cart.', null, 'msg_04'),
      sdk.selfStartedResult('The profile is back: an N+1 in load_cart.'),
    )
    await settle()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Done, 'An N+1 in load_cart.'])
    expect(chat().at(-1)).toEqual({
      role: MessageRole.Agent,
      body: 'The profile is back: an N+1 in load_cart.',
      turn: 2,
    })
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('runs side by side with others: one failing, with a call still running, leaves the others running', async () => {
    await launchInBackground(QUERIES, CACHE, BISECT)
    backend.session.emit(
      sdk.toolUse('toolu_c1', 'Grep', { pattern: 'cart_cache' }, 'toolu_c', 'msg_s2'),
      sdk.toolUse('toolu_b1', 'Bash', { command: 'git bisect run ./bench.sh' }, 'toolu_b', 'msg_s3'),
    )
    await settle()

    backend.session.emit(...sdk.subagentEnded('toolu_c', 'ac2', 'failed', 'Connection refused.'))
    await settle()

    expect(outcome('toolu_c')).toEqual([ToolCallState.Error, 'Connection refused.'])
    expect(outcome('toolu_c1')).toEqual([ToolCallState.Error, SUBAGENT_ENDED_NOTE])
    expect(call('toolu_q').state).toBe(ToolCallState.Running)
    expect(outcome('toolu_b1')).toEqual([ToolCallState.Running, null])
    expect(current().activity).toBe(TaskActivity.Waiting)

    // A late result for the failed subagent's call changes nothing.
    backend.session.emit(sdk.toolResult('toolu_c1', 'api/checkout/cart.py:14', false, 'toolu_c'))
    await settle()
    expect(outcome('toolu_c1')).toEqual([ToolCallState.Error, SUBAGENT_ENDED_NOTE])

    backend.session.emit(
      ...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'),
      ...sdk.subagentEnded('toolu_b', 'ab3', 'completed', 'a41c9e2 made it slower.'),
    )
    await settle()
    expect([outcome('toolu_q'), outcome('toolu_b'), outcome('toolu_b1')]).toEqual([
      [ToolCallState.Done, 'An N+1 in load_cart.'],
      [ToolCallState.Done, 'a41c9e2 made it slower.'],
      [ToolCallState.Error, SUBAGENT_ENDED_NOTE],
    ])
  })

  it('is stopped with Stop subagent by its SDK task, and fails once the SDK says it stopped', async () => {
    await launchInBackground(QUERIES, BISECT)
    backend.session.emit(sdk.toolUse('toolu_b1', 'Bash', { command: 'git bisect run ./bench.sh' }, 'toolu_b', 'msg_s3'))
    await settle()

    await expect(stopSubagent('toolu_b')).resolves.toBeNull()
    expect(backend.session.stoppedTasks).toEqual(['ab3'])
    expect(backend.session.interrupts).toBe(0)
    // Until the SDK says so, it's still running.
    expect(call('toolu_b').state).toBe(ToolCallState.Running)

    backend.session.emit(...sdk.subagentEnded('toolu_b', 'ab3', 'stopped', 'Bisect the slowdown'), {
      type: 'user',
      parent_tool_use_id: 'toolu_b',
      session_id: sdk.SESSION_ID,
      message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
    })
    await settle()

    expect(outcome('toolu_b')).toEqual([ToolCallState.Error, STOPPED_SUBAGENT_NOTE])
    expect(outcome('toolu_b1')).toEqual([ToolCallState.Error, STOPPED_SUBAGENT_NOTE])
    expect(call('toolu_q').state).toBe(ToolCallState.Running)
    expect(current().activity).toBe(TaskActivity.Waiting)
    // It's not running any more, so there's nothing to stop.
    await expect(stopSubagent('toolu_b')).rejects.toMatchObject({ code: BridgeErrorCode.InvalidTransition })
    await expect(stopSubagent('toolu_q')).resolves.toBeNull()
    expect(backend.session.stoppedTasks).toEqual(['ab3', 'aq1'])
  })

  it("keeps running when you stop the parent's turn", async () => {
    await launchInBackground(QUERIES)
    await send('Also check the logs.')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_02', 'Bash', { command: 'tail -f app.log' }, null, 'msg_05'))
    await settle()
    backend.session.onInterrupt = () => {
      backend.session.emit(sdk.interruptMarker(true), sdk.abortedResult('aborted_tools'))
      return Promise.resolve()
    }

    await glade.invoke(CommandName.TasksStop, { id: task.id })

    expect(outcome('toolu_02')).toEqual([ToolCallState.Error, STOPPED_NOTE])
    expect(call('toolu_q').state).toBe(ToolCallState.Running)
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('ends as interrupted on the next launch when the app quits while it runs, and nothing is resumed', async () => {
    await launchInBackground(QUERIES)
    backend.session.emit(sdk.toolUse('toolu_q1', 'Bash', { command: 'python time_queries.py' }, 'toolu_q', 'msg_s1'))
    await settle()

    runner.close()
    launch()
    expect(runner.resumeInterrupted()).toEqual([])

    expect(outcome('toolu_q')).toEqual([ToolCallState.Interrupted, RESTARTED_TOOL_NOTE])
    expect(outcome('toolu_q1')).toEqual([ToolCallState.Interrupted, RESTARTED_TOOL_NOTE])
    expect(current().activity).toBe(TaskActivity.Waiting)
    expect(backend.sessions).toHaveLength(0)
  })

  it('carries on the turn the app quit in, apart from it, when the app quits mid-turn while it runs', async () => {
    await launchInBackground(QUERIES)
    await send('Anything yet?')
    backend.session.emit(sdk.init(), sdk.toolUse('toolu_02', 'Read', { file_path: 'notes.md' }, null, 'msg_05'))
    await settle()

    runner.close()
    launch()
    expect(runner.resumeInterrupted()).toEqual([task.id])

    expect(outcome('toolu_q')).toEqual([ToolCallState.Interrupted, RESTARTED_TOOL_NOTE])
    expect(outcome('toolu_02')).toEqual([ToolCallState.Interrupted, RESTARTED_TOOL_NOTE])
    expect(listToolEvents(database.db, task.id).at(-1)).toMatchObject({ dividerKind: DividerKind.Resumed, turn: 2 })
    expect(current().activity).toBe(TaskActivity.Working)
  })

  it('fails with its session when the agent process dies, whether or not a turn is running', async () => {
    await launchInBackground(QUERIES)
    backend.session.emit(sdk.toolUse('toolu_q1', 'Bash', { command: 'python time_queries.py' }, 'toolu_q', 'msg_s1'))
    await settle()

    backend.session.fail(new Error('exit code 1'))
    await settle()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Error, 'The agent stopped: exit code 1'])
    expect(outcome('toolu_q1')).toEqual([ToolCallState.Error, 'The agent stopped: exit code 1'])
    // No turn was running, so the task itself is left as it was.
    expect(current().activity).toBe(TaskActivity.Waiting)
  })

  it('follows a subagent the SDK moves to the background mid-turn, taking its calls out of the turn', async () => {
    await send('Find the flaky tests.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_a', 'Agent', { description: 'Find flaky tests', prompt: 'Run each test 50 times.' }),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'af1',
        tool_use_id: 'toolu_a',
        task_type: 'local_agent',
        is_backgrounded: false,
        session_id: sdk.SESSION_ID,
      },
      sdk.toolUse('toolu_a1', 'Agent', { description: 'Nested look' }, 'toolu_a', 'msg_s1'),
      sdk.toolUse('toolu_a2', 'Bash', { command: 'npm test' }, 'toolu_a1', 'msg_s2'),
      { type: 'system', subtype: 'task_updated', task_id: 'af1', patch: { status: 'running' } },
      { type: 'system', subtype: 'task_updated', task_id: 'af1', patch: { is_backgrounded: true } },
      sdk.launchedResult('toolu_a', 'af1'),
      sdk.text('It went to the background.', null, 'msg_02'),
      sdk.result('It went to the background.'),
    )
    await settle()

    expect(current().activity).toBe(TaskActivity.Waiting)
    expect([call('toolu_a').state, call('toolu_a1').state, call('toolu_a2').state]).toEqual([
      ToolCallState.Running,
      ToolCallState.Running,
      ToolCallState.Running,
    ])

    backend.session.emit(
      sdk.toolResult('toolu_a2', '2 failed', false, 'toolu_a1'),
      sdk.text('Found them.', 'toolu_a1', 'msg_s3'),
      sdk.toolResult('toolu_a1', 'Two flaky tests.', false, 'toolu_a'),
      ...sdk.subagentEnded('toolu_a', 'af1', 'completed', 'Two flaky tests.'),
    )
    await settle()
    expect([outcome('toolu_a'), outcome('toolu_a1'), outcome('toolu_a2')]).toEqual([
      [ToolCallState.Done, 'Two flaky tests.'],
      [ToolCallState.Done, 'Two flaky tests.'],
      [ToolCallState.Done, '2 failed'],
    ])
  })

  it('is followed from its launched result alone, when the SDK sends no task_started for it', async () => {
    await send('Find the flaky tests.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_a', 'Agent', { description: 'Find flaky tests', run_in_background: true }),
      sdk.launchedResult('toolu_a', 'af1'),
      sdk.result('Started it.'),
    )
    await settle()

    expect(call('toolu_a').state).toBe(ToolCallState.Running)
    backend.session.emit(...sdk.subagentEnded('toolu_a', 'af1', 'completed', 'Two flaky tests.'))
    await settle()
    expect(outcome('toolu_a')).toEqual([ToolCallState.Done, 'Two flaky tests.'])
  })

  it('delivers a message queued while it launches once the step is done', async () => {
    await send('Find why checkout is slow.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_q', 'Agent', { description: 'Profile', run_in_background: true }),
    )
    await settle()
    await glade.invoke(CommandName.QueueAdd, { taskId: task.id, text: 'Profile the cart too.' })
    expect(backend.session.sent).toHaveLength(1)

    backend.session.emit(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'aq1',
        tool_use_id: 'toolu_q',
        task_type: 'local_agent',
        is_backgrounded: true,
      },
      sdk.launchedResult('toolu_q', 'aq1'),
    )
    await settle()

    expect(backend.session.sent.map(({ text }) => text)).toEqual([
      'Find why checkout is slow.',
      'Profile the cart too.',
    ])
    expect(call('toolu_q').state).toBe(ToolCallState.Running)
  })

  it("ignores a notification for a task it isn't following, and a foreground subagent's", async () => {
    await send('Find the flaky tests.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_a', 'Agent', { description: 'Find flaky tests' }),
      { type: 'system', subtype: 'task_started', task_id: 'af1', tool_use_id: 'toolu_a', task_type: 'local_agent' },
      ...sdk.subagentEnded('toolu_a', 'af1', 'completed', 'Two flaky tests.'),
      ...sdk.subagentEnded('toolu_nope', 'af9', 'failed', 'Nothing.'),
    )
    await settle()
    expect(call('toolu_a').state).toBe(ToolCallState.Running)

    backend.session.emit(sdk.toolResult('toolu_a', 'Two flaky tests.'), sdk.result('Two flaky tests.'))
    await settle()
    expect(outcome('toolu_a')).toEqual([ToolCallState.Done, 'Two flaky tests.'])
  })
})
