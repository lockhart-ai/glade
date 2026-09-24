import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { describeFailure, loadSnapshot, restoreSelection } from './hydrate'
import { HydrationStatus, INITIAL_DATA } from './state'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeMain } from './test-bridge'

function main(uiState: FakeMain['uiState'] = []): FakeMain {
  return {
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w2'), sampleTask('t3', 'w2')],
    uiState,
  }
}

describe('loadSnapshot', () => {
  it("loads every workspace, every workspace's tasks by id, and the UI state with the selection", async () => {
    const { bridge, invoke } = fakeBridge(
      main([
        { key: UiStateKey.ActiveWorkspaceId, value: 'w2' },
        { key: UiStateKey.SelectedTaskId, value: 't3' },
      ]),
    )

    await expect(loadSnapshot(bridge)).resolves.toEqual({
      ...INITIAL_DATA,
      hydration: { status: HydrationStatus.Ready },
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
      tasks: { t1: sampleTask('t1', 'w1'), t2: sampleTask('t2', 'w2'), t3: sampleTask('t3', 'w2') },
      selectedWorkspaceId: 'w2',
      selectedTaskId: 't3',
      uiState: { [UiStateKey.ActiveWorkspaceId]: 'w2', [UiStateKey.SelectedTaskId]: 't3' },
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksList, { workspaceId: 'w1' })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksList, { workspaceId: 'w2' })
  })

  it('starts with nothing selected when no selection was stored', async () => {
    const snapshot = await loadSnapshot(fakeBridge(main()).bridge)

    expect(snapshot.selectedWorkspaceId).toBeNull()
    expect(snapshot.selectedTaskId).toBeNull()
  })

  it('rejects when main refuses a command', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'tasks.list failed: disk full')
    const { bridge } = fakeBridge(main(), { [CommandName.TasksList]: () => refuse(failure) })

    await expect(loadSnapshot(bridge)).rejects.toBe(failure)
  })
})

describe('restoreSelection', () => {
  const loaded = {
    ...INITIAL_DATA,
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    tasks: { t1: sampleTask('t1', 'w1'), t2: sampleTask('t2', 'w2') },
  }

  it('keeps a selection that still points at a workspace and one of its tasks', () => {
    expect(restoreSelection({ ...loaded, selectedWorkspaceId: 'w2', selectedTaskId: 't2' })).toMatchObject({
      selectedWorkspaceId: 'w2',
      selectedTaskId: 't2',
    })
  })

  it('drops a workspace that is gone, and with it the task', () => {
    expect(restoreSelection({ ...loaded, selectedWorkspaceId: 'gone', selectedTaskId: 't2' })).toMatchObject({
      selectedWorkspaceId: null,
      selectedTaskId: null,
    })
  })

  it('drops a task that is gone or in another workspace', () => {
    expect(restoreSelection({ ...loaded, selectedWorkspaceId: 'w1', selectedTaskId: 'gone' })).toMatchObject({
      selectedWorkspaceId: 'w1',
      selectedTaskId: null,
    })
    expect(restoreSelection({ ...loaded, selectedWorkspaceId: 'w1', selectedTaskId: 't2' })).toMatchObject({
      selectedWorkspaceId: 'w1',
      selectedTaskId: null,
    })
  })
})

describe('describeFailure', () => {
  it("gives a BridgeError's or Error's message, or the value itself", () => {
    expect(describeFailure(bridgeError(BridgeErrorCode.Internal, 'disk full'))).toBe('disk full')
    expect(describeFailure(new Error('gone'))).toBe('gone')
    expect(describeFailure('bug')).toBe('bug')
  })
})
