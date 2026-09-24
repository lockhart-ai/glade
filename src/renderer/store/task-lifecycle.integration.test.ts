// A task's lifecycle end to end: the renderer's store over the preload's bridge and a fake IPC pair, against the real
// main-side dispatcher, handlers, task service and repositories on a database in a temporary folder.
// Runs in the main Vitest project (Node), since it needs better-sqlite3.
import { afterEach, beforeEach, expect, it } from 'vitest'
import { registerBridge } from '../../main/bridge'
import { fakeIpcPair } from '../../main/bridge/fake-ipc'
import { getTask } from '../../main/db/repositories/tasks'
import { openTestDatabase, sampleWorkspace, type TestDatabase } from '../../main/db/repositories/test-database'
import { createBridge } from '../../preload/bridge'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { TaskState, type Workspace } from '../../shared/domain'
import { selectSelectedTask } from './state'
import { createGladeStore, type GladeStore } from './store'

let database: TestDatabase
let workspace: Workspace
let store: GladeStore
let events: GladeEvent[]

beforeEach(async () => {
  database = openTestDatabase()
  workspace = sampleWorkspace(database.db)
  const ipc = fakeIpcPair()
  registerBridge({ ipc: ipc.main, db: database.db, targets: () => [ipc.window] })
  const bridge = createBridge(ipc.renderer)
  events = []
  bridge.subscribe((event) => events.push(event))
  store = createGladeStore(bridge)
  await store.getState().hydrate()
})

afterEach(() => {
  database.close()
})

function taskEvents(): GladeEvent[] {
  return events.filter((event) => event.type === EventType.TaskUpdated)
}

it('creates, marks done and reopens a task through the bridge, the store following each event', async () => {
  const created = await store.getState().createTask(workspace.id)
  expect(selectSelectedTask(store.getState())).toEqual(created)
  expect(store.getState().selectedWorkspaceId).toBe(workspace.id)
  expect(getTask(database.db, created.id)).toEqual(created)

  await store.getState().markTaskDone(created.id)
  const done = getTask(database.db, created.id)
  expect(done).toMatchObject({ state: TaskState.Done, doneAt: expect.any(Number) as unknown })
  expect(store.getState().tasks[created.id]).toEqual(done)

  await store.getState().reopenTask(created.id)
  const reopened = getTask(database.db, created.id)
  expect(reopened).toEqual({ ...created, updatedAt: reopened?.updatedAt })
  expect(store.getState().tasks[created.id]).toEqual(reopened)

  await store.getState().updateTask(created.id, { pinned: true })
  const pinned = getTask(database.db, created.id)
  expect(pinned?.pinned).toBe(true)
  expect(store.getState().tasks[created.id]).toEqual(pinned)

  expect(taskEvents()).toEqual([created, done, reopened, pinned].map((task) => ({ type: EventType.TaskUpdated, task })))
})

it("rejects with main's typed error when the transition isn't allowed, leaving the store alone", async () => {
  const created = await store.getState().createTask(workspace.id)

  await expect(store.getState().reopenTask(created.id)).rejects.toMatchObject({ code: 'invalid_transition' })

  expect(store.getState().tasks[created.id]).toEqual(created)
  expect(taskEvents()).toHaveLength(1)
})
