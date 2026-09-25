// A change through a control tool is the change the window's command makes: two apps start from the same rows at the
// same (frozen) time, one makes a change through the tool and the other through the bridge command, and both end with
// identical rows and told their windows the same events (ids aside, which are random: they're compared by where they
// first appear).
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { CommandName, type GladeEvent } from '../../shared/bridge'
import { Effort, MessageRole, PermissionMode } from '../../shared/domain'
import { settle } from '../agent/fake-backend'
import * as sdk from '../agent/test-sdk-messages'
import { appendMessage } from '../db/repositories/messages'
import { createTask } from '../db/repositories/tasks'
import { createWorkspace } from '../db/repositories/workspaces'
import { ControlToolName } from './names'
import { connect, HTTP, startControlApp, type ControlApp, type ControlClient } from './test-control'

/** One of the two apps: what it was seeded with, and a client on its control tools. */
interface Side {
  readonly app: ControlApp
  readonly client: ControlClient
  readonly workspaceId: string
  readonly taskId: string
}

const NOW = 1_700_000_000_000

let viaTool: Side
let viaBridge: Side

/** The same rows in each app, written at the same times. */
async function side(): Promise<Side> {
  const app = startControlApp()
  const { db } = app.database
  const workspace = createWorkspace(db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  const task = createTask(db, { workspaceId: workspace.id, model: 'claude-sonnet-5', effort: Effort.Medium }, 2_000)
  appendMessage(db, { taskId: task.id, role: MessageRole.User, body: 'Earlier.', turn: 1 }, 3_000)
  const client = await connect(app.bridge.control.server(HTTP))
  return { app, client, workspaceId: workspace.id, taskId: task.id }
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  viaTool = await side()
  viaBridge = await side()
})

afterEach(async () => {
  for (const { app, client } of [viaTool, viaBridge]) {
    await client.close()
    await app.close()
  }
  vi.useRealTimers()
})

/** Every row of every table (but the full-text index's own), in the order written. */
function rows(db: Database): Record<string, unknown[]> {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'search_fts%' ORDER BY name",
    )
    .pluck()
    .all()
    .filter((name): name is string => typeof name === 'string')
  return Object.fromEntries(tables.map((table) => [table, db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all()]))
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** JSON with each id replaced by the order it first appears in. */
function normalized(value: unknown): unknown {
  const ids = new Map<string, string>()
  const text = JSON.stringify(value).replace(UUID, (id) => {
    const known = ids.get(id) ?? `<id ${String(ids.size)}>`
    ids.set(id, known)
    return known
  })
  return JSON.parse(text)
}

/** What a side ended with: its rows, and the events since `from`. */
function outcome({ app }: Side, from: number): unknown {
  const events: GladeEvent[] = app.events.slice(from)
  return normalized({ rows: rows(app.database.db), events })
}

/** Makes a change on both sides, through the tool on one and the bridge on the other, and compares what they left. */
async function expectSame(
  tool: (side: Side) => Promise<unknown>,
  bridge: (side: Side) => Promise<unknown>,
): Promise<void> {
  const toolFrom = viaTool.app.events.length
  const bridgeFrom = viaBridge.app.events.length
  vi.setSystemTime(NOW + 5_000)
  await tool(viaTool)
  vi.setSystemTime(NOW + 5_000)
  await bridge(viaBridge)
  await settle()
  const expected = outcome(viaBridge, bridgeFrom)
  expect(outcome(viaTool, toolFrom)).toEqual(expected)
  // Something happened: the comparison isn't of two empty changes.
  expect(viaBridge.app.events.length).toBeGreaterThan(bridgeFrom)
}

/** Does the same on both sides, through the bridge: the state the change starts from. */
async function both(step: (side: Side) => Promise<unknown>): Promise<void> {
  vi.setSystemTime(NOW + 1_000)
  await step(viaTool)
  vi.setSystemTime(NOW + 1_000)
  await step(viaBridge)
  await settle()
}

it('create_task is New task', async () => {
  await expectSame(
    ({ client, workspaceId }) => client.call(ControlToolName.CreateTask, { workspaceId }),
    ({ app, workspaceId }) => app.glade.invoke(CommandName.TasksCreate, { workspaceId }),
  )
})

it('create_task with a first message is New task, then sending it', async () => {
  await expectSame(
    ({ client, workspaceId }) => client.call(ControlToolName.CreateTask, { workspaceId, message: 'Start.' }),
    async ({ app, workspaceId }) => {
      const { task } = await app.glade.invoke(CommandName.TasksCreate, { workspaceId })
      return app.glade.invoke(CommandName.TasksSend, { id: task.id, text: 'Start.' })
    },
  )
})

it("update_task is the header's and pickers' changes", async () => {
  const patch = { title: 'Renamed', pinned: true, unread: true, model: 'claude-haiku-4-5', effort: Effort.Low }
  await expectSame(
    ({ client, taskId }) =>
      client.call(ControlToolName.UpdateTask, {
        id: taskId,
        patch: { ...patch, permissionMode: PermissionMode.AskBeforeEdits },
      }),
    ({ app, taskId }) =>
      app.glade.invoke(CommandName.TasksUpdate, {
        id: taskId,
        patch: { ...patch, permissionMode: PermissionMode.AskBeforeEdits },
      }),
  )
})

it('send_message to an idle task is sending from the input bar', async () => {
  await expectSame(
    ({ client, taskId }) => client.call(ControlToolName.SendMessage, { id: taskId, text: 'Carry on.' }),
    ({ app, taskId }) => app.glade.invoke(CommandName.TasksSend, { id: taskId, text: 'Carry on.' }),
  )
})

it('send_message to a working task is queueing from the input bar', async () => {
  await both(({ app, taskId }) => app.glade.invoke(CommandName.TasksSend, { id: taskId, text: 'Carry on.' }))

  await expectSame(
    ({ client, taskId }) => client.call(ControlToolName.SendMessage, { id: taskId, text: 'And this.' }),
    ({ app, taskId }) => app.glade.invoke(CommandName.QueueAdd, { taskId, text: 'And this.' }),
  )
})

it('stop_task is the Stop button', async () => {
  await both(async ({ app, taskId }) => {
    await app.glade.invoke(CommandName.TasksSend, { id: taskId, text: 'Carry on.' })
    const session = app.backend.session
    session.onInterrupt = () => {
      session.emit(sdk.interruptMarker(), sdk.abortedResult())
      return Promise.resolve()
    }
    session.emit(sdk.init(), sdk.text('Working on it.'))
  })

  await expectSame(
    ({ client, taskId }) => client.call(ControlToolName.StopTask, { id: taskId }),
    ({ app, taskId }) => app.glade.invoke(CommandName.TasksStop, { id: taskId }),
  )
})

it('mark_done is Mark done', async () => {
  await expectSame(
    ({ client, taskId }) => client.call(ControlToolName.MarkDone, { id: taskId }),
    ({ app, taskId }) => app.glade.invoke(CommandName.TasksMarkDone, { id: taskId }),
  )
})

it('reopen_task is Reopen', async () => {
  await both(({ app, taskId }) => app.glade.invoke(CommandName.TasksMarkDone, { id: taskId }))

  await expectSame(
    ({ client, taskId }) => client.call(ControlToolName.ReopenTask, { id: taskId }),
    ({ app, taskId }) => app.glade.invoke(CommandName.TasksReopen, { id: taskId }),
  )
})

it('delete_task is Delete task…', async () => {
  await expectSame(
    ({ client, taskId }) => client.call(ControlToolName.DeleteTask, { id: taskId, confirm: true }),
    ({ app, taskId }) => app.glade.invoke(CommandName.TasksDelete, { id: taskId }),
  )
})
