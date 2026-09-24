import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
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
