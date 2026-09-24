// "Restarting the app restores the selected workspace and task": the renderer's store over the preload's bridge and a
// fake IPC pair, against the real main-side dispatcher, handlers and repositories on a database in a temporary folder.
// The app is "restarted" by closing the database and hydrating a fresh store against it reopened.
// Runs in the main Vitest project (Node), since it needs better-sqlite3.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FakeAgentBackend } from '../../main/agent/fake-backend'
import { registerBridge } from '../../main/bridge'
import { fakeIpcPair } from '../../main/bridge/fake-ipc'
import { openAppDatabase, type AppDatabase } from '../../main/db/database'
import { sampleTask, sampleWorkspace } from '../../main/db/repositories/test-database'
import { createWorkspace } from '../../main/db/repositories/workspaces'
import { createBridge } from '../../preload/bridge'
import type { Task, Workspace } from '../../shared/domain'
import { HydrationStatus } from './state'
import { createGladeStore, type GladeStore } from './store'

let dir: string
let open: AppDatabase[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-restore-'))
  open = []
})

afterEach(() => {
  for (const database of open) database.db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Starts the app: opens the database in `dir`, wires main's bridge to it and hydrates a fresh store. */
async function launch(): Promise<{ database: AppDatabase; store: GladeStore }> {
  const database = openAppDatabase(dir)
  open.push(database)
  const ipc = fakeIpcPair()
  registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    agentBackend: new FakeAgentBackend(),
  })
  const store = createGladeStore(createBridge(ipc.renderer))
  await store.getState().hydrate()
  return { database, store }
}

function quit(database: AppDatabase): void {
  database.db.close()
  open = open.filter((other) => other !== database)
}

it('restores the selected workspace and task after a restart', async () => {
  const first = await launch()
  const workspaces: Workspace[] = [
    createWorkspace(first.database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000),
    createWorkspace(first.database.db, { name: 'Acme Web', rootPath: '/code/acme-web' }, 2_000),
  ]
  const tasks: Task[] = workspaces.map((workspace) => sampleTask(first.database.db, workspace.id))
  quit(first.database)

  const second = await launch()
  expect(second.store.getState()).toMatchObject({ selectedWorkspaceId: null, selectedTaskId: null })
  await second.store.getState().selectWorkspace(workspaces[0]?.id ?? null)
  await second.store.getState().selectTask(tasks[1]?.id ?? null)
  quit(second.database)

  const third = await launch()
  const restored = third.store.getState()
  expect(restored.hydration).toEqual({ status: HydrationStatus.Ready })
  expect(restored.workspaces).toEqual(workspaces)
  expect(Object.values(restored.tasks)).toEqual(tasks)
  expect(restored.selectedWorkspaceId).toBe(workspaces[1]?.id)
  expect(restored.selectedTaskId).toBe(tasks[1]?.id)
})

it('restores a cleared task selection as none', async () => {
  const first = await launch()
  const workspace = sampleWorkspace(first.database.db)
  const task = sampleTask(first.database.db, workspace.id)
  quit(first.database)

  const second = await launch()
  await second.store.getState().selectTask(task.id)
  await second.store.getState().selectTask(null)
  quit(second.database)

  const third = await launch()
  expect(third.store.getState()).toMatchObject({ selectedWorkspaceId: workspace.id, selectedTaskId: null })
})
