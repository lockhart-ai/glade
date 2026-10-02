// Subagents woken again (#395, `docs/sdk-notes.md`, "Subagents woken again"): a subagent that had finished, or was
// interrupted by a relaunch, runs again when the agent messages it with `SendMessage`, or when the SDK starts it again
// itself. A fake agent session behind the real bridge, saving to a database in a temporary folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
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
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { findSubagentCall, listToolEvents } from '../db/repositories/tool-events'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { FakeAgentBackend, settle } from './fake-backend'
import { RESTARTED_TOOL_NOTE, STOPPED_SUBAGENT_NOTE, SUBAGENT_ENDED_NOTE, type AgentRunner } from './runner'
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
    pluginsFolder: UNREAD_PLUGINS_FOLDER,
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

function call(toolUseId: string): ToolCallEvent {
  const found = listToolEvents(database.db, task.id).find(
    (event): event is ToolCallEvent => event.kind === ToolEventKind.ToolCall && event.toolUseId === toolUseId,
  )
  if (found === undefined) throw new Error(`No call ${toolUseId}`)
  return found
}

function outcome(toolUseId: string): [ToolCallState, string | null] {
  const { state, output } = call(toolUseId)
  return [state, output]
}

/** The subagents running in every task, as the task list counts them on start. */
async function running(): Promise<string[]> {
  const { calls } = await glade.invoke(CommandName.SubagentsListRunning, {})
  return calls.map(({ toolUseId }) => toolUseId)
}

/** A first turn that starts the subagent in the background, which then makes a call and finishes. */
async function runAndFinish(): Promise<void> {
  await send('Find why checkout is slow.')
  backend.session.emit(
    sdk.init(),
    ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
    sdk.text('I started it in the background.', null, 'msg_02'),
    sdk.result('I started it in the background.'),
    sdk.toolUse('toolu_q1', 'Bash', { command: 'python time_queries.py' }, 'toolu_q', 'msg_s1'),
    sdk.toolResult('toolu_q1', 'load_cart  38 queries', false, 'toolu_q'),
    ...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'),
  )
  await settle()
}

/** A turn of the agent's in which it messages the subagent, waking it, and replies while it works. */
async function wake(message = 'Now fix it.'): Promise<void> {
  await send('Ask it to fix that.')
  backend.session.emit(
    sdk.init(),
    ...sdk.subagentWoken('toolu_m', 'aq1', 'Profile the checkout queries', message),
    sdk.text('I asked it to fix that.', null, 'msg_05'),
    sdk.result('I asked it to fix that.'),
  )
  await settle()
}

describe('a subagent the agent messages after it finished', () => {
  it('runs again in its own row, keeping its log, with what it does now logged under it', async () => {
    await runAndFinish()
    expect(outcome('toolu_q')).toEqual([ToolCallState.Done, 'An N+1 in load_cart.'])
    expect(await running()).toEqual([])

    await wake()

    expect(call('toolu_q')).toMatchObject({ state: ToolCallState.Running, output: null, finishedAt: null })
    expect(await running()).toEqual(['toolu_q'])
    // The call that woke it is the agent's own, and done at once.
    expect(outcome('toolu_m')).toEqual([ToolCallState.Done, 'Resuming agent aq1'])
    expect(current().activity).toBe(TaskActivity.Waiting)

    // Its run's messages carry its own `Agent` call, between turns too; its progress comes under the waking call.
    backend.session.emit(
      sdk.text('Batching the cart queries.', 'toolu_q', 'msg_s2'),
      sdk.toolUse('toolu_q2', 'Edit', { file_path: 'cart.py' }, 'toolu_q', 'msg_s2'),
      sdk.subagentProgress('toolu_m', 'aq1', 'Batching the cart queries'),
    )
    await settle()
    expect(call('toolu_q2')).toMatchObject({ state: ToolCallState.Running, parentToolUseId: 'toolu_q', turn: 1 })
    expect(call('toolu_q')).toMatchObject({ progressSummary: 'Batching the cart queries' })
    // What it did before is still its.
    expect(call('toolu_q1')).toMatchObject({ state: ToolCallState.Done, parentToolUseId: 'toolu_q' })

    backend.session.emit(
      sdk.toolResult('toolu_q2', 'Edited.', false, 'toolu_q'),
      ...sdk.subagentEnded('toolu_m', 'aq1', 'completed', 'Fixed the N+1.'),
    )
    await settle()

    expect(call('toolu_q')).toMatchObject({
      state: ToolCallState.Done,
      output: 'Fixed the N+1.',
      progressSummary: null,
    })
    expect(call('toolu_q').finishedAt).not.toBeNull()
    expect(outcome('toolu_m')).toEqual([ToolCallState.Done, 'Resuming agent aq1'])
    expect(await running()).toEqual([])
  })

  it('fails when its new run fails, and its calls still running fail with it', async () => {
    await runAndFinish()
    await wake()
    backend.session.emit(sdk.toolUse('toolu_q2', 'Bash', { command: 'pytest' }, 'toolu_q', 'msg_s2'))
    await settle()

    backend.session.emit(...sdk.subagentEnded('toolu_m', 'aq1', 'failed', 'pytest crashed.'))
    await settle()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Error, 'pytest crashed.'])
    expect(outcome('toolu_q2')).toEqual([ToolCallState.Error, SUBAGENT_ENDED_NOTE])
  })

  it('stops with Stop subagent, by its SDK task id, even though the SDK reports it under the waking call', async () => {
    await runAndFinish()
    await wake()

    await glade.invoke(CommandName.SubagentsStop, { taskId: task.id, toolUseId: 'toolu_q' })
    expect(backend.session.stoppedTasks).toEqual(['aq1'])
    backend.session.emit(...sdk.subagentEnded('toolu_m', 'aq1', 'stopped', 'Profile the checkout queries'))
    await settle()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Error, STOPPED_SUBAGENT_NOTE])
  })

  it('wakes a foreground subagent the same way', async () => {
    await send('Check the tests.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_s', 'Agent', { description: 'Check the tests', prompt: 'Run them all.' }),
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'as1',
        tool_use_id: 'toolu_s',
        description: 'Check the tests',
        task_type: 'local_agent',
        is_backgrounded: false,
        session_id: sdk.SESSION_ID,
      },
      ...sdk.subagentEnded('toolu_s', 'as1', 'completed', 'All 12 pass.'),
      sdk.toolResult('toolu_s', 'All 12 pass.'),
      sdk.result('All 12 pass.'),
    )
    await settle()
    expect(outcome('toolu_s')).toEqual([ToolCallState.Done, 'All 12 pass.'])
    expect(findSubagentCall(database.db, task.id, 'as1')?.toolUseId).toBe('toolu_s')

    await send('Ask it to run them again.')
    backend.session.emit(
      sdk.init(),
      ...sdk.subagentWoken('toolu_m', 'as1', 'Check the tests', 'Run them again.'),
      sdk.result('Asked.'),
    )
    await settle()
    expect(call('toolu_s').state).toBe(ToolCallState.Running)

    backend.session.emit(...sdk.subagentEnded('toolu_m', 'as1', 'completed', 'Still 12 pass.'))
    await settle()
    expect(outcome('toolu_s')).toEqual([ToolCallState.Done, 'Still 12 pass.'])
  })
})

describe('a subagent the SDK starts again itself', () => {
  it('runs again under its own call once the work it left running ends, then ends again', async () => {
    await runAndFinish()

    backend.session.emit({
      type: 'system',
      subtype: 'task_started',
      task_id: 'aq1',
      tool_use_id: 'toolu_q',
      description: 'Profile the checkout queries',
      task_type: 'local_agent',
      is_backgrounded: true,
      session_id: sdk.SESSION_ID,
    })
    await settle()
    expect(call('toolu_q')).toMatchObject({ state: ToolCallState.Running, output: null })

    backend.session.emit(...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'The slow build is done too.'))
    await settle()
    expect(outcome('toolu_q')).toEqual([ToolCallState.Done, 'The slow build is done too.'])
  })
})

describe('a subagent the agent messages after a relaunch', () => {
  it('runs again after it was interrupted by the app quitting, from the id kept in the database', async () => {
    await send('Find why checkout is slow.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.result('I started it in the background.'),
    )
    await settle()

    runner.close()
    launch()
    runner.resumeInterrupted()
    expect(outcome('toolu_q')).toEqual([ToolCallState.Interrupted, RESTARTED_TOOL_NOTE])
    expect(await running()).toEqual([])

    await wake('Carry on from where you were.')
    expect(backend.sessions).toHaveLength(1)
    expect(call('toolu_q')).toMatchObject({ state: ToolCallState.Running, output: null, finishedAt: null })
    expect(await running()).toEqual(['toolu_q'])

    backend.session.emit(...sdk.subagentEnded('toolu_m', 'aq1', 'completed', 'An N+1 in load_cart.'))
    await settle()
    expect(outcome('toolu_q')).toEqual([ToolCallState.Done, 'An N+1 in load_cart.'])
  })

  it('stays running in the database while it runs, so a second quit interrupts it again', async () => {
    await runAndFinish()
    await wake()

    runner.close()
    launch()
    runner.resumeInterrupted()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Interrupted, RESTARTED_TOOL_NOTE])
  })

  it('fails with its session when the agent process dies', async () => {
    await runAndFinish()
    await wake()

    backend.session.fail(new Error('exit code 1'))
    await settle()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Error, 'The agent stopped: exit code 1'])
  })
})

describe('a subagent started before Glade kept its SDK task id', () => {
  /** Forgets the id the first run recorded, as a database from before migration 47 has it. */
  function forgetIds(): void {
    database.db.prepare('UPDATE tool_events SET sdk_task_id = NULL').run()
  }

  it('is known by the first message of its new run, whose parent is its call', async () => {
    await runAndFinish()
    forgetIds()

    await wake()
    expect(call('toolu_q').state).toBe(ToolCallState.Done)

    backend.session.emit(sdk.toolUse('toolu_q2', 'Edit', { file_path: 'cart.py' }, 'toolu_q', 'msg_s2'))
    await settle()
    expect(call('toolu_q').state).toBe(ToolCallState.Running)
    expect(call('toolu_q2')).toMatchObject({ state: ToolCallState.Running, parentToolUseId: 'toolu_q' })
    expect(findSubagentCall(database.db, task.id, 'aq1')?.toolUseId).toBe('toolu_q')

    backend.session.emit(...sdk.subagentEnded('toolu_m', 'aq1', 'completed', 'Fixed the N+1.'))
    await settle()
    expect(outcome('toolu_q')).toEqual([ToolCallState.Done, 'Fixed the N+1.'])
    expect(outcome('toolu_q2')).toEqual([ToolCallState.Error, SUBAGENT_ENDED_NOTE])
  })

  it("isn't taken for a message from a subagent that's running, or from the agent itself", async () => {
    await runAndFinish()
    forgetIds()
    await send('Check the tests too.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_s', 'Agent', { description: 'Check the tests', prompt: 'Run them all.' }),
      ...sdk.subagentWoken('toolu_m', 'aq1', 'Profile the checkout queries', 'Now fix it.'),
      sdk.toolUse('toolu_s1', 'Bash', { command: 'npm test' }, 'toolu_s', 'msg_s1'),
      sdk.toolUse('toolu_r', 'Read', { file_path: 'cart.py' }, null, 'msg_03'),
    )
    await settle()

    expect(call('toolu_q').state).toBe(ToolCallState.Done)
    expect(call('toolu_s1').parentToolUseId).toBe('toolu_s')
  })

  it('is forgotten when its run ends before it says anything', async () => {
    await runAndFinish()
    forgetIds()
    await wake()

    backend.session.emit(...sdk.subagentEnded('toolu_m', 'aq1', 'completed', 'Nothing to fix.'))
    await settle()
    backend.session.emit(sdk.toolUse('toolu_x', 'Read', { file_path: 'cart.py' }, 'toolu_q', 'msg_s3'))
    await settle()

    expect(outcome('toolu_q')).toEqual([ToolCallState.Done, 'An N+1 in load_cart.'])
    expect(outcome('toolu_m')).toEqual([ToolCallState.Done, 'Resuming agent aq1'])
  })
})

it("leaves a subagent task some other call started as before: its call runs until the task's notification", async () => {
  await send('Run the review skill.')
  backend.session.emit(
    sdk.init(),
    sdk.toolUse('toolu_k', 'Skill', { skill: 'review' }),
    {
      type: 'system',
      subtype: 'task_started',
      task_id: 'ak1',
      tool_use_id: 'toolu_k',
      description: 'review',
      task_type: 'local_agent',
      is_backgrounded: true,
      session_id: sdk.SESSION_ID,
    },
    sdk.toolResult('toolu_k', 'Launched.'),
    sdk.result('Started the review.'),
  )
  await settle()
  expect(call('toolu_k').state).toBe(ToolCallState.Running)

  backend.session.emit(...sdk.subagentEnded('toolu_k', 'ak1', 'completed', 'Reviewed.'))
  await settle()
  expect(outcome('toolu_k')).toEqual([ToolCallState.Done, 'Reviewed.'])
})

function current(): Task {
  const found = getTask(database.db, task.id)
  if (found === undefined) throw new Error('The task is gone')
  return found
}
