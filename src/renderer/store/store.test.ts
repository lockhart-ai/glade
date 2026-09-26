import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType, type DraftsGetResponse } from '../../shared/bridge'
import {
  DividerKind,
  Effort,
  FileContentKind,
  ArtifactDateGroup,
  FileThumbnailKind,
  MessageRole,
  QuestionSetState,
  TaskActivity,
  TaskState,
  ToolEventKind,
  UiStateKey,
  WatcherState,
  type UiStateEntry,
} from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { GIF, JPEG, PNG } from '../../shared/test-images'
import { SettingsSection } from '../settings/sections'
import { HydrationStatus, selectSelectedTask, selectSelectedWorkspace } from './state'
import { createGladeStore } from './store'
import {
  fakeBridge,
  refuse,
  sampleMessage,
  sampleQuestionSet,
  sampleQueuedMessage,
  sampleTask,
  sampleWatcher,
  sampleWorkspace,
  type FakeMain,
} from './test-bridge'

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

  describe("a done task it hasn't seen, e.g. one imported done", () => {
    const imported = {
      ...sampleTask('t9', 'w2'),
      title: 'Fix the rate limit tests',
      state: TaskState.Done,
      unread: true,
    }

    it("reads its workspace's Done counts from main again, since only main knows if it was counted", async () => {
      const { store, emit, data, invoke } = await hydrated()
      expect(store.getState().doneCounts.w2).toEqual({ all: 0, unread: 0 })

      data.tasks.push(imported)
      emit({ type: EventType.TaskUpdated, task: imported })

      await vi.waitFor(() => {
        expect(store.getState().doneCounts.w2).toEqual({ all: 1, unread: 1 })
      })
      expect(store.getState().tasks.t9).toEqual(imported)
      // A later change to it, now seen, is counted as usual, with no need to ask.
      invoke.mockClear()
      emit({ type: EventType.TaskUpdated, task: { ...imported, unread: false } })
      expect(store.getState().doneCounts.w2).toEqual({ all: 1, unread: 0 })
      expect(invoke).not.toHaveBeenCalled()
    })

    it("doesn't ask for an active or pinned one, which isn't in the Done section", async () => {
      const { emit, invoke } = await hydrated()
      invoke.mockClear()
      emit({ type: EventType.TaskUpdated, task: { ...imported, state: TaskState.Active } })
      emit({ type: EventType.TaskUpdated, task: { ...imported, id: 't10', pinned: true } })
      expect(invoke).not.toHaveBeenCalled()
    })

    it('keeps the counts it had when main fails to say', async () => {
      let failing = false
      const fake = fakeBridge(main(), {
        [CommandName.TasksListActive]: () =>
          failing
            ? refuse(bridgeError(BridgeErrorCode.Internal, 'The database is locked'))
            : { tasks: [], done: { all: 0, unread: 0 } },
      })
      const store = createGladeStore(fake.bridge)
      await store.getState().hydrate()
      failing = true

      fake.emit({ type: EventType.TaskUpdated, task: imported })

      await vi.waitFor(() => {
        expect(fake.invoke).toHaveBeenCalledWith(CommandName.TasksListActive, { workspaceId: 'w2' })
      })
      await Promise.resolve()
      expect(store.getState().doneCounts.w2).toEqual({ all: 0, unread: 0 })
    })
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

describe('updateWorkspace', () => {
  it('renames or moves a workspace and holds it as main answers', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().updateWorkspace('w2', { name: 'Acme Web', rootPath: '/code/acme-web' })

    expect(invoke).toHaveBeenCalledWith(CommandName.WorkspacesUpdate, {
      id: 'w2',
      patch: { name: 'Acme Web', rootPath: '/code/acme-web' },
    })
    expect(store.getState().workspaces[1]).toMatchObject({ id: 'w2', name: 'Acme Web', rootPath: '/code/acme-web' })
  })

  it("rejects with main's error", async () => {
    const { store } = await hydrated()

    await expect(store.getState().updateWorkspace('gone', { name: 'x' })).rejects.toEqual(
      bridgeError(BridgeErrorCode.NotFound, 'No workspace gone'),
    )
  })
})

describe('settings', () => {
  it('are loaded with the snapshot', async () => {
    const settings = { ...DEFAULT_SETTINGS, defaultEffort: Effort.Max }
    const { store } = await hydrated({ ...main(), settings })

    expect(store.getState().settings).toEqual(settings)
  })

  it('change at once, save through main, and follow what main broadcasts', async () => {
    const { store, invoke, emit } = await hydrated()

    const saving = store.getState().updateSettings({ notifications: false })
    expect(store.getState().settings.notifications).toBe(false)
    await saving

    expect(invoke).toHaveBeenCalledWith(CommandName.SettingsUpdate, { patch: { notifications: false } })
    emit({ type: EventType.SettingsChanged, settings: { ...DEFAULT_SETTINGS, taskTitles: false } })
    expect(store.getState().settings).toEqual({ ...DEFAULT_SETTINGS, taskTitles: false })
  })

  it('open at the Agent section or the one asked for, and close', async () => {
    const { store } = await hydrated()
    expect(store.getState().settingsSection).toBeNull()

    store.getState().openSettings()
    expect(store.getState().settingsSection).toBe(SettingsSection.Agent)
    store.getState().openSettings(SettingsSection.Workspace)
    expect(store.getState().settingsSection).toBe(SettingsSection.Workspace)
    store.getState().closeSettings()
    expect(store.getState().settingsSection).toBeNull()
  })
})

describe('switching workspaces', () => {
  it("shows the task last selected in the workspace, with its logs, from main's answer", async () => {
    const data = {
      ...main(),
      messages: [sampleMessage('m2', 't2', 'Add rate limiting')],
      workspaceSelections: { w2: 't2' },
    }
    const { store, invoke } = await hydrated(data)
    await store.getState().selectTask('t1')

    await store.getState().openWorkspace('w2')

    expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: 't2' })
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksHistory, { id: 't2' })
    expect(store.getState().messages.t2?.map(({ id }) => id)).toEqual(['m2'])
  })

  it('shows no task when the workspace has none selected', async () => {
    const { store } = await hydrated()
    await store.getState().selectTask('t1')

    await store.getState().openWorkspace('w2')

    expect(store.getState()).toMatchObject({ selectedWorkspaceId: 'w2', selectedTaskId: null })
  })
})

describe('addWorkspace', () => {
  it('adds the chosen folder as a workspace and opens it', async () => {
    const { store } = await hydrated()
    const fake = fakeBridge(main(), { [CommandName.DialogChooseFolder]: () => ({ path: '/code/blog' }) })
    const chosen = createGladeStore(fake.bridge)
    await chosen.getState().hydrate()

    await expect(chosen.getState().addWorkspace()).resolves.toMatchObject({ id: 'w3', rootPath: '/code/blog' })
    expect(chosen.getState().selectedWorkspaceId).toBe('w3')
    await expect(store.getState().addWorkspace()).resolves.toBeNull()
  })
})

describe('revealWorkspace', () => {
  it('asks main to show the root in Finder', async () => {
    const revealedWorkspaces: string[] = []
    const { store } = await hydrated({ ...main(), revealedWorkspaces })

    await store.getState().revealWorkspace('w2')

    expect(revealedWorkspaces).toEqual(['w2'])
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

describe('a task main asks to open', () => {
  it('is selected, with its workspace, as clicking its row would, and its logs load', async () => {
    const message = sampleMessage('m1', 't2')
    const { store, emit, data, invoke } = await hydrated({
      ...main([{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }]),
      messages: [message],
    })

    emit({ type: EventType.TaskOpenRequested, taskId: 't2' })

    await vi.waitFor(() => {
      expect(store.getState().messages).toEqual({ t2: [message] })
    })
    expect(selectSelectedTask(store.getState())).toEqual(sampleTask('t2', 'w2'))
    expect(selectSelectedWorkspace(store.getState())).toEqual(sampleWorkspace('w2'))
    expect(data.uiState).toEqual([
      { key: UiStateKey.ActiveWorkspaceId, value: 'w2' },
      { key: UiStateKey.SelectedTaskId, value: 't2' },
    ])
    expect(invoke).toHaveBeenCalledWith(CommandName.TasksHistory, { id: 't2' })
  })

  it('is opened once loaded when it is asked for while the store loads, in place of the restored task', async () => {
    const message = sampleMessage('m1', 't2')
    let emitDuringLoad = (): void => undefined
    const fake = fakeBridge(
      {
        ...main([
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
        ]),
        messages: [message],
      },
      {
        [CommandName.WorkspacesList]: () => {
          emitDuringLoad()
          return { workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')] }
        },
      },
    )
    emitDuringLoad = () => {
      fake.emit({ type: EventType.TaskOpenRequested, taskId: 't2' })
    }
    const store = createGladeStore(fake.bridge)

    await store.getState().hydrate()

    expect(selectSelectedTask(store.getState())).toEqual(sampleTask('t2', 'w2'))
    expect(store.getState().messages).toEqual({ t2: [message] })
    expect(fake.invoke.mock.calls.filter(([command]) => command === CommandName.TasksHistory)).toEqual([
      [CommandName.TasksHistory, { id: 't2' }],
    ])
  })
})

describe('setUiState', () => {
  it("rejects with main's error when main refuses the write", async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'uiState.set failed: disk full')
    const { bridge } = fakeBridge(main(), { [CommandName.UiStateSet]: () => refuse(failure) })
    const store = createGladeStore(bridge)

    await expect(store.getState().setUiState({ key: UiStateKey.SelectedTaskId, value: 't1' })).rejects.toBe(failure)
  })

  /**
   * A store whose `uiState.set` main answers at once but echoes (`uiState.changed`) only when `echo()` says so, oldest
   * first, as a busy main process does: the order that lost the right panel's resize steps in the narrow-window spec.
   */
  async function withSlowEchoes() {
    const echoes: UiStateEntry[] = []
    const fake = fakeBridge(main(), {
      [CommandName.UiStateSet]: (entry) => {
        echoes.push(entry)
        return null
      },
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()
    const echo = (): void => {
      const entry = echoes.shift()
      if (entry === undefined) throw new Error('No echo on its way')
      fake.emit({ type: EventType.UiStateChanged, entry })
    }
    const width = (): string | undefined => store.getState().uiState[UiStateKey.RightPanelWidth]
    const setWidth = (value: string) => store.getState().setUiState({ key: UiStateKey.RightPanelWidth, value })
    return { ...fake, store, echo, width, setWidth }
  }

  it("keeps a newer write when main's echo of an older one comes back after it", async () => {
    const { echo, width, setWidth } = await withSlowEchoes()

    await setWidth('354')
    await setWidth('338')
    expect(width()).toBe('338')

    // This echo used to put the width back to 354, so the next arrow key press on the handle stepped from there again.
    echo()
    expect(width()).toBe('338')
    await setWidth('322')
    echo()
    expect(width()).toBe('322')
    echo()
    expect(width()).toBe('322')
  })

  it('takes changes from main again once the echo of every write has come back', async () => {
    const { emit, echo, width, setWidth } = await withSlowEchoes()

    await setWidth('354')
    echo()
    emit({ type: EventType.UiStateChanged, entry: { key: UiStateKey.RightPanelWidth, value: '500' } })

    expect(width()).toBe('500')
  })

  it("holds back someone else's change that main stored before a write still on its way", async () => {
    const { emit, echo, width, setWidth } = await withSlowEchoes()

    await setWidth('354')
    // Main stored this before the write, so the write wins there too.
    emit({ type: EventType.UiStateChanged, entry: { key: UiStateKey.RightPanelWidth, value: '500' } })
    expect(width()).toBe('354')
    echo()
    expect(width()).toBe('354')
  })

  it('waits for the echo of each write of the same value', async () => {
    const { echo, width, setWidth } = await withSlowEchoes()

    await setWidth('354')
    await setWidth('338')
    await setWidth('354')
    echo()
    echo()
    expect(width()).toBe('354')
    echo()
    expect(width()).toBe('354')
  })

  it('holds back changes to the key it wrote only', async () => {
    const { store, emit, setWidth } = await withSlowEchoes()

    await setWidth('354')
    emit({ type: EventType.UiStateChanged, entry: { key: UiStateKey.SidebarWidth, value: '260' } })

    expect(store.getState().uiState[UiStateKey.SidebarWidth]).toBe('260')
  })

  it('stops waiting for the echo of a write main refused, which never comes', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'uiState.set failed: disk full')
    const fake = fakeBridge(main(), { [CommandName.UiStateSet]: () => refuse(failure) })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()
    const entry = { key: UiStateKey.RightPanelWidth, value: '354' }
    await expect(store.getState().setUiState(entry)).rejects.toBe(failure)
    await expect(store.getState().setUiState({ ...entry, value: '338' })).rejects.toBe(failure)
    await expect(store.getState().setUiState(entry)).rejects.toBe(failure)

    fake.emit({ type: EventType.UiStateChanged, entry: { ...entry, value: '500' } })

    expect(store.getState().uiState[UiStateKey.RightPanelWidth]).toBe('500')
  })

  it('stops waiting for a refused write while an earlier one is still on its way', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'uiState.set failed: disk full')
    const stored = { key: UiStateKey.RightPanelWidth, value: '354' }
    const fake = fakeBridge(main(), {
      [CommandName.UiStateSet]: (entry) => (entry.value === stored.value ? null : refuse(failure)),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()
    await store.getState().setUiState(stored)
    await expect(store.getState().setUiState({ ...stored, value: '338' })).rejects.toBe(failure)

    // Main kept 354: its echo comes back, and it's the latest there is.
    fake.emit({ type: EventType.UiStateChanged, entry: stored })

    expect(store.getState().uiState[UiStateKey.RightPanelWidth]).toBe('354')
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

  it('marks a task unread through main, leaving the selection alone', async () => {
    const { store, invoke } = await hydrated(main([{ key: UiStateKey.SelectedTaskId, value: 't1' }]))

    await store.getState().markUnread('t1')

    expect(store.getState().tasks.t1?.unread).toBe(true)
    expect(store.getState().selectedTaskId).toBe('t1')
    expect(invoke.mock.calls.at(-1)).toEqual([CommandName.TasksUpdate, { id: 't1', patch: { unread: true } }])
  })
})

describe('pin, rename and delete', () => {
  /** Three tasks in w1, newest first: t3 (pinned), then t2 and t1 under Active. t1 is selected. */
  function listed(): FakeMain {
    return {
      workspaces: [sampleWorkspace('w1')],
      tasks: [
        { ...sampleTask('t1', 'w1', 'Fix flaky login test'), updatedAt: 1_000 },
        { ...sampleTask('t2', 'w1', 'Move uploads to S3'), updatedAt: 2_000 },
        { ...sampleTask('t3', 'w1', 'Draft release notes'), updatedAt: 3_000, pinned: true },
      ],
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
      ],
    }
  }

  it('pins and unpins a task through main, and does nothing for a task it does not have', async () => {
    const { store, invoke } = await hydrated(listed())

    await store.getState().togglePin('t1')
    expect(store.getState().tasks.t1?.pinned).toBe(true)
    await store.getState().togglePin('t1')
    expect(store.getState().tasks.t1?.pinned).toBe(false)
    await store.getState().togglePin('missing')

    expect(invoke.mock.calls.filter(([command]) => command === CommandName.TasksUpdate)).toEqual([
      [CommandName.TasksUpdate, { id: 't1', patch: { pinned: true } }],
      [CommandName.TasksUpdate, { id: 't1', patch: { pinned: false } }],
    ])
  })

  it('renames a task to its trimmed title, and stops renaming', async () => {
    const { store, invoke } = await hydrated(listed())
    store.getState().startRename('t1')
    expect(store.getState().renamingTaskId).toBe('t1')

    await expect(store.getState().renameTask('t1', '  Fix the login race  ')).resolves.toBe(true)

    expect(store.getState().tasks.t1?.title).toBe('Fix the login race')
    expect(store.getState().renamingTaskId).toBeNull()
    expect(invoke.mock.calls.at(-1)).toEqual([
      CommandName.TasksUpdate,
      { id: 't1', patch: { title: 'Fix the login race' } },
    ])
  })

  it('refuses a blank title and keeps renaming, without calling main', async () => {
    const { store, invoke } = await hydrated(listed())
    store.getState().startRename('t1')
    const calls = invoke.mock.calls.length

    await expect(store.getState().renameTask('t1', ' \t ')).resolves.toBe(false)

    expect(store.getState().renamingTaskId).toBe('t1')
    expect(store.getState().tasks.t1?.title).toBe('Fix flaky login test')
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('saves an unchanged title without calling main, and leaves a rename of another task going', async () => {
    const { store, invoke } = await hydrated(listed())
    store.getState().startRename('t2')
    const calls = invoke.mock.calls.length

    await expect(store.getState().renameTask('t1', 'Fix flaky login test')).resolves.toBe(true)

    expect(invoke.mock.calls).toHaveLength(calls)
    expect(store.getState().renamingTaskId).toBe('t2')
    store.getState().cancelRename()
    expect(store.getState().renamingTaskId).toBeNull()
  })

  it('asks before deleting, and cancelling keeps the task', async () => {
    const { store, invoke } = await hydrated(listed())

    store.getState().requestDelete('t2')
    expect(store.getState().deletingTaskId).toBe('t2')
    store.getState().cancelDelete()

    expect(store.getState().deletingTaskId).toBeNull()
    expect(store.getState().tasks.t2).toBeDefined()
    expect(invoke.mock.calls.map(([command]) => command)).not.toContain(CommandName.TasksDelete)
  })

  it('deletes the selected task and selects the next one in the list', async () => {
    const { store, invoke, data } = await hydrated({
      ...listed(),
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't3' },
      ],
    })
    store.getState().requestDelete('t3')

    await store.getState().deleteTask('t3')

    expect(invoke).toHaveBeenCalledWith(CommandName.TasksDelete, { id: 't3' })
    expect(data.tasks.map(({ id }) => id)).toEqual(['t1', 't2'])
    expect(Object.keys(store.getState().tasks)).toEqual(['t1', 't2'])
    expect(store.getState().deletingTaskId).toBeNull()
    expect(store.getState().selectedTaskId).toBe('t2')
  })

  it('selects the one before when the deleted task was the last in the list, and none when it was the only one', async () => {
    const { store } = await hydrated(listed())

    await store.getState().deleteTask('t1')
    expect(store.getState().selectedTaskId).toBe('t2')

    await store.getState().deleteTask('t3')
    await store.getState().deleteTask('t2')
    expect(store.getState().selectedTaskId).toBeNull()
    expect(store.getState().tasks).toEqual({})
  })

  it('keeps the selection when deleting another task, and forgets the task even before main says so', async () => {
    const { store } = await hydrated(listed())
    const fake = fakeBridge(listed(), { [CommandName.TasksDelete]: () => null })
    const quiet = createGladeStore(fake.bridge)
    await quiet.getState().hydrate()

    await store.getState().deleteTask('t2')
    await quiet.getState().deleteTask('t2')

    for (const each of [store, quiet]) {
      expect(each.getState().selectedTaskId).toBe('t1')
      expect(each.getState().tasks.t2).toBeUndefined()
    }
  })

  it("rejects with main's error, keeping the task", async () => {
    const fake = fakeBridge(listed(), {
      [CommandName.TasksDelete]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()

    await expect(store.getState().deleteTask('t1')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    expect(store.getState().tasks.t1).toBeDefined()
    expect(store.getState().selectedTaskId).toBe('t1')
  })
})

describe("a task's logs", () => {
  it("loads the selected task's chat and tool log, then follows its events", async () => {
    const first = sampleMessage('m1', 't1')
    const divider = {
      kind: ToolEventKind.Divider,
      id: 'e1',
      taskId: 't1',
      turn: 1,
      createdAt: 3_000,
      dividerKind: DividerKind.Turn,
    } as const
    const { store, emit } = await hydrated({
      ...main(),
      messages: [first, sampleMessage('m9', 't2')],
      toolEvents: [divider, { ...divider, id: 'e9', taskId: 't2' }],
    })

    await store.getState().selectTask('t1')
    expect(store.getState().messages).toEqual({ t1: [first] })
    expect(store.getState().toolEvents).toEqual({ t1: [divider] })

    const reply = { ...sampleMessage('m2', 't1', 'Done.'), role: MessageRole.Agent }
    emit({ type: EventType.MessageAppended, message: reply })
    expect(store.getState().messages.t1).toEqual([first, reply])
  })

  it('loads nothing when the selection is cleared', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().selectTask(null)

    expect(invoke.mock.calls.some(([command]) => command === CommandName.TasksHistory)).toBe(false)
  })

  it("loads the restored task's logs on hydrating, and only then", async () => {
    const message = sampleMessage('m1', 't1')
    const restored = main([
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ])
    const { store } = await hydrated({ ...restored, messages: [message] })
    expect(store.getState().messages).toEqual({ t1: [message] })

    const { invoke } = await hydrated(main())
    expect(invoke.mock.calls.some(([command]) => command === CommandName.TasksHistory)).toBe(false)
  })

  it("says why when the restored task's logs can't be loaded", async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'tasks.history failed: disk full')
    const restored = main([
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ])
    const { bridge } = fakeBridge(restored, { [CommandName.TasksHistory]: () => refuse(failure) })
    const store = createGladeStore(bridge)

    await store.getState().hydrate()

    expect(store.getState().hydration).toEqual({ status: HydrationStatus.Failed, message: failure.message })
  })

  it('sends a message through main, and the store follows its event', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().sendMessage('t1', 'Add rate limiting.')

    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksSend, { id: 't1', text: 'Add rate limiting.' })
    expect(store.getState().messages.t1?.map(({ body }) => body)).toEqual(['Add rate limiting.'])
  })

  it('sends and queues the images pasted into a message with it, and the store follows the events', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().sendMessage('t1', 'Compare these.', [PNG, GIF])
    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksSend, {
      id: 't1',
      text: 'Compare these.',
      images: [PNG, GIF],
    })
    await store.getState().queueMessage('t1', '', [JPEG])
    expect(invoke).toHaveBeenLastCalledWith(CommandName.QueueAdd, { taskId: 't1', text: '', images: [JPEG] })

    const [sent] = store.getState().messages.t1 ?? []
    expect(sent?.images).toEqual([
      { id: 'image-1', mediaType: PNG.mediaType },
      { id: 'image-2', mediaType: GIF.mediaType },
    ])
    expect(store.getState().queuedMessages.t1?.[0]?.images).toEqual([{ id: 'image-3', mediaType: JPEG.mediaType }])
    // No images: the request leaves them out, as it always has.
    await store.getState().sendMessage('t1', 'Plain.', [])
    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksSend, { id: 't1', text: 'Plain.' })
  })

  it('loads each stored image from main once, and again after it failed to load', async () => {
    let fail = true
    const { bridge, invoke } = fakeBridge(
      { ...main(), images: { i1: PNG } },
      {
        [CommandName.ImagesGet]: ({ id }) =>
          fail ? refuse(bridgeError(BridgeErrorCode.Internal, 'disk busy')) : { image: id === 'i1' ? PNG : GIF },
      },
    )
    const store = createGladeStore(bridge)
    const loads = () => invoke.mock.calls.filter(([command]) => command === CommandName.ImagesGet).length

    await expect(store.getState().loadImage('i1')).rejects.toMatchObject({ code: BridgeErrorCode.Internal })
    fail = false
    expect(await store.getState().loadImage('i1')).toEqual(PNG)
    expect(await store.getState().loadImage('i1')).toEqual(PNG)
    expect(await store.getState().loadImage('i2')).toEqual(GIF)
    expect(loads()).toBe(3)
  })

  it("rejects with main's error when the agent is busy", async () => {
    const busy = bridgeError(BridgeErrorCode.Busy, 'tasks.send: The agent is working')
    const { bridge } = fakeBridge(main(), { [CommandName.TasksSend]: () => refuse(busy) })
    const store = createGladeStore(bridge)

    await expect(store.getState().sendMessage('t1', 'Hi')).rejects.toBe(busy)
  })

  it('queues, edits and removes messages through main, and the store follows its events', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().queueMessage('t1', 'Keep the filenames.')
    await store.getState().queueMessage('t1', 'Use Glacier.')
    expect(invoke).toHaveBeenLastCalledWith(CommandName.QueueAdd, { taskId: 't1', text: 'Use Glacier.' })
    const [first, second] = store.getState().queuedMessages.t1 ?? []

    await store.getState().editQueuedMessage(first?.id ?? '', 'Keep the original filenames.')
    expect(invoke).toHaveBeenLastCalledWith(CommandName.QueueEdit, {
      id: first?.id,
      text: 'Keep the original filenames.',
    })
    await store.getState().removeQueuedMessage(second?.id ?? '')
    expect(invoke).toHaveBeenLastCalledWith(CommandName.QueueRemove, { id: second?.id })

    expect(store.getState().queuedMessages.t1?.map(({ body }) => body)).toEqual(['Keep the original filenames.'])
  })

  it("answers a task's questions through main, and the store follows its event", async () => {
    const data = { ...main(), questionSets: [sampleQuestionSet('s1', 't1')] }
    const { store, invoke } = await hydrated(data)
    await store.getState().loadHistory('t1')

    await store.getState().answerQuestions('s1', { 0: 'by-type' })

    expect(invoke).toHaveBeenLastCalledWith(CommandName.QuestionsAnswer, { id: 's1', answers: { 0: 'by-type' } })
    expect(store.getState().questionSets.t1).toEqual([
      expect.objectContaining({ id: 's1', state: QuestionSetState.Answered }),
    ])
    await expect(store.getState().answerQuestions('gone', {})).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })

  it("rejects with main's error when a queued message is gone", async () => {
    const { store } = await hydrated()
    await expect(store.getState().editQueuedMessage('gone', 'Hi')).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
    await expect(store.getState().removeQueuedMessage('gone')).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
  })

  it("loads a task's queue with its history", async () => {
    const data = { ...main(), queuedMessages: [sampleQueuedMessage('q1', 't1')] }
    const { store } = await hydrated(data)

    await store.getState().loadHistory('t1')

    expect(store.getState().queuedMessages).toEqual({ t1: [sampleQueuedMessage('q1', 't1')] })
  })

  it('stops a task through main, and the store follows its event', async () => {
    const data = main()
    data.tasks[0] = { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working }
    const { store, invoke } = await hydrated(data)

    await store.getState().stopTask('t1')

    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksStop, { id: 't1' })
    expect(store.getState().tasks.t1?.activity).toBe(TaskActivity.Waiting)
  })

  it('retries a task an error stopped through main, on another model if asked, and the store follows', async () => {
    const data = main()
    data.tasks[0] = { ...sampleTask('t1', 'w1'), activity: TaskActivity.Error }
    const { store, invoke } = await hydrated(data)

    await store.getState().retryTask('t1')
    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksRetry, { id: 't1' })
    expect(store.getState().tasks.t1).toMatchObject({ activity: TaskActivity.Working, error: null })

    await store.getState().retryTask('t1', 'claude-sonnet-5')
    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksRetry, { id: 't1', model: 'claude-sonnet-5' })
    expect(store.getState().tasks.t1?.model).toBe('claude-sonnet-5')
  })

  it('compacts a task through main, and the store follows its event', async () => {
    const { store, invoke } = await hydrated()

    await store.getState().compactTask('t1')

    expect(invoke).toHaveBeenLastCalledWith(CommandName.TasksCompact, { id: 't1' })
    expect(store.getState().tasks.t1?.activity).toBe(TaskActivity.Working)
  })

  it('asks the tool log to show a turn, as a new request each time, without calling main', async () => {
    const { store, invoke } = await hydrated()
    const calls = invoke.mock.calls.length
    expect(store.getState().toolLogFocus).toBeNull()

    store.getState().focusTurn('t1', 2)
    expect(store.getState().toolLogFocus).toEqual({ taskId: 't1', turn: 2, request: 1 })

    store.getState().focusTurn('t1', 2)
    expect(store.getState().toolLogFocus).toEqual({ taskId: 't1', turn: 2, request: 2 })
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('asks the input bar to take the focus, as a new request each time, without calling main', async () => {
    const { store, invoke } = await hydrated()
    const calls = invoke.mock.calls.length
    expect(store.getState().inputFocusRequest).toBe(0)

    store.getState().focusInput()
    store.getState().focusInput()
    expect(store.getState().inputFocusRequest).toBe(2)
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('keeps the search text and asks the search field for the focus, without calling main', async () => {
    const { store, invoke } = await hydrated()
    const calls = invoke.mock.calls.length
    expect(store.getState()).toMatchObject({ searchText: '', searchFocusRequest: 0 })

    store.getState().setSearchText('Retry-After')
    store.getState().focusSearch()
    store.getState().focusSearch()

    expect(store.getState()).toMatchObject({ searchText: 'Retry-After', searchFocusRequest: 2 })
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('searches a workspace through main', async () => {
    const { store, invoke } = await hydrated()

    const results = await store.getState().searchTasks('w1', 'rate')

    expect(invoke).toHaveBeenLastCalledWith(CommandName.SearchQuery, { workspaceId: 'w1', text: 'rate' })
    expect(results.map(({ taskId }) => taskId)).toEqual(['t1'])
  })
})

describe('context menu actions', () => {
  it('copies text, stops a subagent and a watcher, and removes an artifact through main', async () => {
    const data: FakeMain = {
      ...main(),
      copied: [],
      stoppedSubagents: [],
      watchers: [sampleWatcher('w1', 't1')],
      stoppedWatchers: [],
      artifacts: [
        {
          taskId: 't1',
          path: 'docs/notes.md',
          title: 'Notes',
          addedAt: 1,
          updatedAt: 1,
          modifiedAt: 1,
          missing: false,
        },
      ],
    }
    const { store } = await hydrated(data)

    await store.getState().copyText('glade://task/t1')
    await store.getState().stopSubagent('t1', 'toolu_02')
    expect(store.getState().watchers.t1?.map(({ state }) => state)).toEqual([WatcherState.Running])
    await store.getState().stopWatcher('t1', 'w1')
    await store.getState().removeArtifact('t1', 'docs/notes.md')

    expect(data.copied).toEqual(['glade://task/t1'])
    expect(data.stoppedSubagents).toEqual(['toolu_02'])
    expect(data.stoppedWatchers).toEqual(['w1'])
    expect(store.getState().watchers.t1?.map(({ state }) => state)).toEqual([WatcherState.Stopped])
    expect(store.getState().artifacts.t1).toEqual([])
  })

  it('asks the input bar to add text, as a new request each time, without calling main', async () => {
    const { store, invoke } = await hydrated()
    const calls = invoke.mock.calls.length
    expect(store.getState().inputInsertion).toBeNull()

    store.getState().insertIntoInput('t1', '> Quoted')
    expect(store.getState().inputInsertion).toEqual({ taskId: 't1', text: '> Quoted', request: 1 })
    store.getState().insertIntoInput('t1', '> Quoted')
    expect(store.getState().inputInsertion).toEqual({ taskId: 't1', text: '> Quoted', request: 2 })
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('keeps each task’s unsent draft, forgetting an empty one, without calling main', async () => {
    const { store, invoke } = await hydrated()
    const calls = invoke.mock.calls.length
    const keep = store.getState().keepInputDraft

    keep('t1', { text: 'Half a thought', images: [] })
    keep('t2', { text: '', images: [PNG] })
    keep('t1', { text: 'A whole thought', images: [] })
    expect(store.getState().inputDrafts).toEqual({
      t1: { text: 'A whole thought', images: [] },
      t2: { text: '', images: [PNG] },
    })
    keep('t1', { text: '', images: [] })
    expect(store.getState().inputDrafts).toEqual({ t2: { text: '', images: [PNG] } })
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('loads a task’s stored draft from main, keeping it, when it has none kept', async () => {
    const data = { ...main(), drafts: { t1: { text: 'From before the relaunch', images: [PNG] } } }
    const { store, invoke } = await hydrated(data)

    await expect(store.getState().loadInputDraft('t1')).resolves.toEqual({
      text: 'From before the relaunch',
      images: [PNG],
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.DraftsGet, { taskId: 't1' })
    expect(store.getState().inputDrafts).toEqual({ t1: { text: 'From before the relaunch', images: [PNG] } })
    await expect(store.getState().loadInputDraft('t2')).resolves.toBeNull()
    expect(store.getState().inputDrafts).toEqual({ t1: { text: 'From before the relaunch', images: [PNG] } })
  })

  it('answers with the kept draft without asking main, and leaves one kept while main answered', async () => {
    let answer: (response: DraftsGetResponse) => void = () => undefined
    const fake = fakeBridge(main(), {
      [CommandName.DraftsGet]: () =>
        new Promise<DraftsGetResponse>((resolve) => {
          answer = resolve
        }),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()

    const loading = store.getState().loadInputDraft('t1')
    store.getState().keepInputDraft('t1', { text: 'Newer', images: [] })
    answer({ draft: { text: 'Older', images: [] } })
    await expect(loading).resolves.toEqual({ text: 'Older', images: [] })
    expect(store.getState().inputDrafts).toEqual({ t1: { text: 'Newer', images: [] } })

    const calls = fake.invoke.mock.calls.length
    await expect(store.getState().loadInputDraft('t1')).resolves.toEqual({ text: 'Newer', images: [] })
    expect(fake.invoke.mock.calls).toHaveLength(calls)
  })

  it('answers with no draft when main can’t read it', async () => {
    const fake = fakeBridge(main(), {
      [CommandName.DraftsGet]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No task t1')),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()
    await expect(store.getState().loadInputDraft('t1')).resolves.toBeNull()
    expect(store.getState().inputDrafts).toEqual({})
  })

  it('stores a draft in main, and carries on when it can’t', async () => {
    const drafts = {}
    const { store, invoke } = await hydrated({ ...main(), drafts })
    await store.getState().saveInputDraft({ taskId: 't1', text: 'Keep this', images: [GIF] })
    expect(invoke).toHaveBeenCalledWith(CommandName.DraftsSet, { taskId: 't1', text: 'Keep this', images: [GIF] })
    expect(drafts).toEqual({ t1: { text: 'Keep this', images: [GIF] } })

    const failing = fakeBridge(main(), {
      [CommandName.DraftsSet]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'database is locked')),
    })
    await expect(createGladeStore(failing.bridge).getState().saveInputDraft({ taskId: 't1', text: 'x' })).resolves.toBe(
      undefined,
    )
  })

  it('shows a file of the selected task in the Files tab, opening the right panel there', async () => {
    const { store } = await hydrated(
      main([
        { key: UiStateKey.SelectedTaskId, value: 't1' },
        { key: UiStateKey.RightPanelCollapsed, value: 'true' },
      ]),
    )

    await store.getState().showFile('t1', 'src/date.ts')

    expect(store.getState().openFiles.t1?.activePath).toBe('src/date.ts')
    expect(store.getState().uiState).toMatchObject({
      [UiStateKey.RightPanelTab]: 'files',
      [UiStateKey.RightPanelCollapsed]: 'false',
    })
  })
})

describe('artifact files', () => {
  it('shows, copies and reveals a file through main', async () => {
    const data: FakeMain = {
      ...main(),
      thumbnails: { 'shot.png': { kind: FileThumbnailKind.Image, dataUrl: 'data:image/png;base64,cG5n' } },
      copied: [],
      revealed: [],
    }
    const { store, invoke } = await hydrated(data)

    await expect(store.getState().fileThumbnail('t1', 'shot.png')).resolves.toEqual({
      kind: FileThumbnailKind.Image,
      dataUrl: 'data:image/png;base64,cG5n',
    })
    expect(invoke).toHaveBeenLastCalledWith(CommandName.FilesThumbnail, { taskId: 't1', path: 'shot.png' })
    await expect(store.getState().fileThumbnail('t1', 'README.md')).resolves.toEqual({ kind: FileThumbnailKind.None })
    await store.getState().copyFile('t1', 'README.md')
    await store.getState().revealFile('t1', 'README.md')
    expect(data.copied).toEqual(['README.md'])
    expect(data.revealed).toEqual(['README.md'])
  })
})

describe('artifact groups and watching', () => {
  it('opens or folds a group at once, and has main remember it', async () => {
    const data: FakeMain = { ...main(), artifactGroups: { t1: [{ group: ArtifactDateGroup.Older, open: true }] } }
    const { store, invoke } = await hydrated(data)
    await store.getState().loadHistory('t1')
    expect(store.getState().artifactGroups.t1).toEqual([{ group: ArtifactDateGroup.Older, open: true }])

    const folding = store.getState().setArtifactGroupOpen('t1', ArtifactDateGroup.Today, false)
    // Before main answers.
    expect(store.getState().artifactGroups.t1).toEqual([
      { group: ArtifactDateGroup.Older, open: true },
      { group: ArtifactDateGroup.Today, open: false },
    ])
    await folding
    await store.getState().setArtifactGroupOpen('t1', ArtifactDateGroup.Older, false)

    expect(invoke).toHaveBeenLastCalledWith(CommandName.ArtifactsSetGroupOpen, {
      taskId: 't1',
      group: ArtifactDateGroup.Older,
      open: false,
    })
    expect(store.getState().artifactGroups.t1).toEqual([
      { group: ArtifactDateGroup.Today, open: false },
      { group: ArtifactDateGroup.Older, open: false },
    ])
    expect(data.artifactGroups?.t1).toEqual(store.getState().artifactGroups.t1)
  })

  it('opens a group for a task whose logs haven’t loaded', async () => {
    const { store } = await hydrated({ ...main() })
    await store.getState().setArtifactGroupOpen('t9', ArtifactDateGroup.LastWeek, true)
    expect(store.getState().artifactGroups.t9).toEqual([{ group: ArtifactDateGroup.LastWeek, open: true }])
  })

  it('asks main to watch a task’s artifacts, and to stop', async () => {
    const data: FakeMain = { ...main(), watchedArtifacts: [] }
    const { store } = await hydrated(data)

    await store.getState().watchArtifacts('t1')
    await store.getState().unwatchArtifacts('t1')

    expect(data.watchedArtifacts).toEqual(['watch t1', 'unwatch t1'])
  })
})

describe('files', () => {
  it('opens and closes files through main, applying its answer, and reads a file without keeping it', async () => {
    const data: FakeMain = {
      ...main(),
      files: { 'README.md': { kind: FileContentKind.Text, text: '# Acme API\n', truncated: false, size: 11 } },
      openedInEditor: [],
    }
    // The open-files commands answer without broadcasting here, so the store must apply the answers itself.
    const { store, invoke } = await hydrated(data)
    const quiet = fakeBridge(data, {
      [CommandName.FilesOpen]: ({ taskId, path }) => ({ openFiles: { taskId, paths: [path], activePath: path } }),
      [CommandName.FilesClose]: ({ taskId }) => ({ openFiles: { taskId, paths: [], activePath: null } }),
    })
    const quietStore = createGladeStore(quiet.bridge)
    await quietStore.getState().hydrate()

    await quietStore.getState().openFile('t1', 'README.md')
    expect(quietStore.getState().openFiles.t1).toEqual({ taskId: 't1', paths: ['README.md'], activePath: 'README.md' })
    await quietStore.getState().closeFile('t1', 'README.md')
    expect(quietStore.getState().openFiles.t1).toEqual({ taskId: 't1', paths: [], activePath: null })

    await expect(store.getState().readFile('t1', 'README.md')).resolves.toMatchObject({ text: '# Acme API\n' })
    expect(invoke).toHaveBeenLastCalledWith(CommandName.FilesRead, { taskId: 't1', path: 'README.md' })
    await store.getState().openInEditor('t1', 'README.md')
    expect(data.openedInEditor).toEqual(['README.md'])
  })

  it('opens the right panel at Files when the agent shows a file of the selected task, and not for another', async () => {
    const { store, emit } = await hydrated(
      main([
        { key: UiStateKey.SelectedTaskId, value: 't1' },
        { key: UiStateKey.RightPanelCollapsed, value: 'true' },
      ]),
    )

    emit({ type: EventType.FileShown, taskId: 't2', path: 'README.md', line: null })
    expect(store.getState().uiState[UiStateKey.RightPanelTab]).toBeUndefined()
    expect(store.getState().fileFocus).toEqual({ taskId: 't2', path: 'README.md', line: null, request: 1 })

    emit({ type: EventType.FileShown, taskId: 't1', path: 'docs/rate-limits.md', line: 8 })
    expect(store.getState().uiState).toMatchObject({
      [UiStateKey.RightPanelTab]: 'files',
      [UiStateKey.RightPanelCollapsed]: 'false',
    })
    expect(store.getState().fileFocus).toEqual({ taskId: 't1', path: 'docs/rate-limits.md', line: 8, request: 2 })
  })
})
