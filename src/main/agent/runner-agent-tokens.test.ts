// The token totals each Agents tab shows (#566): the runner adds every assistant message's input and output tokens
// into the total of the agent it answered — Main's own messages, and each subagent's, background included — keeps
// them in SQLite across relaunches, and sends the tab the running total. A scripted agent session behind the real
// bridge, saving to a database.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, EventType, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import { UiStateKey, type Task, type Workspace } from '../../shared/domain'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { agentTokenTotals } from '../db/repositories/agent-tokens'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { FakeAgentBackend, settle } from './fake-backend'
import type { AgentRunner } from './runner'
import * as sdk from './test-sdk-messages'

let database: TestDatabase
let workspace: Workspace
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
    pluginsFolder: '../plugins/test-plugins',
    agentBackend: backend,
  }))
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
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

/** A turn the agent started itself: one message of its own, then a foreground subagent answering three. */
async function runTurn(): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Draft the 2.4 release notes.' })
  backend.session.emit(
    sdk.init(),
    sdk.toolUse('toolu_api', 'Agent', { description: 'API changes', prompt: 'Sort the API PRs.' }),
    sdk.text('Reading the API PRs.', 'toolu_api', 'msg_a1'),
    sdk.toolUse('toolu_a1', 'Bash', { command: 'gh pr list' }, 'toolu_api', 'msg_a1'),
    sdk.toolResult('toolu_a1', '1402\tRate limit the public API', false, 'toolu_api'),
    sdk.text('Two PRs to change.', 'toolu_api', 'msg_a2'),
    sdk.text('Writing the notes.', null, 'msg_02'),
    sdk.text('One more.', null, 'msg_03'),
  )
  await settle()
}

describe('the token totals an Agents tab shows', () => {
  it('add up per agent from each assistant message, are sent to the renderer, and survive a relaunch', async () => {
    await runTurn()
    // The helper's assistant messages each use 10 in / 1 out: Main answered three (the `Agent` call among them),
    // its subagent three, in the order the messages arrived.
    expect(agentTokenTotals(database.db, task.id)).toEqual([
      { agentId: null, inputTokens: 30, outputTokens: 3 },
      { agentId: 'toolu_api', inputTokens: 30, outputTokens: 3 },
    ])
    // The renderer hears each agent's cumulative total as it rose, its tab alone.
    expect(
      events
        .filter((event) => event.type === EventType.AgentTokensChanged)
        .map((event) => [event.total.agentId, event.total.inputTokens, event.total.outputTokens]),
    ).toEqual([
      [null, 10, 1],
      ['toolu_api', 10, 1],
      ['toolu_api', 20, 2],
      ['toolu_api', 30, 3],
      [null, 20, 2],
      [null, 30, 3],
    ])
    // The history command carries them, so the tabs show the totals again after a relaunch.
    const history = await glade.invoke(CommandName.TasksHistory, { id: task.id })
    expect(history.agentTokens).toEqual([
      { agentId: null, inputTokens: 30, outputTokens: 3 },
      { agentId: 'toolu_api', inputTokens: 30, outputTokens: 3 },
    ])
  })

  it('add up for a background subagent between turns, and say nothing when a message carries no usage', async () => {
    await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Check the API PRs.' })
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_bg', 'sdk_bg_1', 'Watch the PRs'),
      sdk.text('Reading in the background.', 'toolu_bg', 'msg_b1'),
    )
    await settle()
    // The `Agent` call's message is Main's; the background subagent's message is its own total, though no turn is open.
    expect(agentTokenTotals(database.db, task.id)).toEqual([
      { agentId: null, inputTokens: 10, outputTokens: 1 },
      { agentId: 'toolu_bg', inputTokens: 10, outputTokens: 1 },
    ])

    backend.session.emit({ type: 'assistant', parent_tool_use_id: null, message: { content: [] } })
    await settle()
    // A message with no usage adds nothing, and isn't sent.
    expect(
      events.filter((event) => event.type === EventType.AgentTokensChanged).map((event) => event.total.agentId),
    ).toEqual([null, 'toolu_bg'])
    expect(agentTokenTotals(database.db, task.id)).toEqual([
      { agentId: null, inputTokens: 10, outputTokens: 1 },
      { agentId: 'toolu_bg', inputTokens: 10, outputTokens: 1 },
    ])
  })
})
