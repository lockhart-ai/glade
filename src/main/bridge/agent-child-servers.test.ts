// What servers a dispatched child is given, through the real bridge (#560): the main agent keeps its Glade tools, a
// child gets none of them — only a `glade` server holding `request_access` in a sandboxed session — and keeps the
// delegation tools it started with, so it can start children on the other source too. A fake agent session behind the
// real bridge, over a fake IPC pair, on a temporary database.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { CommandName, type GladeBridge } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { AGENTS_SERVER, DISPATCH_AGENT_TOOL } from '../../shared/managed-agents'
import { SAMPLE_CHOICE, SAMPLE_MODEL, SAMPLE_PROVIDER } from '../../shared/test-openrouter'
import { GLADE_SERVER } from '../agent/glade-tools'
import { FakeAgentBackend, settle, type FakeAgentSession } from '../agent/fake-backend'
import { CONTROL_SERVER } from '../control/names'
import { updateSettings } from '../db/repositories/settings'
import { setOpenRouterChoice, setOpenRouterConnection } from '../db/repositories/openrouter'
import { updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import * as sdk from '../agent/test-sdk-messages'
import { fakeIpcPair } from './fake-ipc'
import { registerBridge } from '.'

const CLAUDE = 'claude-haiku-4-5'
const INPUT = { model: SAMPLE_CHOICE.id, prompt: 'Check the sample file.', description: 'Check the file' }

let database: TestDatabase
let backend: FakeAgentBackend
let glade: GladeBridge
let task: Task
let log: MemoryLog
beforeEach(() => {
  database = openTestDatabase()
  task = sampleTask(database.db, sampleWorkspace(database.db).id)
  backend = new FakeAgentBackend()
  log = createMemoryLog()
  const ipc = fakeIpcPair()
  registerBridge({
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
  })
  glade = createBridge(ipc.renderer)
  setOpenRouterConnection(database.db, {
    encryptedKey: Buffer.from('ciphertext'),
    models: [SAMPLE_MODEL],
    providers: [SAMPLE_PROVIDER],
  })
  setOpenRouterChoice(database.db, SAMPLE_CHOICE)
})
afterEach(async () => {
  await settle()
  database.close()
  vi.restoreAllMocks()
})

async function startTurn(): Promise<FakeAgentSession> {
  updateTask(database.db, task.id, { model: CLAUDE })
  await glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Delegate this work.' })
  const parent = backend.session
  parent.emit(sdk.init())
  await settle()
  return parent
}

async function dispatchedChild(parent: FakeAgentSession): Promise<FakeAgentSession> {
  const call = parent.callTool('dispatch', DISPATCH_AGENT_TOOL, INPUT)
  await vi.waitFor(() => {
    expect(backend.sessions).toHaveLength(2)
  })
  const child = backend.session
  child.emit(sdk.result('Checked'))
  await call
  await settle()
  return child
}

it('gives the main agent its Glade tools and a child none of them', async () => {
  const parent = await startTurn()
  expect(parent.options.mcpServers).toHaveProperty(GLADE_SERVER)

  const child = await dispatchedChild(parent)

  expect(child.options.mcpServers).not.toHaveProperty(GLADE_SERVER)
  expect(child.options.mcpServers).not.toHaveProperty(CONTROL_SERVER)
  // The child keeps its own delegation tools, so it can start children on the other source too.
  expect(child.options.mcpServers).toHaveProperty(AGENTS_SERVER)
})

it('gives a sandboxed child only a glade server for asking about access', async () => {
  updateSettings(database.db, { sandboxEnabled: true })
  const parent = await startTurn()

  const child = await dispatchedChild(parent)

  expect(child.options.mcpServers).toMatchObject({ [GLADE_SERVER]: { type: 'sdk', name: GLADE_SERVER } })
  expect(child.options.mcpServers).toHaveProperty(AGENTS_SERVER)
})
