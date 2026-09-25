// The plugin feed end to end in main: a plugin in a plugins folder, shown and `ready`, fed what a scripted agent session
// does behind the real bridge and runner, saving to a database in a temporary folder. Covers what only the runner
// produces: parallel tool calls, foreground and background subagents, turns the agent starts itself, and permission
// requests.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import {
  Effort,
  PermissionDecisionKind,
  PermissionMode,
  UiStateKey,
  type Task,
  type Workspace,
} from '../../shared/domain'
import { PluginEventType, type GladeMessage, type PluginEvent } from '../../shared/plugin-api'
import { gladeMessageSchema } from '../../shared/plugin-api-schema'
import { registerBridge } from '../bridge'
import { fakeIpcPair } from '../bridge/fake-ipc'
import { FakeAgentBackend, settle } from '../agent/fake-backend'
import type { AgentRunner } from '../agent/runner'
import * as sdk from '../agent/test-sdk-messages'
import { createTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { setUiState } from '../db/repositories/ui-state'
import { createWorkspace } from '../db/repositories/workspaces'
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

beforeEach(async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  task = sampleTask(database.db, workspace.id)
  setUiState(database.db, { key: UiStateKey.SelectedTaskId, value: task.id })
  pluginsParent = tempPluginsParent()
  const pluginsFolder = join(pluginsParent, 'plugins')
  writePlugin(pluginsFolder, 'nekomata')
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
    pluginsFolder,
    createPluginView: views.create,
    appVersion: '0.11.0',
    agentBackend: backend,
  }))
  glade = createBridge(ipc.renderer)
  await glade.invoke(CommandName.PluginsList, {})
  await glade.invoke(CommandName.PluginsPlaceView, {
    id: 'nekomata',
    bounds: { x: 0, y: 0, width: 600, height: 250 },
  })
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

/** What the plugin was sent, checked against the schema, with seq counting up from 1 with no gaps. */
function received(): PluginEvent[] {
  const { sent } = view()
  const run: GladeMessage[] = []
  for (const message of sent) {
    expect(gladeMessageSchema.parse(message)).toEqual(message)
    if (message.event.type === PluginEventType.Hello) run.length = 0
    run.push(message)
  }
  expect(run.map(({ seq }) => seq)).toEqual(run.map((_, index) => index + 1))
  return run.map(({ event }) => event)
}

/** Each event after the snapshot as a line: what changed, and the part of it that matters here. */
function lines(): string[] {
  return received()
    .slice(2)
    .map((event) => {
      switch (event.type) {
        case PluginEventType.TaskCreated:
        case PluginEventType.TaskUpdated:
          return `${event.type} ${event.task.title || '(untitled)'} ${event.task.activity}${event.task.needsYou ? ' needs you' : ''}${event.task.waitingOn === null ? '' : ` on ${event.task.waitingOn}`}`
        case PluginEventType.AgentToolCall:
          return `call ${event.call.tool} ${event.call.summary} ${event.call.state}${event.call.subagentId === null ? '' : ` in ${event.call.subagentId}`}`
        case PluginEventType.AgentNote:
          return `note ${event.text}${event.subagentId === null ? '' : ` in ${event.subagentId}`}`
        case PluginEventType.SubagentStarted:
        case PluginEventType.SubagentUpdated:
          return `${event.type} ${event.subagent.name} ${event.subagent.state}: ${String(event.subagent.latest)}`
        case PluginEventType.PermissionOpened:
          return `permission ${event.request.tool} ${event.request.summary}${event.request.subagentId === null ? '' : ` in ${event.request.subagentId}`}`
        case PluginEventType.PermissionClosed:
          return `permission closed ${event.outcome}`
        case PluginEventType.Hello:
        case PluginEventType.Snapshot:
        case PluginEventType.TaskDeleted:
        case PluginEventType.QuestionOpened:
        case PluginEventType.QuestionClosed:
          return event.type
      }
    })
}

async function ready(): Promise<void> {
  view().post({ type: 'ready' })
  await settle()
}

async function send(text: string): Promise<void> {
  await glade.invoke(CommandName.TasksSend, { id: task.id, text })
  await settle()
}

it('sends hello and a snapshot of the tasks in every workspace after ready, then what the agent does', async () => {
  const billing = createWorkspace(database.db, { name: 'Billing', rootPath: '/code/billing' }, 1_000)
  const other = createTask(
    database.db,
    { workspaceId: billing.id, model: 'claude-sample-1', effort: Effort.Low },
    3_000,
  )
  expect(view().sent).toEqual([])

  await ready()

  const [hello, snapshot] = received()
  expect(hello).toEqual({ type: PluginEventType.Hello, app: { name: 'Glade', version: '0.11.0' } })
  expect(snapshot).toMatchObject({
    type: PluginEventType.Snapshot,
    tasks: [
      { id: task.id, workspaceName: 'Acme API' },
      { id: other.id, workspaceName: 'Billing' },
    ],
  })
})

describe('a turn', () => {
  beforeEach(ready)

  it('with parallel tool calls and a subagent', async () => {
    await send('Fix the date bug.')
    backend.session.emit(
      sdk.init(),
      sdk.text("I'll look at the date code and the tests.", null, 'msg_01'),
      sdk.toolUse('toolu_r', 'Read', { file_path: '/code/acme-api/src/date.ts' }, null, 'msg_02'),
      sdk.toolUse('toolu_g', 'Grep', { pattern: 'formatDate' }, null, 'msg_02'),
      sdk.toolUse('toolu_s', 'Agent', { description: 'Check the tests', prompt: 'Run them all.' }, null, 'msg_02'),
      sdk.toolResult('toolu_g', 'src/date.ts:12'),
      sdk.toolUse('toolu_s1', 'Bash', { command: 'npm test' }, 'toolu_s', 'msg_s1'),
      sdk.toolResult('toolu_r', 'export function formatDate() {}'),
      sdk.toolResult('toolu_s1', '12 passed', false, 'toolu_s'),
      sdk.toolResult('toolu_s', 'All 12 pass.'),
      sdk.text('The bug is in formatDate.', null, 'msg_03'),
      sdk.result('The bug is in formatDate.'),
    )
    await settle()

    expect(lines()).toEqual([
      'task.updated (untitled) working',
      "note I'll look at the date code and the tests.",
      'call Read src/date.ts running',
      'call Grep formatDate running',
      'call Agent Check the tests running',
      'subagent.started Check the tests running: null',
      'call Grep formatDate done',
      'subagent.updated Check the tests running: Bash npm test',
      'call Bash npm test running in toolu_s',
      'call Read src/date.ts done',
      'call Bash npm test done in toolu_s',
      'call Agent Check the tests done',
      'subagent.updated Check the tests done: Bash npm test',
      'task.updated (untitled) waiting needs you',
    ])
    // Neither what was asked nor what the agent replied reached the plugin.
    expect(JSON.stringify(view().sent)).not.toMatch(/Fix the date bug|The bug is in formatDate|12 passed|Run them all/)
  })

  it('with a background subagent that runs on after it, and a turn the agent starts itself to report it', async () => {
    await send('Find why checkout is slow.')
    backend.session.emit(
      sdk.init(),
      ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
      sdk.text('I started it in the background.', null, 'msg_02'),
      sdk.result('I started it in the background.'),
    )
    await settle()
    backend.session.emit(sdk.toolUse('toolu_q1', 'Bash', { command: 'python time_queries.py' }, 'toolu_q', 'msg_s1'))
    await settle()
    const running = lines()

    backend.session.emit(
      ...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'),
      sdk.init(),
      sdk.text('The profile is back: an N+1 in load_cart.', null, 'msg_04'),
      sdk.selfStartedResult('The profile is back: an N+1 in load_cart.'),
    )
    await settle()

    expect(running).toEqual([
      'task.updated (untitled) working',
      'call Agent Profile the checkout queries running',
      'subagent.started Profile the checkout queries running: null',
      // Its turn ends, and the task waits on you, while it runs on.
      'task.updated (untitled) waiting needs you',
      'subagent.updated Profile the checkout queries running: Bash python time_queries.py',
      'call Bash python time_queries.py running in toolu_q',
    ])
    expect(lines().slice(running.length)).toEqual([
      // A call still running when its background subagent ends fails with it.
      'call Bash python time_queries.py failed in toolu_q',
      'call Agent Profile the checkout queries done',
      'subagent.updated Profile the checkout queries done: Bash python time_queries.py',
      // The turn the agent starts itself to report it: working, with no message from you, then waiting again.
      'task.updated (untitled) working',
      'task.updated (untitled) waiting needs you',
    ])
    expect(JSON.stringify(view().sent)).not.toMatch(/N\+1/)
  })

  it('with a permission request from a subagent, allowed', async () => {
    await glade.invoke(CommandName.TasksUpdate, {
      id: task.id,
      patch: { permissionMode: PermissionMode.AskBeforeEdits },
    })
    await send('Publish it.')
    backend.session.emit(
      sdk.init(),
      sdk.toolUse('toolu_s', 'Agent', { description: 'Publish' }, null, 'msg_02'),
      sdk.toolUse('toolu_p', 'Bash', { command: 'npm publish' }, 'toolu_s', 'msg_s1'),
    )
    await settle()
    backend.session.requestPermission({
      toolUseId: 'toolu_p',
      toolName: 'Bash',
      input: { command: 'npm publish' },
      agentId: 'agent-1',
      title: 'Claude wants to run npm publish',
    })
    await settle()
    const request = (await glade.invoke(CommandName.TasksHistory, { id: task.id })).permissionRequests[0]

    await glade.invoke(CommandName.PermissionsAnswer, {
      id: request?.id ?? '',
      decision: { kind: PermissionDecisionKind.AllowOnce },
    })
    await settle()

    expect(lines()).toEqual([
      'task.updated (untitled) working',
      'call Agent Publish running',
      'subagent.started Publish running: null',
      'subagent.updated Publish running: Bash npm publish',
      'call Bash npm publish running in toolu_s',
      'permission Bash npm publish in toolu_s',
      // The turn waits on your OK, so the task needs you.
      'task.updated (untitled) waiting needs you on permission',
      'permission closed allowed',
      'task.updated (untitled) waiting needs you',
      'task.updated (untitled) working',
    ])
    expect(JSON.stringify(view().sent)).not.toContain('Claude wants to run')
  })
})

it('starts over when the page posts ready again, and stops when the plugin is turned off', async () => {
  await ready()
  await send('Fix the date bug.')
  const before = received().length

  await ready()
  expect(received().map(({ type }) => type)).toEqual([PluginEventType.Hello, PluginEventType.Snapshot])
  expect(received()[1]).toMatchObject({ tasks: [{ id: task.id, activity: 'working' }] })
  expect(before).toBeGreaterThan(2)

  await glade.invoke(CommandName.PluginsSetEnabled, { id: 'nekomata', enabled: false })
  const sent = view().sent.length
  backend.session.emit(sdk.init(), sdk.text('Done.', null, 'msg_02'), sdk.result('Done.'))
  await settle()

  expect(view().destroyed).toBe(true)
  expect(view().sent).toHaveLength(sent)
})
