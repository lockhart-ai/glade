// Whose tool log a subagent's work goes in (P9-04): every call and note from inside a subagent is saved under the `Agent`
// call that started it (`parentToolUseId`), never as the task's own, so the tool log can show only the parent's calls
// and the Subagents tab each subagent's. Foreground and background subagents, nested ones, two interleaving, a failing
// call, and a relaunch: a scripted agent session behind the real bridge, saving to a database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  type Task,
  type ToolEvent,
  type Workspace,
} from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import { RESTARTED_TOOL_NOTE, type AgentRunner } from './runner'
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

/** The task's tool log, as the renderer loads it. */
async function history(): Promise<readonly ToolEvent[]> {
  return (await glade.invoke(CommandName.TasksHistory, { id: task.id })).toolEvents
}

/** Each call and note in the log, as `id <- parent` (a note by its text), and each call's state. */
async function whose(): Promise<string[]> {
  return (await history()).flatMap((event) => {
    switch (event.kind) {
      case ToolEventKind.ToolCall:
        return [`${event.toolUseId} <- ${event.parentToolUseId ?? 'task'} (${event.state})`]
      case ToolEventKind.Narration:
        return [`"${event.text}" <- ${event.parentToolUseId ?? 'task'}`]
      case ToolEventKind.Divider:
      case ToolEventKind.Compaction:
        return []
    }
  })
}

/** The task's own calls: what the tool log shows. */
async function parentCalls(): Promise<string[]> {
  return (await history()).flatMap((event) =>
    event.kind === ToolEventKind.ToolCall && event.parentToolUseId === null ? [event.toolUseId] : [],
  )
}

/**
 * A foreground turn: two subagents interleaving their calls, one of which starts a nested subagent and has a call
 * fail, while the parent makes a call of its own. It stops with the subagents still working.
 */
async function interleavedTurn(): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Draft the 2.4 release notes.' })
  backend.session.emit(
    sdk.init(),
    sdk.toolUse('toolu_api', 'Agent', { description: 'API changes', prompt: 'Sort the API PRs.' }),
    sdk.toolUse('toolu_web', 'Agent', { description: 'Dashboard changes', prompt: 'Sort the dashboard PRs.' }),
    sdk.text('Reading the API PRs.', 'toolu_api', 'msg_a1'),
    sdk.toolUse('toolu_a1', 'Bash', { command: 'gh pr list --label api' }, 'toolu_api', 'msg_a1'),
    sdk.toolUse('toolu_w1', 'Bash', { command: 'redis-cli info' }, 'toolu_web', 'msg_w1'),
    sdk.toolResult('toolu_a1', '1402\tRate limit the public API', false, 'toolu_api'),
    sdk.toolResult('toolu_w1', 'Could not connect to Redis', true, 'toolu_web'),
    sdk.toolUse(
      'toolu_nested',
      'Agent',
      { description: 'Read PR 1402', prompt: 'Summarise it.' },
      'toolu_api',
      'msg_a2',
    ),
    sdk.toolUse('toolu_n1', 'Read', { file_path: 'api/throttles.py' }, 'toolu_nested', 'msg_n1'),
    sdk.toolUse('toolu_own', 'Read', { file_path: 'CHANGELOG.md' }, null, 'msg_02'),
    sdk.toolResult('toolu_n1', 'RATE = 10', false, 'toolu_nested'),
    sdk.toolResult('toolu_own', '# Changelog'),
    sdk.toolUse('toolu_w2', 'Read', { file_path: 'web/charts.ts' }, 'toolu_web', 'msg_w2'),
  )
  await settle()
}

describe('a subagent’s tool calls', () => {
  it('are saved under their subagent, never as the task’s own, when subagents nest, interleave and fail', async () => {
    await interleavedTurn()

    expect(await whose()).toEqual([
      'toolu_api <- task (running)',
      'toolu_web <- task (running)',
      '"Reading the API PRs." <- toolu_api',
      'toolu_a1 <- toolu_api (done)',
      'toolu_w1 <- toolu_web (error)',
      'toolu_nested <- toolu_api (running)',
      'toolu_n1 <- toolu_nested (done)',
      'toolu_own <- task (done)',
      'toolu_w2 <- toolu_web (running)',
    ])
    expect(await parentCalls()).toEqual(['toolu_api', 'toolu_web', 'toolu_own'])
  })

  it('stay under their subagent once the app quits and relaunches, interrupted', async () => {
    await interleavedTurn()

    runner.close()
    launch()
    runner.resumeInterrupted()

    expect(await parentCalls()).toEqual(['toolu_api', 'toolu_web', 'toolu_own'])
    const events = await history()
    const w2 = events.find((event) => event.kind === ToolEventKind.ToolCall && event.toolUseId === 'toolu_w2')
    expect(w2).toMatchObject({
      parentToolUseId: 'toolu_web',
      state: ToolCallState.Interrupted,
      output: RESTARTED_TOOL_NOTE,
    })
  })

  it('from a background subagent are saved under it too, between turns and after a relaunch', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Find why checkout is slow.' })
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.text('Started it.', null, 'msg_02'),
      sdk.result('Started it.'),
    )
    await settle()
    backend.session.emit(
      sdk.toolUse('toolu_q1', 'Read', { file_path: 'api/checkout/queries.py' }, 'toolu_q', 'msg_s1'),
      sdk.toolResult('toolu_q1', 'def load_cart(cart_id): …', false, 'toolu_q'),
      sdk.toolUse('toolu_q2', 'Agent', { description: 'Time load_cart' }, 'toolu_q', 'msg_s2'),
      sdk.toolUse('toolu_q3', 'Bash', { command: 'python time_queries.py' }, 'toolu_q2', 'msg_s3'),
    )
    await settle()

    expect(await whose()).toEqual([
      'toolu_q <- task (running)',
      'toolu_q1 <- toolu_q (done)',
      'toolu_q2 <- toolu_q (running)',
      'toolu_q3 <- toolu_q2 (running)',
    ])

    runner.close()
    launch()
    runner.resumeInterrupted()

    expect(await whose()).toEqual([
      'toolu_q <- task (interrupted)',
      'toolu_q1 <- toolu_q (done)',
      'toolu_q2 <- toolu_q (interrupted)',
      'toolu_q3 <- toolu_q2 (interrupted)',
    ])
    expect(await parentCalls()).toEqual(['toolu_q'])
  })
})
