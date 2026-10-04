// Which agent's tab a task's Agents tab was on, over the bridge (P16, #536): the preload's `window.glade` over a fake
// IPC pair, against the real main-side registry, handlers and repositories on a temporary database. What a window can
// set and read back while the hidden switch is on, what a bad payload gets, and that with the switch off the command is
// refused and a task's history carries nothing of it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createBridge } from '../../preload/bridge'
import { BridgeErrorCode, CommandName, type GladeBridge, type GladeEvent } from '../../shared/bridge'
import type { Task } from '../../shared/domain'
import { FakeAgentBackend } from '../agent/fake-backend'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { UNREAD_PLUGINS_FOLDER } from '../plugins/test-plugins'
import { fakeTerminalOptions } from '../terminal/fake-pty'
import { fakeIpcPair } from './fake-ipc'
import { registerBridge } from '.'

let database: TestDatabase
let glade: GladeBridge
let task: Task
let other: Task
let events: GladeEvent[]

beforeEach(() => {
  database = openTestDatabase()
  const workspaceId = sampleWorkspace(database.db).id
  task = sampleTask(database.db, workspaceId)
  other = sampleTask(database.db, workspaceId)
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
    agentBackend: new FakeAgentBackend(),
  })
  glade = createBridge(ipc.renderer)
  events = []
  glade.subscribe((event) => events.push(event))
})

afterEach(() => {
  database.close()
})

const rows = (): unknown => database.db.prepare('SELECT COUNT(*) FROM agent_tabs').pluck().get()

const agentTab = async (taskId: string): Promise<string | null> =>
  (await glade.invoke(CommandName.TasksHistory, { id: taskId })).agentTab

describe('agents.setTab', () => {
  it('remembers each task’s agent, which its history then carries, without telling the windows', async () => {
    expect(await agentTab(task.id)).toBeNull()

    await expect(
      glade.invoke(CommandName.AgentsSetTab, { taskId: task.id, agentId: 'toolu_fix_501' }),
    ).resolves.toBeNull()
    await glade.invoke(CommandName.AgentsSetTab, { taskId: other.id, agentId: 'toolu_docs_503' })
    await glade.invoke(CommandName.AgentsSetTab, { taskId: task.id, agentId: 'toolu_limits_502' })

    expect(await agentTab(task.id)).toBe('toolu_limits_502')
    expect(await agentTab(other.id)).toBe('toolu_docs_503')

    // Main again: forgotten.
    await glade.invoke(CommandName.AgentsSetTab, { taskId: task.id, agentId: null })
    expect(await agentTab(task.id)).toBeNull()
    expect(rows()).toBe(1)
    expect(events).toEqual([])
  })

  it('fails for a task that isn’t there', async () => {
    await expect(
      glade.invoke(CommandName.AgentsSetTab, { taskId: 'gone', agentId: 'toolu_fix_501' }),
    ).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    expect(rows()).toBe(0)
  })

  const bad: readonly [unknown, string][] = [
    [{}, 'taskId'],
    [{ taskId: 'task' }, 'agentId'],
    [{ taskId: 'task', agentId: '' }, 'agentId'],
    [{ taskId: 'task', agentId: 7 }, 'agentId'],
    [{ taskId: 7, agentId: null }, 'taskId'],
    [{ taskId: 'task', agentId: null, pinned: true }, 'Unrecognized key'],
    [null, 'expected object'],
  ]

  it.each(bad)('given %j is a bridge error naming %s, and nothing is written', async (request, names) => {
    // Bypassing the types, as a buggy or compromised window could.
    await expect(glade.invoke(CommandName.AgentsSetTab, request as never)).rejects.toMatchObject({
      name: 'BridgeError',
      code: BridgeErrorCode.InvalidRequest,
      message: expect.stringContaining(names) as unknown,
    })

    expect(rows()).toBe(0)
    // Main is still there: the next command is answered.
    await expect(glade.invoke(CommandName.AgentsSetTab, { taskId: task.id, agentId: null })).resolves.toBeNull()
  })
})
