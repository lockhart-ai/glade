import { describe, expect, it } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName } from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { DONE_PAGE_SIZE, NO_DONE_TASKS } from '../../shared/doneList'
import { TaskState, ToolCallState, ToolEventKind, UiStateKey, type Task, type ToolCallEvent } from '../../shared/domain'
import { doneListKey } from './doneLists'
import { describeFailure, lastOpenedWorkspace, loadSnapshot, restoreSelection } from './hydrate'
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
      doneCounts: { w1: NO_DONE_TASKS, w2: NO_DONE_TASKS },
      doneLists: { [doneListKey('w2', TaskFilter.All)]: { end: null, hasMore: false } },
      selectedWorkspaceId: 'w2',
      selectedTaskId: 't3',
      uiState: { [UiStateKey.ActiveWorkspaceId]: 'w2', [UiStateKey.SelectedTaskId]: 't3' },
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksListActive, { workspaceId: 'w1' })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksListActive, { workspaceId: 'w2' })
  })

  it("loads each workspace's tasks outside the Done section, its Done counts, and the shown one's first Done page", async () => {
    const done = (id: string, workspaceId: string, updatedAt: number, unread = false): Task => ({
      ...sampleTask(id, workspaceId),
      state: TaskState.Done,
      updatedAt,
      unread,
    })
    const pinnedDone = { ...done('pinned', 'w1', 10), pinned: true }
    const doneTasks = Array.from({ length: DONE_PAGE_SIZE + 5 }, (_, index) =>
      done(`d${String(index)}`, 'w1', 10_000 - index, index % 2 === 0),
    )
    const { bridge, invoke } = fakeBridge({
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
      tasks: [sampleTask('t1', 'w1'), pinnedDone, ...doneTasks, done('elsewhere', 'w2', 50)],
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
    })

    const snapshot = await loadSnapshot(bridge)

    expect(snapshot.doneCounts).toEqual({ w1: { all: DONE_PAGE_SIZE + 5, unread: 53 }, w2: { all: 1, unread: 0 } })
    expect(Object.keys(snapshot.tasks)).toHaveLength(2 + DONE_PAGE_SIZE)
    expect(snapshot.tasks.pinned).toEqual(pinnedDone)
    expect(snapshot.tasks.elsewhere).toBeUndefined()
    expect(snapshot.doneLists).toEqual({
      [doneListKey('w1', TaskFilter.All)]: {
        end: { updatedAt: 10_000 - DONE_PAGE_SIZE + 1, id: `d${String(DONE_PAGE_SIZE - 1)}` },
        hasMore: true,
      },
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksListDone, {
      workspaceId: 'w1',
      filter: TaskFilter.All,
      after: null,
      limit: DONE_PAGE_SIZE,
    })
  })

  it("loads every task's running subagents into its tool log, so the task list can count them", async () => {
    const agent = (id: string, taskId: string, state: ToolCallState): ToolCallEvent => ({
      id,
      taskId,
      turn: 1,
      createdAt: 1_000,
      kind: ToolEventKind.ToolCall,
      name: 'Agent',
      input: {},
      output: state === ToolCallState.Running ? null : 'Done.',
      state,
      finishedAt: null,
      toolUseId: `use-${id}`,
      parentToolUseId: null,
    })
    const running = [agent('a', 't1', ToolCallState.Running), agent('c', 't3', ToolCallState.Running)]
    const { bridge, invoke } = fakeBridge({
      ...main(),
      toolEvents: [...running, agent('b', 't1', ToolCallState.Done)],
    })

    const snapshot = await loadSnapshot(bridge)

    expect(invoke).toHaveBeenCalledWith(CommandName.SubagentsListRunning, {})
    expect(snapshot.toolEvents).toEqual({ t1: [running[0]], t3: [running[1]] })
  })

  it('loads the first Done page under the filter chip chosen', async () => {
    const { bridge, invoke } = fakeBridge(
      main([
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.TaskFilter, value: TaskFilter.Unread },
      ]),
    )

    const snapshot = await loadSnapshot(bridge)

    expect(Object.keys(snapshot.doneLists)).toEqual([doneListKey('w1', TaskFilter.Unread)])
    expect(invoke).toHaveBeenCalledWith(
      CommandName.TasksListDone,
      expect.objectContaining({ filter: TaskFilter.Unread }),
    )
  })

  it('loads a selected done task below the first Done page, so the selection survives', async () => {
    const doneTasks = Array.from({ length: DONE_PAGE_SIZE * 2 }, (_, index) => ({
      ...sampleTask(`d${String(index)}`, 'w1'),
      state: TaskState.Done,
      updatedAt: 10_000 - index,
    }))
    const { bridge, invoke } = fakeBridge({
      workspaces: [sampleWorkspace('w1')],
      tasks: doneTasks,
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 'd150' },
      ],
    })

    const snapshot = await loadSnapshot(bridge)

    expect(snapshot.selectedTaskId).toBe('d150')
    expect(snapshot.tasks.d150).toEqual(doneTasks[150])
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksGet, { ids: ['d150'] })
  })

  it('drops a stored selection whose task is gone, having looked for it', async () => {
    const { bridge, invoke } = fakeBridge(
      main([
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 'gone' },
      ]),
    )

    const snapshot = await loadSnapshot(bridge)

    expect(snapshot.selectedTaskId).toBeNull()
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksGet, { ids: ['gone'] })
  })

  it('shows the most recently opened workspace, with no task, when no selection was stored', async () => {
    const snapshot = await loadSnapshot(fakeBridge(main()).bridge)

    expect(snapshot.selectedWorkspaceId).toBe('w1')
    expect(snapshot.selectedTaskId).toBeNull()
  })

  it('starts with nothing selected when there are no workspaces', async () => {
    const snapshot = await loadSnapshot(fakeBridge({ workspaces: [], tasks: [], uiState: [] }).bridge)

    expect(snapshot.selectedWorkspaceId).toBeNull()
    expect(snapshot.selectedTaskId).toBeNull()
  })

  it('rejects when main refuses a command', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'tasks.listActive failed: disk full')
    const { bridge } = fakeBridge(main(), { [CommandName.TasksListActive]: () => refuse(failure) })

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

  it('replaces a workspace that is gone with the most recently opened one, dropping the task', () => {
    const opened = { ...loaded, workspaces: [sampleWorkspace('w1'), { ...sampleWorkspace('w2'), lastOpenedAt: 3_000 }] }

    expect(restoreSelection({ ...opened, selectedWorkspaceId: 'gone', selectedTaskId: 't1' })).toMatchObject({
      selectedWorkspaceId: 'w2',
      selectedTaskId: null,
    })
  })

  it('selects nothing when there are no workspaces', () => {
    expect(restoreSelection({ ...INITIAL_DATA, selectedWorkspaceId: 'gone', selectedTaskId: 't1' })).toMatchObject({
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

describe('lastOpenedWorkspace', () => {
  it('finds the most recently opened workspace, the oldest of a tie, or none', () => {
    const latest = { ...sampleWorkspace('w2'), lastOpenedAt: 3_000 }

    expect(lastOpenedWorkspace([sampleWorkspace('w1'), latest, sampleWorkspace('w3')])).toBe(latest)
    expect(lastOpenedWorkspace([sampleWorkspace('w1'), sampleWorkspace('w2')])?.id).toBe('w1')
    expect(lastOpenedWorkspace([])).toBeUndefined()
  })
})

describe('describeFailure', () => {
  it("gives a BridgeError's or Error's message, or the value itself", () => {
    expect(describeFailure(bridgeError(BridgeErrorCode.Internal, 'disk full'))).toBe('disk full')
    expect(describeFailure(new Error('gone'))).toBe('gone')
    expect(describeFailure('bug')).toBe('bug')
  })
})
