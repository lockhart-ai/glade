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
import { updateTask } from '../../main/db/repositories/tasks'
import { sampleTask, sampleWorkspace } from '../../main/db/repositories/test-database'
import { setUiState } from '../../main/db/repositories/ui-state'
import { createWorkspace, getWorkspace } from '../../main/db/repositories/workspaces'
import { STARTER_CLAUDE_MD } from '../../main/workspaces/starter-claude-md'
import { createBridge } from '../../preload/bridge'
import { bridgeError, BridgeErrorCode, CommandName, type GladeBridge } from '../../shared/bridge'
import { needsYou, TaskAttention, taskAttention } from '../../shared/attention'
import {
  DividerKind,
  QuestionKind,
  TaskActivity,
  TaskState,
  ToolCallState,
  UiStateKey,
  type Task,
  type Workspace,
} from '../../shared/domain'
import { appendPermissionRequest } from '../../main/db/repositories/permission-requests'
import { appendQuestionSet } from '../../main/db/repositories/question-sets'
import {
  appendDivider,
  appendNarration,
  appendToolCall,
  listToolEvents,
  updateToolCall,
} from '../../main/db/repositories/tool-events'
import { listedTaskIds, listSections, nextNeedingYou } from '../task-list/sections'
import { HydrationStatus } from './state'
import { createGladeStore, type GladeStore } from './store'
import { fakeTerminalOptions } from '../../main/terminal/fake-pty'
import { UNREAD_PLUGINS_FOLDER } from '../../main/plugins/test-plugins'

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

/**
 * Starts the app: opens the database in `dir`, wires main's bridge to it and hydrates a fresh store. `resume` carries on
 * what the app last quit in first, as the app does at launch (`resumeInterrupted`): the sessions it quit in are gone,
 * and their background subagents and watchers with them.
 */
async function launch({ resume = false }: { resume?: boolean } = {}): Promise<{
  database: AppDatabase
  glade: GladeBridge
  store: GladeStore
  backend: FakeAgentBackend
}> {
  const database = openAppDatabase(join(dir, 'data'))
  open.push(database)
  const ipc = fakeIpcPair()
  const backend = new FakeAgentBackend()
  const { runner } = registerBridge({
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
  })
  if (resume) runner.resumeInterrupted()
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

it('keeps unread tasks and the Needs you tasks across a restart', async () => {
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

  const attention = (store: GladeStore): unknown => {
    const tasks = Object.values(store.getState().tasks)
    return {
      unread: tasks.filter(({ unread }) => unread).map(({ id }) => id),
      needsYou: tasks.filter(needsYou).map(({ id }) => id),
    }
  }
  const expected = { unread: [asked.id], needsYou: [asked.id] }
  expect(attention(second.store)).toEqual(expected)
  quit(second.database)

  const third = await launch()
  expect(attention(third.store)).toEqual(expected)

  // Opening it marks it read, for good.
  await third.store.getState().selectTask(asked.id)
  expect(third.store.getState().tasks[asked.id]?.unread).toBe(false)
  quit(third.database)
  // Read, with nothing running, it no longer needs you (#430), after a relaunch too.
  expect(attention(third.store)).toEqual({ unread: [], needsYou: [] })
  quit(third.database)
  const fourth = await launch()
  expect(attention(fourth.store)).toEqual({ unread: [], needsYou: [] })

  // Mark as unread makes it need you again, and that's kept.
  await fourth.store.getState().markUnread(asked.id)
  expect(attention(fourth.store)).toEqual(expected)
  quit(fourth.database)
  const fifth = await launch()
  expect(attention(fifth.store)).toEqual(expected)
})

it('reads where each task stands with you the same after a relaunch: reply, question, permission and error (#430)', async () => {
  const first = await launch()
  const { db } = first.database
  const workspace = createWorkspace(db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  const ran = (patch: Parameters<typeof updateTask>[2] = {}): string => {
    const task = sampleTask(db, workspace.id)
    updateTask(db, task.id, { sessionId: `session-${task.id}`, ...patch })
    return task.id
  }
  const read = ran()
  const unread = ran({ unread: true })
  const asking = ran()
  appendQuestionSet(db, {
    taskId: asking,
    turn: 1,
    questions: [{ kind: QuestionKind.Pills, prompt: 'Which limit?', options: ['60', '120'] }],
  })
  const permission = ran()
  appendPermissionRequest(db, {
    taskId: permission,
    turn: 1,
    toolUseId: 'bash-1',
    agentId: null,
    toolName: 'Bash',
    input: { command: 'npm test' },
    title: null,
    displayName: 'Bash',
    description: null,
    suggestions: [],
    defaultToNo: false,
    suppressAlwaysAllowRule: false,
  })
  const failed = ran({ activity: TaskActivity.Error })
  const fresh = sampleTask(db, workspace.id).id
  quit(first.database)

  const standing = (store: GladeStore): Record<string, TaskAttention | undefined> => {
    const { tasks } = store.getState()
    const of = (id: string): TaskAttention | undefined => {
      const task = tasks[id]
      return task === undefined ? undefined : taskAttention(task)
    }
    return {
      read: of(read),
      unread: of(unread),
      asking: of(asking),
      permission: of(permission),
      failed: of(failed),
      fresh: of(fresh),
    }
  }
  const expected = {
    read: TaskAttention.Idle,
    unread: TaskAttention.NeedsYou,
    asking: TaskAttention.NeedsYou,
    permission: TaskAttention.NeedsYou,
    failed: TaskAttention.NeedsYou,
    fresh: TaskAttention.Idle,
  }

  const second = await launch({ resume: true })
  expect(standing(second.store)).toEqual(expected)
  quit(second.database)
  const third = await launch({ resume: true })
  expect(standing(third.store)).toEqual(expected)
})

it('counts a task as working while its background subagent runs, and by its reply once that ends or the app relaunches (#430)', async () => {
  const first = await launch()
  const workspace = createWorkspace(first.database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  const viewed = sampleTask(first.database.db, workspace.id)
  const away = sampleTask(first.database.db, workspace.id)
  const other = sampleTask(first.database.db, workspace.id)
  quit(first.database)

  const second = await launch()
  const { getState } = second.store
  const standing = (store: GladeStore, id: string): unknown => {
    const task = store.getState().tasks[id]
    return task === undefined ? undefined : [taskAttention(task), task.unread, task.backgroundWork]
  }
  /** The agent starts a subagent in the background, replies, and ends its turn. */
  const startInBackground = async (id: string, toolUseId: string, sdkTaskId: string): Promise<void> => {
    await getState().selectTask(id)
    await getState().sendMessage(id, 'Find why checkout is slow.')
    second.backend.sessions
      .at(-1)
      ?.emit(
        sdk.init(),
        ...sdk.backgroundLaunch(toolUseId, sdkTaskId, 'Profile the checkout queries'),
        sdk.text('I started it in the background.', null, `msg_${toolUseId}`),
        sdk.result('I started it in the background.'),
      )
    await settle()
  }

  // One reply you see arrive; the other lands while you're in another task.
  await startInBackground(viewed.id, 'toolu_v', 'av1')
  await getState().selectTask(away.id)
  await getState().sendMessage(away.id, 'Find why checkout is slow.')
  await getState().selectTask(other.id)
  second.backend.sessions.at(-1)?.emit(
    // Each task's session has its own id.
    sdk.init('7c1d2e3f-0000-4000-8000-00000000a4a7'),
    ...sdk.backgroundLaunch('toolu_w', 'aw1', 'Profile the checkout queries'),
    sdk.text('I started it in the background.', null, 'msg_w'),
    sdk.result('I started it in the background.'),
  )
  await settle()

  // Both are working, whether the reply was read: neither needs you while its subagent runs.
  expect(standing(second.store, viewed.id)).toEqual([TaskAttention.Working, false, true])
  expect(standing(second.store, away.id)).toEqual([TaskAttention.Working, true, true])
  expect(Object.values(getState().tasks).filter(needsYou)).toEqual([])

  // The app quits with both still running: they died with their sessions, so after the relaunch the read reply is
  // idle and the unread one needs you.
  quit(second.database)
  const third = await launch({ resume: true })
  expect(standing(third.store, viewed.id)).toEqual([TaskAttention.Idle, false, false])
  expect(standing(third.store, away.id)).toEqual([TaskAttention.NeedsYou, true, false])
  expect(
    Object.values(third.store.getState().tasks)
      .filter(needsYou)
      .map(({ id }) => id),
  ).toEqual([away.id])
  expect(listToolEvents(third.database.db, away.id)).toEqual([
    expect.objectContaining({ kind: 'divider' }),
    expect.objectContaining({ name: 'Agent', state: ToolCallState.Interrupted }),
  ])
})

it('tells the window when a background subagent ends, so the task stops counting as working (#430)', async () => {
  const first = await launch()
  const workspace = createWorkspace(first.database.db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
  const task = sampleTask(first.database.db, workspace.id)
  const other = sampleTask(first.database.db, workspace.id)
  const { getState } = first.store
  await getState().openWorkspace(workspace.id)
  await getState().selectTask(task.id)
  await getState().sendMessage(task.id, 'Find why checkout is slow.')
  await getState().selectTask(other.id)
  first.backend.session.emit(
    sdk.init(),
    ...sdk.backgroundLaunch('toolu_q', 'aq1', 'Profile the checkout queries'),
    sdk.text('I started it in the background.', null, 'msg_q'),
    sdk.result('I started it in the background.'),
  )
  await settle()
  const attention = (): TaskAttention | undefined => {
    const current = getState().tasks[task.id]
    return current === undefined ? undefined : taskAttention(current)
  }
  expect(attention()).toBe(TaskAttention.Working)
  // Next task that needs you has nowhere to go.
  expect(nextNeedingYou(listSections(getState(), workspace.id), other.id)).toBeNull()

  // The subagent ends without waking the agent's turn: nothing writes the task, yet the window hears it needs you.
  first.backend.session.emit(...sdk.subagentEnded('toolu_q', 'aq1', 'completed', 'An N+1 in load_cart.'))
  await settle()
  expect(attention()).toBe(TaskAttention.NeedsYou)
  expect(nextNeedingYou(listSections(getState(), workspace.id), other.id)).toBe(task.id)

  // Opening it reads it.
  await getState().selectTask(task.id)
  expect(attention()).toBe(TaskAttention.Idle)
})

// The sidebar's All · Needs you · Unread chips are gone (#411). A database from before still has the filter they
// stored, in the `ui_state` row `task_filter`: the row stays (no destructive migration) and nothing reads it.
it.each(['unread', 'needs_you', 'all', 'starred', ''])(
  'lists every task after an upgrade from a version that stored the task filter %j',
  async (stored) => {
    const first = await launch()
    const { db } = first.database
    const workspace = createWorkspace(db, { name: 'Acme API', rootPath: '/code/acme-api' }, 1_000)
    const unread = updateTask(db, sampleTask(db, workspace.id).id, { unread: true })
    const read = sampleTask(db, workspace.id)
    const pinned = updateTask(db, sampleTask(db, workspace.id).id, { pinned: true })
    const done = updateTask(db, sampleTask(db, workspace.id).id, { state: TaskState.Done })
    const doneUnread = updateTask(db, sampleTask(db, workspace.id).id, { state: TaskState.Done, unread: true })
    setUiState(db, { key: UiStateKey.ActiveWorkspaceId, value: workspace.id })
    setUiState(db, { key: UiStateKey.DoneSectionCollapsed, value: 'false' })
    db.prepare("INSERT INTO ui_state (key, value) VALUES ('task_filter', ?)").run(stored)
    quit(first.database)

    const second = await launch()
    const state = second.store.getState()

    expect(state.hydration).toEqual({ status: HydrationStatus.Ready })
    expect(Object.keys(state.uiState)).not.toContain('task_filter')
    expect([...listedTaskIds(state, workspace.id)].sort()).toEqual(
      [unread.id, read.id, pinned.id, done.id, doneUnread.id].sort(),
    )
    expect(state.doneCounts[workspace.id]).toEqual({ all: 2 })
    // The old row is left as it was, for a downgrade to find.
    expect(second.database.db.prepare("SELECT value FROM ui_state WHERE key = 'task_filter'").pluck().get()).toBe(
      stored,
    )
    quit(second.database)
  },
)
