import { describe, expect, it, vi } from 'vitest'
import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EventType,
  type DraftsGetResponse,
  type TasksHistoryResponse,
} from '../../shared/bridge'
import {
  ArtifactDateGroup,
  ArtifactFilter,
  ArtifactKind,
  DividerKind,
  Effort,
  FileContentKind,
  FileThumbnailKind,
  MessageRole,
  QuestionReplyKind,
  QuestionSetState,
  TaskActivity,
  TaskState,
  ToolEventKind,
  UiStateKey,
  WatcherState,
  type Artifact,
  type UiStateEntry,
} from '../../shared/domain'
import { AppCommandId, CommandScope } from '../../shared/commands'
import { noOpenFiles } from '../../shared/files'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { GIF, JPEG, PNG } from '../../shared/test-images'
import { ChildFilter, ChildKind, FilingSource, TODO_HUB_OFF, UNFILED_TODO_ID, type Filing } from '../../shared/todoHub'
import { activePanelTab, PanelTab, panelTabEntry, parsePanelTabSelection } from '../right-panel/panelModel'
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

/** A made-up pull request, for link artifacts (#407). */
const PR = 'https://github.com/acme/api/pull/412'

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
      expect(store.getState().doneCounts.w2).toEqual({ all: 0 })

      data.tasks.push(imported)
      emit({ type: EventType.TaskUpdated, task: imported })

      await vi.waitFor(() => {
        expect(store.getState().doneCounts.w2).toEqual({ all: 1 })
      })
      expect(store.getState().tasks.t9).toEqual(imported)
      // A later change to it, now seen, is counted as usual, with no need to ask.
      invoke.mockClear()
      emit({ type: EventType.TaskUpdated, task: { ...imported, unread: false } })
      expect(store.getState().doneCounts.w2).toEqual({ all: 1 })
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
            : { tasks: [], done: { all: 0 } },
      })
      const store = createGladeStore(fake.bridge)
      await store.getState().hydrate()
      failing = true

      fake.emit({ type: EventType.TaskUpdated, task: imported })

      await vi.waitFor(() => {
        expect(fake.invoke).toHaveBeenCalledWith(CommandName.TasksListActive, { workspaceId: 'w2' })
      })
      await Promise.resolve()
      expect(store.getState().doneCounts.w2).toEqual({ all: 0 })
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

    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: null })

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
      fake.emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: null })
    }
    const store = createGladeStore(fake.bridge)

    await store.getState().hydrate()

    expect(selectSelectedTask(store.getState())).toEqual(sampleTask('t2', 'w2'))
    expect(store.getState().messages).toEqual({ t2: [message] })
    expect(fake.invoke.mock.calls.filter(([command]) => command === CommandName.TasksHistory)).toEqual([
      [CommandName.TasksHistory, { id: 't2' }],
    ])
  })

  it('with a subagent, also opens the Subagents tab of its workspace on that subagent, opening the panel', async () => {
    const { store, emit } = await hydrated(
      main([
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.RightPanelCollapsed, value: 'true' },
        { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'files', w2: 'todos' }) },
      ]),
    )

    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: 'toolu_kitten' })

    await vi.waitFor(() => {
      expect(store.getState().subagentFocus).toEqual({ taskId: 't2', subagentId: 'toolu_kitten', request: 1 })
    })
    expect(selectSelectedTask(store.getState())).toEqual(sampleTask('t2', 'w2'))
    expect(selectSelectedWorkspace(store.getState())).toEqual(sampleWorkspace('w2'))
    // The tab is that workspace's own (#436): the one you were looking at in w1 stays as it was.
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Subagents)
    expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Files)
    expect(store.getState().uiState).toMatchObject({ [UiStateKey.RightPanelCollapsed]: 'false' })

    // Asking for it again is a new request, so the tab shows it again.
    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: 'toolu_kitten' })
    await vi.waitFor(() => {
      expect(store.getState().subagentFocus?.request).toBe(2)
    })
  })

  it('without a subagent, leaves the panel as it is', async () => {
    const { store, emit } = await hydrated(
      main([
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w2: 'todos' }) },
      ]),
    )

    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: null })

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('t2')
    })
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Todos)
    expect(store.getState().subagentFocus).toBeNull()
  })

  it('with a subagent, shows it once loaded when it is asked for while the store loads', async () => {
    let emitDuringLoad = (): void => undefined
    const fake = fakeBridge(main([{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }]), {
      [CommandName.WorkspacesList]: () => {
        emitDuringLoad()
        return { workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')] }
      },
    })
    emitDuringLoad = () => {
      fake.emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: 'toolu_kitten' })
    }
    const store = createGladeStore(fake.bridge)

    await store.getState().hydrate()

    expect(selectSelectedTask(store.getState())).toEqual(sampleTask('t2', 'w2'))
    expect(store.getState().subagentFocus).toEqual({ taskId: 't2', subagentId: 'toolu_kitten', request: 1 })
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Subagents)
  })

  it('forgets the subagent asked for once its task is deleted', async () => {
    const { store, emit } = await hydrated(main([{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }]))
    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: 'toolu_kitten' })
    await vi.waitFor(() => {
      expect(store.getState().subagentFocus).not.toBeNull()
    })

    emit({ type: EventType.TaskDeleted, taskId: 't2' })

    expect(store.getState().subagentFocus).toBeNull()
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

  it('sends the card\'s "Anything else?" text with its answers, and the answered set keeps it', async () => {
    const data = { ...main(), questionSets: [sampleQuestionSet('s1', 't1')] }
    const { store, invoke } = await hydrated(data)
    await store.getState().loadHistory('t1')

    await store.getState().answerQuestions('s1', {}, 'None of these: ask me tomorrow.')

    expect(invoke).toHaveBeenLastCalledWith(CommandName.QuestionsAnswer, {
      id: 's1',
      answers: {},
      anythingElse: 'None of these: ask me tomorrow.',
    })
    expect(store.getState().questionSets.t1?.[0]?.reply).toEqual({
      kind: QuestionReplyKind.Answers,
      answers: {},
      anythingElse: 'None of these: ask me tomorrow.',
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
          kind: ArtifactKind.File,
          taskId: 't1',
          path: 'docs/notes.md',
          title: 'Notes',
          addedAt: 1,
          updatedAt: 1,
          modifiedAt: 1,
          missing: false,
        },
        { kind: ArtifactKind.Link, taskId: 't1', url: PR, title: '#412', addedAt: 1, updatedAt: 1 },
      ],
    }
    const { store } = await hydrated(data)

    await store.getState().copyText('glade://task/t1')
    await store.getState().stopSubagent('t1', 'toolu_02')
    expect(store.getState().watchers.t1?.map(({ state }) => state)).toEqual([WatcherState.Running])
    await store.getState().stopWatcher('t1', 'w1')
    await store.getState().removeArtifact('t1', { kind: ArtifactKind.File, path: 'docs/notes.md' })
    await store.getState().removeArtifact('t1', { kind: ArtifactKind.Link, url: PR })

    expect(data.copied).toEqual(['glade://task/t1'])
    expect(data.stoppedSubagents).toEqual(['toolu_02'])
    expect(data.stoppedWatchers).toEqual(['w1'])
    expect(store.getState().watchers.t1?.map(({ state }) => state)).toEqual([WatcherState.Stopped])
    expect(store.getState().artifacts.t1).toEqual([])
  })

  it('adds a link to a task’s artifacts through main, called what it says, once (#407)', async () => {
    const data: FakeMain = { ...main(), artifacts: [] }
    const { store } = await hydrated(data)

    await store.getState().addLinkArtifact('t1', PR, PR)
    await store.getState().addLinkArtifact('t1', PR, 'Navigation refresh')
    await store.getState().addLinkArtifact('t1', 'https://example.com/docs', 'The docs')

    expect(store.getState().artifacts.t1?.map(({ title }) => title)).toEqual(['#412', 'The docs'])
    await expect(store.getState().addLinkArtifact('t1', 'mailto:support@example.com', 'Support')).rejects.toMatchObject(
      {
        code: BridgeErrorCode.InvalidRequest,
      },
    )
  })

  it('shows a task’s artifact filter at once and remembers it through main (#407)', async () => {
    const data: FakeMain = { ...main(), artifactFilters: {} }
    const { store, invoke } = await hydrated(data)

    await store.getState().setArtifactFilter('t1', ArtifactFilter.Links)

    expect(store.getState().artifactFilters).toEqual({ t1: ArtifactFilter.Links })
    expect(data.artifactFilters).toEqual({ t1: ArtifactFilter.Links })
    expect(invoke).toHaveBeenCalledWith(CommandName.ArtifactsSetFilter, { taskId: 't1', filter: ArtifactFilter.Links })
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

    keep('t1', { text: 'Half a thought', images: [], pastedBlocks: [], files: [] })
    keep('t2', { text: '', images: [PNG], pastedBlocks: [], files: [] })
    keep('t1', { text: 'A whole thought', images: [], pastedBlocks: [], files: [] })
    expect(store.getState().inputDrafts).toEqual({
      t1: { text: 'A whole thought', images: [], pastedBlocks: [], files: [] },
      t2: { text: '', images: [PNG], pastedBlocks: [], files: [] },
    })
    keep('t1', { text: '', images: [], pastedBlocks: [], files: [] })
    expect(store.getState().inputDrafts).toEqual({ t2: { text: '', images: [PNG], pastedBlocks: [], files: [] } })
    expect(invoke.mock.calls).toHaveLength(calls)
  })

  it('loads a task’s stored draft from main, keeping it, when it has none kept', async () => {
    const data = {
      ...main(),
      drafts: { t1: { text: 'From before the relaunch', images: [PNG], pastedBlocks: [], files: [] } },
    }
    const { store, invoke } = await hydrated(data)

    await expect(store.getState().loadInputDraft('t1')).resolves.toEqual({
      text: 'From before the relaunch',
      images: [PNG],
      pastedBlocks: [],
      files: [],
    })
    expect(invoke).toHaveBeenCalledWith(CommandName.DraftsGet, { taskId: 't1' })
    expect(store.getState().inputDrafts).toEqual({
      t1: { text: 'From before the relaunch', images: [PNG], pastedBlocks: [], files: [] },
    })
    await expect(store.getState().loadInputDraft('t2')).resolves.toBeNull()
    expect(store.getState().inputDrafts).toEqual({
      t1: { text: 'From before the relaunch', images: [PNG], pastedBlocks: [], files: [] },
    })
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
    store.getState().keepInputDraft('t1', { text: 'Newer', images: [], pastedBlocks: [], files: [] })
    answer({ draft: { text: 'Older', images: [], pastedBlocks: [], files: [] } })
    await expect(loading).resolves.toEqual({ text: 'Older', images: [], pastedBlocks: [], files: [] })
    expect(store.getState().inputDrafts).toEqual({ t1: { text: 'Newer', images: [], pastedBlocks: [], files: [] } })

    const calls = fake.invoke.mock.calls.length
    await expect(store.getState().loadInputDraft('t1')).resolves.toEqual({
      text: 'Newer',
      images: [],
      pastedBlocks: [],
      files: [],
    })
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
    expect(drafts).toEqual({ t1: { text: 'Keep this', images: [GIF], pastedBlocks: [], files: [] } })

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
    expect(parsePanelTabSelection(store.getState().uiState[UiStateKey.RightPanelTabs])).toEqual({ w1: 'files' })
    expect(store.getState().uiState).toMatchObject({ [UiStateKey.RightPanelCollapsed]: 'false' })
  })
})

describe('openLink', () => {
  it('opens a link through main, which opens only web and mail links', async () => {
    const data: FakeMain = { ...main(), opened: [] }
    const { store } = await hydrated(data)

    await store.getState().openLink('https://example.com/docs')
    await expect(store.getState().openLink('javascript:alert(1)')).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidRequest,
    })

    expect(data.opened).toEqual(['https://example.com/docs'])
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

describe("a task's artifacts", () => {
  it("doesn't let a history load that started before an artifact was removed bring it back (#391)", async () => {
    const declared: Artifact = {
      kind: ArtifactKind.File,
      taskId: 't1',
      path: 'docs/notes.md',
      title: 'Notes',
      addedAt: 1,
      updatedAt: 1,
      modifiedAt: 1,
      missing: false,
    }
    const data: FakeMain = { ...main(), artifacts: [declared] }
    let resolveHistory: ((response: TasksHistoryResponse) => void) | undefined
    const fake = fakeBridge(data, {
      [CommandName.TasksHistory]: () =>
        new Promise<TasksHistoryResponse>((resolve) => {
          resolveHistory = resolve
        }),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()

    // The load starts while the artifact is still declared...
    const load = store.getState().loadHistory('t1')
    // ...but the Artifacts tab's own Remove (or the agent's `remove_artifact`) lands its `artifacts.changed` first.
    await store.getState().removeArtifact('t1', { kind: ArtifactKind.File, path: 'docs/notes.md' })
    expect(store.getState().artifacts.t1).toEqual([])

    // The load answers last, with the stale list it read before the removal.
    resolveHistory?.({
      messages: [],
      toolEvents: [],
      queuedMessages: [],
      questionSets: [],
      permissionRequests: [],
      permissionMarks: [],
      openFiles: noOpenFiles('t1'),
      todos: null,
      artifacts: [declared],
      artifactGroups: [],
      artifactFilter: ArtifactFilter.All,
      handoff: null,
      watchers: [],
      commits: [],
    })
    await load

    expect(store.getState().artifacts.t1).toEqual([])
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

  it('opens the right panel at Files when the agent shows a file of the selected task, and not for a task in another workspace', async () => {
    const { store, emit } = await hydrated(
      main([
        { key: UiStateKey.SelectedTaskId, value: 't1' },
        { key: UiStateKey.RightPanelCollapsed, value: 'true' },
      ]),
    )

    // t2 is in w2, and isn't the selected task: nothing changes, not even w2's own tab.
    emit({ type: EventType.FileShown, taskId: 't2', path: 'README.md', line: null })
    expect(store.getState().uiState[UiStateKey.RightPanelTabs]).toBeUndefined()
    expect(store.getState().fileFocus).toEqual({ taskId: 't2', path: 'README.md', line: null, request: 1 })

    emit({ type: EventType.FileShown, taskId: 't1', path: 'docs/rate-limits.md', line: 8 })
    expect(parsePanelTabSelection(store.getState().uiState[UiStateKey.RightPanelTabs])).toEqual({ w1: 'files' })
    expect(store.getState().uiState).toMatchObject({ [UiStateKey.RightPanelCollapsed]: 'false' })
    expect(store.getState().fileFocus).toEqual({ taskId: 't1', path: 'docs/rate-limits.md', line: 8, request: 2 })
  })

  it('ignores a request for the selected task once it is gone', async () => {
    const { store, emit } = await hydrated(main([{ key: UiStateKey.SelectedTaskId, value: 't1' }]))

    emit({ type: EventType.TaskDeleted, taskId: 't1' })
    expect(store.getState().tasks.t1).toBeUndefined()

    emit({ type: EventType.FileShown, taskId: 't1', path: 'README.md', line: null })

    expect(store.getState().uiState[UiStateKey.RightPanelTabs]).toBeUndefined()
  })
})

describe('right panel tab per workspace', () => {
  it("keeps each workspace's own tab, switching back and forth", async () => {
    const { store } = await hydrated()

    await store.getState().setUiState(panelTabEntry(store.getState().uiState, 'w1', PanelTab.Todos))
    await store.getState().openWorkspace('w2')
    // w2 has never chosen one: it starts from Tool calls, not w1's Todos.
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.ToolCalls)

    await store.getState().setUiState(panelTabEntry(store.getState().uiState, 'w2', PanelTab.Artifacts))
    await store.getState().openWorkspace('w1')

    expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Todos)
    await store.getState().openWorkspace('w2')
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Artifacts)
  })

  it('starts a workspace with no choice of its own from the tab stored before each workspace had one', async () => {
    const data = main([{ key: UiStateKey.RightPanelTab, value: 'subagents' }])
    const { store } = await hydrated(data)

    expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Subagents)
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Subagents)

    await store.getState().setUiState(panelTabEntry(store.getState().uiState, 'w1', PanelTab.Watchers))
    // w1 now has its own; w2 still starts from the old global value.
    expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.Watchers)
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Subagents)
  })

  it('survives a relaunch, keeping every workspace that chose one', async () => {
    const data = main()
    const { store } = await hydrated(data)
    await store.getState().setUiState(panelTabEntry(store.getState().uiState, 'w1', PanelTab.Todos))
    await store.getState().setUiState(panelTabEntry(store.getState().uiState, 'w2', PanelTab.Artifacts))

    // The window relaunches: a fresh store, hydrated from what main kept.
    const relaunched = createGladeStore(fakeBridge(data).bridge)
    await relaunched.getState().hydrate()

    expect(activePanelTab(relaunched.getState().uiState, 'w1')).toBe(PanelTab.Todos)
    expect(activePanelTab(relaunched.getState().uiState, 'w2')).toBe(PanelTab.Artifacts)
  })
})

describe('broadcast (#489)', () => {
  it('opens and closes its modal', async () => {
    const { store } = await hydrated()
    expect(store.getState().broadcastOpen).toBe(false)

    store.getState().openBroadcast()
    expect(store.getState().broadcastOpen).toBe(true)

    store.getState().closeBroadcast()
    expect(store.getState().broadcastOpen).toBe(false)
  })

  it('sends the message through main, which decides who gets it, and answers how it went for each task', async () => {
    const idle = [
      { ...sampleTask('t1', 'w1'), sessionId: 's1' },
      { ...sampleTask('t2', 'w2'), sessionId: 's2' },
    ]
    const working = { ...sampleTask('t3', 'w2'), activity: TaskActivity.Working }
    const done = { ...sampleTask('t4', 'w1'), state: TaskState.Done, pinned: true, sessionId: 's4' }
    // One that has never been given anything gets nothing.
    const untouched = sampleTask('t5', 'w1')
    const { store, invoke } = await hydrated({
      ...main(),
      tasks: [...idle, working, done, untouched],
      messages: [],
    })

    const recipients = await store.getState().broadcast('Is anyone restarting Docker?')

    expect(invoke).toHaveBeenCalledWith(CommandName.TasksBroadcast, { text: 'Is anyone restarting Docker?' })
    expect(recipients).toEqual([
      { taskId: 't1', delivery: 'sent' },
      { taskId: 't2', delivery: 'sent' },
      { taskId: 't3', delivery: 'queued' },
    ])
    const state = store.getState()
    expect(state.messages.t1).toMatchObject([{ body: 'Is anyone restarting Docker?', broadcast: true }])
    expect(state.messages.t2).toMatchObject([{ body: 'Is anyone restarting Docker?', broadcast: true }])
    expect(state.queuedMessages.t3).toMatchObject([{ body: 'Is anyone restarting Docker?', broadcast: true }])
    expect(state.messages.t4).toBeUndefined()
    expect(state.messages.t5).toBeUndefined()
  })

  it("rejects with main's error", async () => {
    const fake = fakeBridge(main(), {
      [CommandName.TasksBroadcast]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'tasks.broadcast failed')),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()

    await expect(store.getState().broadcast('Hi')).rejects.toMatchObject({ code: BridgeErrorCode.Internal })
  })
})

describe('a batch of events from main (#489)', () => {
  it('is applied in one change to the store, however many events it holds', async () => {
    const { store, emitBatch } = await hydrated()
    const changes = vi.fn()
    store.subscribe(changes)
    const message = (taskId: string) => ({ ...sampleMessage(`m-${taskId}`, taskId, 'Hi'), broadcast: true })

    emitBatch([
      { type: EventType.MessageAppended, message: message('t1') },
      { type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working } },
      { type: EventType.MessageAppended, message: message('t2') },
      { type: EventType.QueueChanged, taskId: 't2', queuedMessages: [sampleQueuedMessage('q1', 't2')] },
    ])

    expect(changes).toHaveBeenCalledOnce()
    const state = store.getState()
    expect(state.messages.t1).toEqual([message('t1')])
    expect(state.messages.t2).toEqual([message('t2')])
    expect(state.tasks.t1?.activity).toBe(TaskActivity.Working)
    expect(state.queuedMessages.t2).toEqual([sampleQueuedMessage('q1', 't2')])
  })

  it('applies its events in order, the later one winning', async () => {
    const { store, emitBatch } = await hydrated()

    emitBatch([
      { type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'First.' } },
      { type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Second.' } },
    ])

    expect(store.getState().tasks.t1?.status).toBe('Second.')
  })

  it('changes nothing for a batch of events the store only passes on', async () => {
    const { store, emitBatch } = await hydrated()
    const commands = vi.fn()
    store.getState().onCommand(commands)
    const changes = vi.fn()
    store.subscribe(changes)
    const command = { scope: CommandScope.App, id: AppCommandId.Broadcast } as const

    emitBatch([{ type: EventType.MenuCommand, command }])

    expect(commands).toHaveBeenCalledWith(command)
    expect(changes).not.toHaveBeenCalled()
  })

  it('waits with the rest while the store loads, and lands on top of the snapshot', async () => {
    const fake = fakeBridge(main())
    const store = createGladeStore(fake.bridge)
    const loading = store.getState().hydrate()

    fake.emitBatch([
      { type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'Changed while loading.' } },
    ])
    await loading

    expect(store.getState().tasks.t1?.status).toBe('Changed while loading.')
  })

  it('goes back to applying each event as it comes afterwards', async () => {
    const { store, emit, emitBatch } = await hydrated()
    emitBatch([{ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'In the batch.' } }])
    const changes = vi.fn()
    store.subscribe(changes)

    emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t1', 'w1'), status: 'On its own.' } })
    emit({ type: EventType.TaskUpdated, task: { ...sampleTask('t2', 'w2'), status: 'And another.' } })

    expect(changes).toHaveBeenCalledTimes(2)
    expect(store.getState().tasks.t1?.status).toBe('On its own.')
  })
})

describe('the todo hub (P16)', () => {
  const ON = { ...DEFAULT_SETTINGS, todoHubEnabled: true }
  const filing = (key: string, todoId: string, filedAt = 1): Filing => ({
    taskId: 't1',
    kind: ChildKind.File,
    key,
    todoId,
    source: FilingSource.Named,
    filedAt,
  })

  it('loads a task’s filings and its todos’ panels', async () => {
    const panel = { taskId: 't1', todoId: '2', open: true, filter: ChildFilter.Files }
    const other = { taskId: 't2', todoId: '2', open: true, filter: ChildFilter.All }
    const data: FakeMain = {
      ...main(),
      settings: ON,
      filings: [filing('docs/plan.md', '2'), { ...filing('docs/other.md', '1'), taskId: 't2' }],
      todoPanels: [panel, other],
      todoHubReads: [],
    }
    const { store } = await hydrated(data)

    await store.getState().loadTodoHub('t1')

    expect(store.getState().filings).toEqual({ t1: [filing('docs/plan.md', '2')] })
    expect(store.getState().todoPanels).toEqual({ t1: { '2': panel } })
    expect(data.todoHubReads).toEqual(['t1'])
  })

  it('fails to load while the hub is off, keeping nothing', async () => {
    const { store } = await hydrated()
    await expect(store.getState().loadTodoHub('t1')).rejects.toMatchObject({ message: TODO_HUB_OFF })
    expect(store.getState().filings).toEqual({})
  })

  it('reads again when a filing lands while it loads, so the change is never lost to an answer made before it', async () => {
    const data: FakeMain = { ...main(), settings: ON, filings: [filing('docs/plan.md', '1')], todoHubReads: [] }
    const { store, emit } = await hydrated(data)
    const late = filing('docs/late.md', '2', 9)

    const loading = store.getState().loadTodoHub('t1')
    // Main filed another child after it read the task's filings, and its event overtook the answer.
    emit({ type: EventType.FilingsChanged, taskId: 't1', filed: [late], removed: [] })
    data.filings = [...(data.filings ?? []), late]
    await loading

    expect(data.todoHubReads).toEqual(['t1', 't1'])
    expect(store.getState().filings.t1).toEqual([filing('docs/plan.md', '1'), late])
  })

  it('keeps a loaded task’s filings current from the events alone', async () => {
    const { store, emit } = await hydrated({ ...main(), settings: ON, filings: [filing('docs/plan.md', '1')] })
    await store.getState().loadTodoHub('t1')

    emit({ type: EventType.FilingsChanged, taskId: 't1', filed: [filing('docs/plan.md', '3', 4)], removed: [] })

    expect(store.getState().filings.t1).toEqual([filing('docs/plan.md', '3', 4)])
  })

  it('opens, closes and filters a todo’s panel at once, and has main remember it', async () => {
    const data: FakeMain = { ...main(), settings: ON, todoPanels: [] }
    const { store, invoke } = await hydrated(data)
    await store.getState().loadTodoHub('t1')
    const opened = { taskId: 't1', todoId: '4', open: true, filter: ChildFilter.Watchers }
    const group = { taskId: 't1', todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.All }

    const opening = store.getState().setTodoPanel(opened)
    // Before main answers.
    expect(store.getState().todoPanels.t1).toEqual({ '4': opened })
    await opening
    await store.getState().setTodoPanel(group)
    await store.getState().setTodoPanel({ ...opened, open: false })

    expect(invoke).toHaveBeenLastCalledWith(CommandName.TodoHubSetPanel, { ...opened, open: false })
    expect(store.getState().todoPanels.t1).toEqual({ '4': { ...opened, open: false }, [UNFILED_TODO_ID]: group })
    expect(data.todoPanels).toEqual([{ ...opened, open: false }, group])
    // Another task's panels are its own.
    await store.getState().setTodoPanel({ ...opened, taskId: 't2' })
    expect(store.getState().todoPanels.t2).toEqual({ '4': { ...opened, taskId: 't2' } })
    expect(Object.keys(store.getState().todoPanels.t1 ?? {})).toHaveLength(2)
  })

  it('shows a todo’s panel as you set it even when main can’t remember it', async () => {
    const { store } = await hydrated()
    const opened = { taskId: 't1', todoId: '4', open: true, filter: ChildFilter.All }
    await expect(store.getState().setTodoPanel(opened)).rejects.toMatchObject({ message: TODO_HUB_OFF })
    expect(store.getState().todoPanels.t1).toEqual({ '4': opened })
  })
})
