// The store's side of the Agents tab (P16, #536): which agent's tab each task is on, remembered through main, and what
// pointed at the Tool calls and Subagents tabs pointing at Agents while the todo hub's hidden switch is on.
import { describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { UiStateKey } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { TODO_HUB_OFF } from '../../shared/todoHub'
import { activePanelTab, PanelTab } from '../right-panel/panelModel'
import { withAgentTab } from './reducer'
import { createGladeStore } from './store'
import { fakeBridge, refuse, sampleTask, sampleWorkspace, type FakeMain } from './test-bridge'

const HUB_ON = { ...DEFAULT_SETTINGS, todoHubEnabled: true }

function main(extra: Partial<FakeMain> = {}): FakeMain {
  return {
    workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
    tasks: [sampleTask('t1', 'w1'), sampleTask('t2', 'w2')],
    uiState: [
      { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
      { key: UiStateKey.SelectedTaskId, value: 't1' },
    ],
    settings: HUB_ON,
    agentTabs: {},
    ...extra,
  }
}

async function hydrated(data = main()) {
  const fake = fakeBridge(data)
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  return { ...fake, store, data }
}

const setTabs = (invoke: Awaited<ReturnType<typeof hydrated>>['invoke']): unknown[] =>
  invoke.mock.calls.filter(([command]) => command === CommandName.AgentsSetTab).map(([, request]) => request)

describe('withAgentTab', () => {
  it('keeps a subagent’s tab by task, Main as no entry, and the same object when nothing changes', () => {
    const none = {}
    const one = withAgentTab(none, 't1', 'fix-501')
    expect(one).toEqual({ t1: 'fix-501' })
    expect(withAgentTab(one, 't1', 'fix-501')).toBe(one)
    expect(withAgentTab(one, 't1', undefined)).toBe(one)
    expect(withAgentTab(one, 't2', null)).toBe(one)
    expect(withAgentTab(one, 't2', 'docs-503')).toEqual({ t1: 'fix-501', t2: 'docs-503' })
    expect(withAgentTab(one, 't1', 'docs-503')).toEqual({ t1: 'docs-503' })
    expect(withAgentTab(one, 't1', null)).toEqual({})
  })
})

describe('selectAgentTab', () => {
  it('picks a task’s agent at once and has main remember it, Main forgetting it', async () => {
    const { store, invoke, data } = await hydrated()

    await store.getState().selectAgentTab('t1', 'fix-501')
    await store.getState().selectAgentTab('t2', 'docs-503')
    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501', t2: 'docs-503' })
    expect(data.agentTabs).toEqual({ t1: 'fix-501', t2: 'docs-503' })

    // The one it's on already: nothing to tell main.
    await store.getState().selectAgentTab('t1', 'fix-501')
    await store.getState().selectAgentTab('t1', null)
    await store.getState().selectAgentTab('t1', null)

    expect(store.getState().agentTabs).toEqual({ t2: 'docs-503' })
    expect(data.agentTabs).toEqual({ t2: 'docs-503' })
    expect(setTabs(invoke)).toEqual([
      { taskId: 't1', agentId: 'fix-501' },
      { taskId: 't2', agentId: 'docs-503' },
      { taskId: 't1', agentId: null },
    ])
  })

  it('shows the agent picked even when main refuses, rejecting with its error', async () => {
    const failure = bridgeError(BridgeErrorCode.Internal, 'agents.setTab failed: disk full')
    const fake = fakeBridge(main(), { [CommandName.AgentsSetTab]: () => refuse(failure) })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()

    await expect(store.getState().selectAgentTab('t1', 'fix-501')).rejects.toEqual(failure)

    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501' })
  })

  it('is refused by main while the todo hub is off, as every hub command is', async () => {
    const { store } = await hydrated(main({ settings: DEFAULT_SETTINGS }))

    await expect(store.getState().selectAgentTab('t1', 'fix-501')).rejects.toMatchObject({
      code: BridgeErrorCode.InvalidTransition,
      message: TODO_HUB_OFF,
    })
  })
})

describe('the agent a task was left on', () => {
  it('loads with the task’s logs, and is there again after a relaunch', async () => {
    const data = main({ agentTabs: { t1: 'fix-501' } })
    const { store } = await hydrated(data)
    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501' })

    await store.getState().selectAgentTab('t1', 'docs-503')
    await store.getState().selectTask('t2')
    await store.getState().selectAgentTab('t2', 'limits-502')

    // A new window on the same main: each task comes back on its own.
    const relaunched = createGladeStore(fakeBridge(data).bridge)
    await relaunched.getState().hydrate()
    expect(relaunched.getState().agentTabs).toEqual({ t2: 'limits-502' })
    await relaunched.getState().selectTask('t1')
    expect(relaunched.getState().agentTabs).toEqual({ t1: 'docs-503', t2: 'limits-502' })
  })

  it('is Main when main has none for it, whatever the window had', async () => {
    const data = main({ agentTabs: { t1: 'fix-501' } })
    const { store } = await hydrated(data)
    Reflect.deleteProperty(data.agentTabs ?? {}, 't1')

    await store.getState().loadHistory('t1')

    expect(store.getState().agentTabs).toEqual({})
  })

  it('isn’t read at all while the todo hub is off', async () => {
    const { store } = await hydrated(main({ settings: DEFAULT_SETTINGS, agentTabs: { t1: 'fix-501' } }))

    expect(store.getState().agentTabs).toEqual({})
  })

  it('is forgotten with its task, and so is a todo asked for', async () => {
    const { store, emit } = await hydrated()
    await store.getState().selectAgentTab('t1', 'fix-501')
    store.getState().showTodo('t1', '2')
    expect(store.getState().todoFocus).not.toBeNull()

    emit({ type: EventType.TaskDeleted, taskId: 't2' })
    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501' })
    expect(store.getState().todoFocus).not.toBeNull()
    emit({ type: EventType.TaskDeleted, taskId: 't1' })

    expect(store.getState().agentTabs).toEqual({})
    expect(store.getState().todoFocus).toBeNull()
  })
})

describe('what pointed at the old tabs, with the todo hub on', () => {
  it('shows a turn on Main’s tab of the Agents tab, opening the panel there', async () => {
    const { store, invoke } = await hydrated(
      main({
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
          { key: UiStateKey.RightPanelCollapsed, value: 'true' },
          { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'files' }) },
        ],
        agentTabs: { t1: 'fix-501' },
      }),
    )

    store.getState().focusTurn('t1', 2)

    expect(store.getState().toolLogFocus).toEqual({ taskId: 't1', turn: 2, request: 1 })
    expect(store.getState().agentTabs).toEqual({})
    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Agents)
    expect(store.getState().uiState).toMatchObject({ [UiStateKey.RightPanelCollapsed]: 'false' })
    await vi.waitFor(() => {
      expect(setTabs(invoke)).toEqual([{ taskId: 't1', agentId: null }])
    })
  })

  it('leaves the panel as it is for a turn of a task that isn’t the one showing, but puts that task on Main', async () => {
    const { store } = await hydrated(
      main({
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
          { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'files', w2: 'todos' }) },
        ],
      }),
    )
    await store.getState().selectAgentTab('t2', 'docs-503')

    store.getState().focusTurn('t2', 1)

    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Files)
    expect(activePanelTab(store.getState().uiState, 'w2', true)).toBe(PanelTab.Todos)
    expect(store.getState().agentTabs).toEqual({})
  })

  it('writes no tab for a workspace already on Agents, by name or because its tab is one the hub replaced', async () => {
    const { store, invoke } = await hydrated(
      main({
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
          { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'subagents' }) },
        ],
      }),
    )
    const writes = (): number => invoke.mock.calls.filter(([command]) => command === CommandName.UiStateSet).length
    const before = writes()

    store.getState().showAgent('t1', 'fix-501')

    expect(writes()).toBe(before)
    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Agents)
    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501' })
  })

  it('opens a task a plugin asks for on its subagent’s tab of the Agents tab, in the task’s own workspace', async () => {
    const { store, emit, invoke } = await hydrated(
      main({
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.RightPanelCollapsed, value: 'true' },
          { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'files', w2: 'todos' }) },
        ],
      }),
    )

    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: 'toolu_kitten' })

    await vi.waitFor(() => {
      expect(store.getState().agentTabs).toEqual({ t2: 'toolu_kitten' })
    })
    expect(store.getState().selectedTaskId).toBe('t2')
    expect(activePanelTab(store.getState().uiState, 'w2', true)).toBe(PanelTab.Agents)
    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Files)
    expect(store.getState().uiState).toMatchObject({ [UiStateKey.RightPanelCollapsed]: 'false' })
    // The Subagents tab isn't asked for anything: it isn't shown.
    expect(store.getState().subagentFocus).toBeNull()
    await vi.waitFor(() => {
      expect(setTabs(invoke)).toEqual([{ taskId: 't2', agentId: 'toolu_kitten' }])
    })
  })

  it('opens a task a plugin asks for without a subagent on the agent it was left on', async () => {
    const { store, emit } = await hydrated(main({ agentTabs: { t2: 'docs-503' } }))

    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: null })

    await vi.waitFor(() => {
      expect(store.getState().agentTabs).toEqual({ t2: 'docs-503' })
    })
    expect(store.getState().selectedTaskId).toBe('t2')
  })

  it('still shows the agent when main can’t remember it', async () => {
    const fake = fakeBridge(main(), {
      [CommandName.AgentsSetTab]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'disk full')),
    })
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()

    store.getState().showAgent('t1', 'fix-501')
    await Promise.resolve()

    expect(store.getState().agentTabs).toEqual({ t1: 'fix-501' })
    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Agents)
  })
})

describe('with the todo hub off', () => {
  it('shows a turn in the Tool calls tab, and a subagent in the Subagents tab, as ever', async () => {
    const { store, emit, invoke } = await hydrated(
      main({
        settings: DEFAULT_SETTINGS,
        uiState: [
          { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
          { key: UiStateKey.SelectedTaskId, value: 't1' },
          { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'files' }) },
        ],
      }),
    )

    store.getState().focusTurn('t1', 2)
    expect(activePanelTab(store.getState().uiState, 'w1')).toBe(PanelTab.ToolCalls)

    emit({ type: EventType.TaskOpenRequested, taskId: 't2', subagentId: 'toolu_kitten' })
    await vi.waitFor(() => {
      expect(store.getState().subagentFocus).toEqual({ taskId: 't2', subagentId: 'toolu_kitten', request: 1 })
    })
    expect(activePanelTab(store.getState().uiState, 'w2')).toBe(PanelTab.Subagents)
    expect(store.getState().agentTabs).toEqual({})
    expect(setTabs(invoke)).toEqual([])
  })
})

describe('showTodo', () => {
  it('opens the Todos tab for the task showing and asks the hub for the todo, as a new request each time', async () => {
    const { store } = await hydrated()
    expect(store.getState().todoFocus).toBeNull()

    store.getState().showTodo('t1', '2')
    expect(store.getState().todoFocus).toEqual({ taskId: 't1', todoId: '2', request: 1 })
    expect(activePanelTab(store.getState().uiState, 'w1', true)).toBe(PanelTab.Todos)

    store.getState().showTodo('t1', '2')
    expect(store.getState().todoFocus?.request).toBe(2)
  })
})
