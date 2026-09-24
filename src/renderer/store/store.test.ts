import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { Effort, TaskState, UiStateKey } from '../../shared/domain'
import { HydrationStatus, selectSelectedTask, selectSelectedWorkspace } from './state'
import { createGladeStore } from './store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeMain } from './test-bridge'

function main(uiState: FakeMain['uiState'] = []): FakeMain {
  return {
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w2')],
    uiState,
  }
}

async function hydrated(data = main()) {
  const fake = fakeBridge(data)
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  return { ...fake, store, data }
}

describe('hydrate', () => {
  it('starts loading, then holds the snapshot from main', async () => {
    const { bridge } = fakeBridge(main([{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }]))
    const store = createGladeStore(bridge)
    expect(store.getState().hydration).toEqual({ status: HydrationStatus.Loading })

    await store.getState().hydrate()

    const state = store.getState()
    expect(state.hydration).toEqual({ status: HydrationStatus.Ready })
    expect(state.workspaces.map(({ id }) => id)).toEqual(['w1', 'w2'])
    expect(Object.keys(state.tasks)).toEqual(['t1', 't2'])
    expect(state.selectedWorkspaceId).toBe('w1')
    expect(state.messages).toEqual({})
    expect(state.toolEvents).toEqual({})
  })

  it('applies events from main once loaded', async () => {
    const { store, emit } = await hydrated()
    const task = { ...sampleTask('t1', 'w1'), title: 'Add caching' }

    emit({ type: EventType.TaskUpdated, task })

    expect(store.getState().tasks.t1).toEqual(task)
  })

  it('applies events that arrive while loading on top of the snapshot', async () => {
    const renamed = { ...sampleTask('t1', 'w1'), title: 'Add caching' }
    let emitDuringLoad = (): void => undefined
    const fake = fakeBridge(main(), {
      [CommandName.WorkspacesList]: () => {
        emitDuringLoad()
        return { workspaces: [sampleWorkspace('w1')] }
      },
    })
    emitDuringLoad = () => {
      fake.emit({ type: EventType.TaskUpdated, task: renamed })
    }
    const store = createGladeStore(fake.bridge)

    await store.getState().hydrate()

    expect(store.getState().tasks.t1).toEqual(renamed)
  })

  it('subscribes once however often it reloads', async () => {
    const { store, listenerCount } = await hydrated()

    await store.getState().hydrate()

    expect(listenerCount()).toBe(1)
  })

  it('says why when main refuses a command, and never rejects', async () => {
    const { bridge } = fakeBridge(main(), {
      [CommandName.UiStateGetAll]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk full')),
    })
    const store = createGladeStore(bridge)

    await expect(store.getState().hydrate()).resolves.toBeUndefined()

    expect(store.getState().hydration).toEqual({ status: HydrationStatus.Failed, message: 'disk full' })
  })
})

describe('createWorkspace', () => {
  it("adds the workspace and opens it, from main's answers alone", async () => {
    const { store, invoke } = await hydrated()
    await store.getState().selectTask('t1')

    const workspace = await store.getState().createWorkspace('/code/acme-web')

    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesCreate, { rootPath: '/code/acme-web' })
    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesOpen, { id: 'w3' })
    expect(workspace).toEqual({ ...sampleWorkspace('w3'), rootPath: '/code/acme-web', lastOpenedAt: 5_000 })
    expect(store.getState().workspaces).toContainEqual(workspace)
    expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w3', selectedTaskId: null })
  })

  it("rejects with main's error", async () => {
    const failure = bridgeError(BridgeErrorCode.InvalidRootPath, 'workspaces.create: /nope is not a folder')
    const store = createGladeStore(fakeBridge(main(), { [CommandName.WorkspacesCreate]: () => refuse(failure) }).bridge)
    await store.getState().hydrate()

    await expect(store.getState().createWorkspace('/nope')).rejects.toBe(failure)
    expect(store.getState().workspaces).toHaveLength(2)
  })
})

describe('chooseFolder', () => {
  it('answers with the chosen folder', async () => {
    const { bridge, invoke } = fakeBridge(main(), { [CommandName.DialogChooseFolder]: () => ({ path: '/code/new' }) })

    await expect(createGladeStore(bridge).getState().chooseFolder()).resolves.toBe('/code/new')
    expect(invoke).toHaveBeenCalledWith(CommandName.DialogChooseFolder, {})
  })

  it('answers null when the dialog is cancelled', async () => {
    const { store } = await hydrated()

    await expect(store.getState().chooseFolder()).resolves.toBeNull()
  })
})

describe('openWorkspace', () => {
  it('records the workspace as opened and shows it', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().openWorkspace('w2')

    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesOpen, { id: 'w2' })
    expect(store.getState().selectedWorkspaceId).toBe('w2')
    expect(selectSelectedWorkspace(store.getState())?.lastOpenedAt).toBe(5_000)
  })

  it("rejects with main's error for an unknown workspace", async () => {
    const { store } = await hydrated()

    await expect(store.getState().openWorkspace('gone')).rejects.toEqual(
      bridgeError(BridgeErrorCode.NotFound, 'No workspace gone'),
    )
  })
})

describe('selectWorkspace', () => {
  it('selects the workspace at once and writes it back to main', async () => {
    const { store, data, invoke } = await hydrated()

    const writing = store.getState().selectWorkspace('w2')
    expect(store.getState().selectedWorkspaceId).toBe('w2')
    await writing

    expect(invoke).toHaveBeenCalledWith(CommandName.UiStateSet, { key: UiStateKey.ActiveWorkspaceId, value: 'w2' })
    expect(data.uiState).toEqual([{ key: UiStateKey.ActiveWorkspaceId, value: 'w2' }])
  })

  it('deselects the selected task when it is in another workspace', async () => {
    const { store, data } = await hydrated()
    await store.getState().selectTask('t1')

    await store.getState().selectWorkspace('w2')

    expect(store.getState().selectedTaskId).toBeNull()
    expect(data.uiState).toContainEqual({ key: UiStateKey.SelectedTaskId, value: '' })
  })

  it('keeps the selected task when it is in the workspace, and stores no workspace as the empty string', async () => {
    const { store, data } = await hydrated()
    await store.getState().selectTask('t1')

    await store.getState().selectWorkspace('w1')
    expect(store.getState().selectedTaskId).toBe('t1')

    await store.getState().selectWorkspace(null)
    expect(store.getState().selectedWorkspaceId).toBeNull()
    expect(store.getState().selectedTaskId).toBeNull()
    expect(data.uiState).toContainEqual({ key: UiStateKey.ActiveWorkspaceId, value: '' })
  })
})

describe('selectTask', () => {
  it('selects the task and its workspace, and writes both back to main', async () => {
    const { store, data } = await hydrated()

    await store.getState().selectTask('t2')

    expect(selectSelectedTask(store.getState())).toEqual(sampleTask('t2', 'w2'))
    expect(selectSelectedWorkspace(store.getState())).toEqual(sampleWorkspace('w2'))
    expect(data.uiState).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: 'w2' },
      { key: UiStateKey.SelectedTaskId, value: 't2' },
    ])
  })

  it('writes only the task when it is in the selected workspace, and clears the selection with null', async () => {
    const { store, invoke } = await hydrated(main([{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }]))

    await store.getState().selectTask('t1')
    await store.getState().selectTask(null)

    expect(invoke.mock.calls.filter(([command]) => command === CommandName.UiStateSet)).toEqual([
      [CommandName.UiStateSet, { key: UiStateKey.SelectedTaskId, value: 't1' }],
      [CommandName.UiStateSet, { key: UiStateKey.SelectedTaskId, value: '' }],
    ])
    expect(selectSelectedTask(store.getState())).toBeUndefined()
    expect(selectSelectedWorkspace(store.getState())).toEqual(sampleWorkspace('w1'))
  })
})

describe('setUiState', () => {
  it("rejects with main's error when main refuses the write", async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'uiState.set failed: disk full')
    const { bridge } = fakeBridge(main(), { [CommandName.UiStateSet]: () => refuse(failure) })
    const store = createGladeStore(bridge)

    await expect(store.getState().setUiState({ key: UiStateKey.SelectedTaskId, value: 't1' })).rejects.toBe(failure)
  })
})

describe('task actions', () => {
  it('creates a task and selects it, with its workspace', async () => {
    const { store, data } = await hydrated(main([{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }]))

    const task = await store.getState().createTask('w2')

    expect(data.tasks).toContainEqual(task)
    expect(selectSelectedTask(store.getState())).toEqual(task)
    expect(store.getState().selectedWorkspaceId).toBe('w2')
  })

  it("selects a created task whose task.updated event hasn't arrived yet", async () => {
    const created = sampleTask('t3', 'w1', '')
    const { bridge } = fakeBridge(main(), { [CommandName.TasksCreate]: () => ({ task: created }) })
    const store = createGladeStore(bridge)
    await store.getState().hydrate()

    await store.getState().createTask('w1')

    expect(selectSelectedTask(store.getState())).toEqual(created)
  })

  it('marks a task done, reopens it and updates it through main, following its events', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().markTaskDone('t1')
    expect(store.getState().tasks.t1?.state).toBe(TaskState.Done)
    await store.getState().reopenTask('t1')
    expect(store.getState().tasks.t1?.state).toBe(TaskState.Active)
    await store.getState().updateTask('t1', { pinned: true, effort: Effort.Low })

    expect(store.getState().tasks.t1).toMatchObject({ pinned: true, effort: Effort.Low, doneAt: null })
    expect(invoke.mock.calls.slice(-3)).toEqual([
      [CommandName.TasksMarkDone, { id: 't1' }],
      [CommandName.TasksReopen, { id: 't1' }],
      [CommandName.TasksUpdate, { id: 't1', patch: { pinned: true, effort: Effort.Low } }],
    ])
  })
})
