// "Restarting the app restores the selected workspace and task": the renderer's store over the preload's bridge and a
// fake IPC pair, against the real main-side dispatcher, handlers and repositories on a database in a temporary folder.
// The app is "restarted" by closing the database and hydrating a fresh store against it reopened.
// Runs in the main Vitest project (Node), since it needs better-sqlite3.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { FakeAgentBackend, settle } from '../../main/agent/fake-backend'
import * as sdk from '../../main/agent/test-sdk-messages'
import { registerBridge } from '../../main/bridge'
import { fakeIpcPair } from '../../main/bridge/fake-ipc'
import { openAppDatabase, type AppDatabase } from '../../main/db/database'
import { sampleTask, sampleWorkspace } from '../../main/db/repositories/test-database'
import { createWorkspace, getWorkspace } from '../../main/db/repositories/workspaces'
import { STARTER_CLAUDE_MD } from '../../main/workspaces/starter-claude-md'
import { createBridge } from '../../preload/bridge'
import { bridgeError, BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import { needsYou, parseTaskFilter, TaskFilter } from '../../shared/attention'
import { DividerKind, ToolCallState, UiStateKey, type Task, type Workspace } from '../../shared/domain'
import {
  appendDivider,
  appendNarration,
  appendToolCall,
  listToolEvents,
  updateToolCall,
} from '../../main/db/repositories/tool-events'
import { HydrationStatus } from './state'
import { createGladeStore, type GladeStore } from './store'

let dir: string
let open: AppDatabase[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-restore-'))
  // The database lives apart from the workspace roots made in `dir`.
  mkdirSync(join(dir, 'data'))
  open = []
})

afterEach(() => {
  for (const database of open) database.db.close()
  rmSync(dir, { recursive: true, force: true })
})

/** Starts the app: opens the database in `dir`, wires main's bridge to it and hydrates a fresh store. */
async function launch(): Promise<{
  database: AppDatabase
  glade: GladeBridge
  store: GladeStore
  backend: FakeAgentBackend
}> {
  const database = openAppDatabase(join(dir, 'data'))
  open.push(database)
  const ipc = fakeIpcPair()
  const backend = new FakeAgentBackend()
  registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder: () => Promise.resolve(null),
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    agentBackend: backend,
  })
  const glade = createBridge(ipc.renderer)
  const store = createGladeStore(glade)
  await store.getState().hydrate()
  return { database, glade, store, backend }
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
  // Nothing selected yet, so the most recently opened workspace is shown.
  expect(second.store.getState()).toMatchObject({ selectedWorkspaceId: workspaces[1]?.id, selectedTaskId: null })
  await second.store.getState().openWorkspace(workspaces[0]?.id ?? '')
  await second.store.getState().selectTask(tasks[1]?.id ?? null)
  quit(second.database)

  const third = await launch()
  const restored = third.store.getState()
  expect(restored.hydration).toEqual({ status: HydrationStatus.Ready })
  expect(restored.workspaces.map(({ id }) => id)).toEqual(workspaces.map(({ id }) => id))
  expect(Object.values(restored.tasks)).toEqual(tasks)
  expect(restored.selectedWorkspaceId).toBe(workspaces[1]?.id)
  expect(restored.selectedTaskId).toBe(tasks[1]?.id)
})

it("restores each workspace's own selection when switching, across a restart", async () => {
  const first = await launch()
  const api = createWorkspace(first.database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  const web = createWorkspace(first.database.db, { name: 'Acme Web', rootPath: '/code/acme-web' }, 2_000)
  const inApi = sampleTask(first.database.db, api.id)
  const inWeb = sampleTask(first.database.db, web.id)
  quit(first.database)

  const second = await launch()
  await second.store.getState().openWorkspace(api.id)
  await second.store.getState().selectTask(inApi.id)
  await second.store.getState().openWorkspace(web.id)
  expect(second.store.getState().selectedTaskId).toBeNull()
  await second.store.getState().selectTask(inWeb.id)
  await second.store.getState().openWorkspace(api.id)
  expect(second.store.getState()).toMatchObject({ selectedWorkspaceId: api.id, selectedTaskId: inApi.id })
  quit(second.database)

  const third = await launch()
  expect(third.store.getState()).toMatchObject({ selectedWorkspaceId: api.id, selectedTaskId: inApi.id })
  await third.store.getState().openWorkspace(web.id)
  expect(third.store.getState()).toMatchObject({ selectedWorkspaceId: web.id, selectedTaskId: inWeb.id })
  expect(third.store.getState().messages[inWeb.id]).toEqual([])
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

it("restores the selected task's tool log after a restart", async () => {
  const first = await launch()
  const { db } = first.database
  const workspace = sampleWorkspace(db)
  const task = sampleTask(db, workspace.id)
  appendDivider(db, { taskId: task.id, turn: 1, dividerKind: DividerKind.Turn })
  appendNarration(db, { taskId: task.id, turn: 1, text: 'Looking around.' })
  appendToolCall(db, {
    taskId: task.id,
    turn: 1,
    name: 'Read',
    input: { file_path: 'a.py' },
    toolUseId: 'use-1',
    parentToolUseId: null,
  })
  updateToolCall(db, { taskId: task.id, toolUseId: 'use-1', state: ToolCallState.Done, output: '1\ta' })
  const events = listToolEvents(db, task.id)
  await first.store.getState().selectTask(task.id)
  quit(first.database)

  const second = await launch()
  expect(second.store.getState().selectedTaskId).toBe(task.id)
  expect(second.store.getState().toolEvents[task.id]).toEqual(events)
  expect(events).toHaveLength(3)
})

/** Makes a folder to be a workspace root. */
function folder(name: string): string {
  const path = join(dir, name)
  mkdirSync(path)
  return path
}

it('creates a workspace in a folder: a database row, the starter CLAUDE.md, and the event in the store', async () => {
  const { database, glade, store } = await launch()
  const root = folder('acme-api')

  const { workspace, created } = await glade.invoke(CommandName.WorkspacesCreate, { rootPath: root })

  expect(created).toBe(true)
  expect(workspace).toMatchObject({ name: 'acme-api', rootPath: root })
  expect(getWorkspace(database.db, workspace.id)).toEqual(workspace)
  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe(STARTER_CLAUDE_MD)
  expect(readdirSync(root)).toEqual(['CLAUDE.md'])
  // Only the workspace.updated event could have put it in the store.
  expect(store.getState().workspaces).toEqual([workspace])
})

it('never touches a CLAUDE.md the root already has', async () => {
  const { store } = await launch()
  const root = folder('acme-api')
  writeFileSync(join(root, 'CLAUDE.md'), '# Mine\n')

  await store.getState().createWorkspace(root)

  expect(readFileSync(join(root, 'CLAUDE.md'), 'utf8')).toBe('# Mine\n')
})

it('refuses a root that is not a folder with a typed error', async () => {
  const { glade } = await launch()
  const path = join(dir, 'missing')

  await expect(glade.invoke(CommandName.WorkspacesCreate, { rootPath: path })).rejects.toEqual(
    bridgeError(BridgeErrorCode.InvalidRootPath, `workspaces.create: ${path} is not a folder`),
  )
  await expect(glade.invoke(CommandName.WorkspacesCreate, { rootPath: 'acme-api' })).rejects.toMatchObject({
    code: BridgeErrorCode.InvalidRequest,
  })
})

it('reopens the last opened workspace after a restart', async () => {
  const first = await launch()
  const api = await first.store.getState().createWorkspace(folder('acme-api'))
  const web = await first.store.getState().createWorkspace(folder('acme-web'))
  expect(first.store.getState().selectedWorkspaceId).toBe(web.id)
  await first.store.getState().openWorkspace(api.id)
  quit(first.database)

  const second = await launch()
  expect(second.store.getState().selectedWorkspaceId).toBe(api.id)
  expect(second.store.getState().workspaces.find(({ id }) => id === api.id)?.lastOpenedAt).toBeGreaterThanOrEqual(
    web.lastOpenedAt,
  )

  // With the stored selection gone, the most recently opened workspace is shown.
  second.database.db.prepare('DELETE FROM ui_state').run()
  quit(second.database)
  const third = await launch()
  expect(third.store.getState().selectedWorkspaceId).toBe(api.id)
})

it('starts with no workspace when there are none: the first-run state', async () => {
  const { store } = await launch()

  expect(store.getState()).toMatchObject({ workspaces: [], selectedWorkspaceId: null })
})

it('keeps unread tasks, the Needs you tasks and the chosen filter across a restart', async () => {
  const first = await launch()
  const workspace = createWorkspace(first.database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  const asked = sampleTask(first.database.db, workspace.id)
  const other = sampleTask(first.database.db, workspace.id)
  quit(first.database)

  const second = await launch()
  const { getState } = second.store
  await getState().selectTask(asked.id)
  await getState().sendMessage(asked.id, 'Why is the login test flaky?')
  // You move to the other task before the agent replies.
  await getState().selectTask(other.id)
  second.backend.session.emit(sdk.init(), sdk.text('It is a race.'), sdk.result('It is a race.'))
  await settle()
  await getState().setUiState({ key: UiStateKey.TaskFilter, value: TaskFilter.Unread })

  const attention = (store: GladeStore): unknown => {
    const tasks = Object.values(store.getState().tasks)
    return {
      unread: tasks.filter(({ unread }) => unread).map(({ id }) => id),
      needsYou: tasks.filter(needsYou).map(({ id }) => id),
      filter: parseTaskFilter(store.getState().uiState[UiStateKey.TaskFilter]),
    }
  }
  const expected = { unread: [asked.id], needsYou: [asked.id], filter: TaskFilter.Unread }
  expect(attention(second.store)).toEqual(expected)
  quit(second.database)

  const third = await launch()
  expect(attention(third.store)).toEqual(expected)

  // Opening it marks it read, for good.
  await third.store.getState().selectTask(asked.id)
  expect(third.store.getState().tasks[asked.id]?.unread).toBe(false)
  quit(third.database)
  const fourth = await launch()
  expect(attention(fourth.store)).toEqual({ ...expected, unread: [] })
})
