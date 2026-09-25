// The bridge end to end: the preload's `window.glade` over a fake IPC pair standing in for Electron's, against the real
// main-side registry, handlers and repositories on a temporary database.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createBridge } from '../../preload/bridge'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EventType,
  type GladeBridge,
  type GladeEvent,
} from '../../shared/bridge'
import { TaskState, UiStateKey } from '../../shared/domain'
import { FakeAgentBackend } from '../agent/fake-backend'
import { getTask } from '../db/repositories/tasks'
import { getUiState } from '../db/repositories/ui-state'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { registerBridge } from '.'
import { fakeIpcPair } from './fake-ipc'
import { fakeTerminalOptions } from '../terminal/fake-pty'

let database: TestDatabase
let glade: GladeBridge
let chooseFolder: Mock<() => Promise<string | null>>

beforeEach(() => {
  database = openTestDatabase()
  chooseFolder = vi.fn(() => Promise.resolve('/code/acme-api'))
  const ipc = fakeIpcPair()
  registerBridge({
    ipc: ipc.main,
    db: database.db,
    targets: () => [ipc.window],
    chooseFolder,
    openPath: () => Promise.resolve(''),
    revealPath: () => undefined,
    writeClipboard: () => Promise.resolve(),
    terminal: fakeTerminalOptions(),
    agentBackend: new FakeAgentBackend(),
  })
  glade = createBridge(ipc.renderer)
})

afterEach(() => {
  database.close()
})

describe('the bridge', () => {
  it('sets UI state in the database and delivers the uiState.changed event to the renderer', async () => {
    const events: GladeEvent[] = []
    glade.subscribe((event) => events.push(event))
    const entry = { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' }

    await expect(glade.invoke(CommandName.UiStateSet, entry)).resolves.toBeNull()

    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe('workspace-1')
    expect(events).toEqual([{ type: EventType.UiStateChanged, entry }])
    await expect(glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })).resolves.toEqual({
      value: 'workspace-1',
    })
  })

  it('stops delivering events once unsubscribed', async () => {
    const listener = vi.fn()
    const unsubscribe = glade.subscribe(listener)
    unsubscribe()
    unsubscribe()

    await glade.invoke(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId, value: 'workspace-1' })

    expect(listener).not.toHaveBeenCalled()
  })

  it('gets null for UI state that was never set', async () => {
    await expect(glade.invoke(CommandName.UiStateGet, { key: UiStateKey.ActiveWorkspaceId })).resolves.toEqual({
      value: null,
    })
  })

  it('lists the workspaces', async () => {
    const workspace = sampleWorkspace(database.db)

    await expect(glade.invoke(CommandName.WorkspacesList, {})).resolves.toEqual({ workspaces: [workspace] })
  })

  it("lists a workspace's tasks", async () => {
    const workspace = sampleWorkspace(database.db)
    const task = sampleTask(database.db, workspace.id)

    await expect(glade.invoke(CommandName.TasksList, { workspaceId: workspace.id })).resolves.toEqual({ tasks: [task] })
  })

  it('gets every UI state value', async () => {
    const entry = { key: UiStateKey.SelectedTaskId, value: 'task-1' }
    await glade.invoke(CommandName.UiStateSet, entry)

    await expect(glade.invoke(CommandName.UiStateGetAll, {})).resolves.toEqual({ entries: [entry] })
  })

  it('rejects an invalid request with a typed error, leaving the database alone', async () => {
    const events: GladeEvent[] = []
    glade.subscribe((event) => events.push(event))
    // Bypass the types, as a compromised or buggy renderer could.
    const request = { key: 'no_such_key', value: 1 } as never

    await expect(glade.invoke(CommandName.UiStateSet, request)).rejects.toEqual(
      bridgeError(
        BridgeErrorCode.InvalidRequest,
        'uiState.set: key: Invalid option: expected one of "active_workspace_id"|"selected_task_id"|"pinned_section_collapsed"|"active_section_collapsed"|"done_section_collapsed"|"task_filter"|"relaunch_notice"|"right_panel_tab"|"right_panel_width"|"right_panel_collapsed"|"sidebar_collapsed"|"sidebar_width"|"bottom_bar_collapsed"|"bottom_bar_height"|"terminal_tab"; value: Invalid input: expected string, received number',
      ),
    )
    expect(events).toEqual([])
    expect(database.db.prepare('SELECT COUNT(*) FROM ui_state').pluck().get()).toBe(0)
  })

  it('answers dialog.chooseFolder with the folder the dialog chose', async () => {
    await expect(glade.invoke(CommandName.DialogChooseFolder, {})).resolves.toEqual({ path: '/code/acme-api' })
    expect(chooseFolder).toHaveBeenCalledOnce()
  })

  it('opens a workspace, and refuses an unknown one with a typed error', async () => {
    const workspace = sampleWorkspace(database.db)

    const { workspace: opened } = await glade.invoke(CommandName.WorkspacesOpen, { id: workspace.id })

    expect(opened.lastOpenedAt).toBeGreaterThanOrEqual(workspace.lastOpenedAt)
    expect(getUiState(database.db, UiStateKey.ActiveWorkspaceId)).toBe(workspace.id)
    await expect(glade.invoke(CommandName.WorkspacesOpen, { id: 'gone' })).rejects.toEqual(
      bridgeError(BridgeErrorCode.NotFound, 'workspaces.open: No workspace gone'),
    )
  })

  it('creates a task, marks it done and reopens it, broadcasting task.updated each time', async () => {
    const workspace = sampleWorkspace(database.db)
    const events: GladeEvent[] = []
    glade.subscribe((event) => events.push(event))

    const { task: created } = await glade.invoke(CommandName.TasksCreate, { workspaceId: workspace.id })
    const { task: done } = await glade.invoke(CommandName.TasksMarkDone, { id: created.id })
    const { task: reopened } = await glade.invoke(CommandName.TasksReopen, { id: created.id })
    const { task: renamed } = await glade.invoke(CommandName.TasksUpdate, {
      id: created.id,
      patch: { title: 'Rate limits' },
    })

    expect(created).toMatchObject({ workspaceId: workspace.id, state: TaskState.Active, title: '', doneAt: null })
    expect(done).toMatchObject({ id: created.id, state: TaskState.Done, doneAt: expect.any(Number) as unknown })
    expect(reopened).toEqual({ ...created, updatedAt: reopened.updatedAt })
    expect(renamed.title).toBe('Rate limits')
    expect(getTask(database.db, created.id)).toEqual(renamed)
    expect(events).toEqual([created, done, reopened, renamed].map((task) => ({ type: EventType.TaskUpdated, task })))
  })

  it('rejects an invalid transition or a missing task with a typed error', async () => {
    const task = sampleTask(database.db, sampleWorkspace(database.db).id)

    await expect(glade.invoke(CommandName.TasksReopen, { id: task.id })).rejects.toEqual(
      bridgeError(BridgeErrorCode.InvalidTransition, "tasks.reopen: Can't reopen a task that is active"),
    )
    await expect(glade.invoke(CommandName.TasksMarkDone, { id: 'gone' })).rejects.toEqual(
      bridgeError(BridgeErrorCode.NotFound, 'tasks.markDone: No task gone'),
    )
    expect(getTask(database.db, task.id)).toEqual(task)
  })

  it('rejects an unknown command with a typed error', async () => {
    await expect(glade.invoke('tasks.explode' as CommandName, {})).rejects.toEqual(
      bridgeError(BridgeErrorCode.UnknownCommand, 'Unknown command tasks.explode'),
    )
  })
})
