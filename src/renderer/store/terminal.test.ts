import { describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { UiStateKey, type UiStateEntry } from '../../shared/domain'
import type { TerminalTab } from '../../shared/terminal'
import { activeTerminalTab } from '../terminal/terminalModel'
import { createGladeStore, type GladeStore } from './store'
import { fakeBridge, sampleTerminalTab, sampleWorkspace, type FakeBridge, type FakeHandlers } from './test-bridge'

interface Loaded {
  readonly store: GladeStore
  readonly fake: FakeBridge
  readonly tabs: TerminalTab[]
  readonly calls: string[]
}

async function load(
  tabs: TerminalTab[] = [],
  uiState: UiStateEntry[] = [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }],
  overrides: Partial<FakeHandlers> = {},
): Promise<Loaded> {
  const calls: string[] = []
  const fake = fakeBridge(
    { workspaces: [sampleWorkspace('w1')], tasks: [], uiState, terminalTabs: tabs, terminalCalls: calls },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await store.getState().hydrate()
  return { store, fake, tabs, calls }
}

/** A tab of the workspace `w1`, which the window shows. */
function tab(id: string, overrides: Partial<TerminalTab> = {}): TerminalTab {
  return sampleTerminalTab(id, { workspaceId: 'w1', cwd: '/code/w1', ...overrides })
}

/** Which tab each workspace's bottom bar shows, as its UI state. */
function picked(selection: Record<string, string>): UiStateEntry {
  return { key: UiStateKey.TerminalSelection, value: JSON.stringify(selection) }
}

function shown(store: GladeStore): string | undefined {
  const { terminalTabs, uiState, selectedWorkspaceId } = store.getState()
  return activeTerminalTab(terminalTabs, uiState, selectedWorkspaceId)?.id
}

function ids(store: GladeStore): string[] {
  return store.getState().terminalTabs.map(({ id }) => id)
}

describe('the terminal tabs in the store', () => {
  it('loads the tabs with the rest of main’s state', async () => {
    const { store } = await load([tab('a'), tab('b')])

    expect(ids(store)).toEqual(['a', 'b'])
    expect(shown(store)).toBe('a')
  })

  it('adds a tab in the workspace’s root, shows it with the focus, and opens the collapsed bottom bar', async () => {
    const { store } = await load(
      [tab('a')],
      [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.BottomBarCollapsed, value: 'true' },
      ],
    )

    const created = await store.getState().createTerminal()

    expect(created).toMatchObject({ id: 'term-1', workspaceId: 'w1', cwd: '/code/w1' })
    expect(ids(store)).toEqual(['a', 'term-1'])
    expect(shown(store)).toBe('term-1')
    expect(store.getState().uiState[UiStateKey.BottomBarCollapsed]).toBe('false')
    expect(store.getState().terminalFocusRequest).toBe(1)
  })

  it('adds a tab from main’s answer when its broadcast hasn’t come', async () => {
    const quiet = tab('quiet', { cwd: '/Users/sample' })
    const { store, fake } = await load([], [], { [CommandName.TerminalCreate]: () => ({ tab: quiet }) })

    await store.getState().createTerminal()

    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TerminalCreate, { workspaceId: 'w1' })
    expect(store.getState().terminalTabs).toEqual([quiet])
  })

  it('shows the tab you pick, with the focus in it', async () => {
    const { store } = await load([tab('a'), tab('b')])

    await store.getState().selectTerminal('b')

    expect(shown(store)).toBe('b')
    expect(store.getState().terminalFocusRequest).toBe(1)
  })

  it('goes round the tabs, forwards and back', async () => {
    const { store } = await load([tab('a'), tab('b'), tab('c')])

    await store.getState().cycleTerminal(-1)
    expect(shown(store)).toBe('c')
    await store.getState().cycleTerminal(1)
    expect(shown(store)).toBe('a')
    expect(store.getState().terminalFocusRequest).toBe(2)
  })

  it('goes nowhere with one tab, or none', async () => {
    const { store } = await load([tab('a')])
    await store.getState().cycleTerminal(1)
    expect(store.getState().terminalFocusRequest).toBe(0)

    const empty = await load()
    await empty.store.getState().cycleTerminal(1)
    expect(empty.store.getState().terminalFocusRequest).toBe(0)
  })

  it('duplicates a tab after it, and shows the copy', async () => {
    const { store } = await load([tab('a', { name: 'server' }), tab('b')])

    await store.getState().duplicateTerminal('a')

    expect(ids(store)).toEqual(['a', 'term-1', 'b'])
    expect(store.getState().terminalTabs[1]?.name).toBe('server')
    expect(shown(store)).toBe('term-1')
  })

  it('closes the tab showing and shows the next, or the one before when it was last', async () => {
    const { store } = await load([tab('a'), tab('b'), tab('c')], [picked({ w1: 'b' })])

    await store.getState().closeTerminal('b')
    expect(ids(store)).toEqual(['a', 'c'])
    expect(shown(store)).toBe('c')
    await store.getState().closeTerminal('c')
    expect(shown(store)).toBe('a')
    expect(store.getState().terminalFocusRequest).toBe(2)

    await store.getState().closeTerminal('a')
    expect(ids(store)).toEqual([])
    expect(store.getState().terminalFocusRequest).toBe(2)
  })

  it('closes another tab without changing the one showing, even before main’s broadcast', async () => {
    const { store } = await load([tab('a'), tab('b')], [], {
      [CommandName.TerminalClose]: () => null,
    })

    await store.getState().closeTerminal('b')

    expect(ids(store)).toEqual(['a'])
    expect(shown(store)).toBe('a')
    expect(store.getState().terminalFocusRequest).toBe(0)
  })

  it('renames a tab, refusing a blank name and leaving an unchanged one alone', async () => {
    const { store, fake } = await load([tab('a', { name: 'server' })])
    store.getState().startTerminalRename('a')
    expect(store.getState().renamingTerminalId).toBe('a')

    expect(await store.getState().renameTerminal('a', '  ')).toBe(false)
    expect(store.getState().renamingTerminalId).toBe('a')
    expect(await store.getState().renameTerminal('a', ' server ')).toBe(true)
    expect(fake.invoke).not.toHaveBeenCalledWith(CommandName.TerminalRename, expect.anything())
    expect(store.getState().renamingTerminalId).toBeNull()

    expect(await store.getState().renameTerminal('a', 'api ')).toBe(true)
    expect(store.getState().terminalTabs[0]?.name).toBe('api')
  })

  it('stops renaming when asked, or when the tab goes', async () => {
    const { store, fake } = await load([tab('a'), tab('b')])
    store.getState().startTerminalRename('a')
    store.getState().cancelTerminalRename()
    expect(store.getState().renamingTerminalId).toBeNull()

    store.getState().startTerminalRename('b')
    fake.emit({ type: EventType.TerminalTabsChanged, tabs: [tab('b', { running: true })] })
    expect(store.getState().renamingTerminalId).toBe('b')
    fake.emit({ type: EventType.TerminalTabsChanged, tabs: [] })
    expect(store.getState().renamingTerminalId).toBeNull()
  })

  it('attaches, types into, resizes, clears and interrupts a tab’s shell through main', async () => {
    const { store, calls } = await load([tab('a')])

    expect(await store.getState().attachTerminal('a', { cols: 80, rows: 24 })).toEqual({ output: '', end: 0 })
    await store.getState().writeTerminal('a', 'ls')
    await store.getState().resizeTerminal('a', { cols: 100, rows: 30 })
    await store.getState().clearTerminal('a')
    await store.getState().interruptTerminal('a')

    expect(calls).toEqual(['attach a 80x24', 'write a ls', 'resize a 100x30', 'clear a', 'interrupt a'])
  })

  it('hands a tab’s output and clearing straight to its terminals, and to no one else’s', async () => {
    const { store, fake } = await load([tab('a'), tab('b')])
    const heard = vi.fn()
    const alsoHeard = vi.fn()
    const unsubscribe = store.getState().subscribeTerminal('a', heard)
    const unsubscribeToo = store.getState().subscribeTerminal('a', alsoHeard)

    const output = { type: EventType.TerminalOutput, tabId: 'a', offset: 0, data: '$ ' } as const
    fake.emit(output)
    fake.emit({ type: EventType.TerminalOutput, tabId: 'b', offset: 0, data: 'other' })
    fake.emit({ type: EventType.TerminalCleared, tabId: 'a' })
    unsubscribe()
    fake.emit(output)
    unsubscribeToo()
    fake.emit(output)

    expect(heard.mock.calls).toEqual([[output], [{ type: EventType.TerminalCleared, tabId: 'a' }]])
    expect(alsoHeard).toHaveBeenCalledTimes(3)
  })

  it('focuses the terminal, opening the bottom bar, and adds a tab when there’s none', async () => {
    const { store } = await load([], [{ key: UiStateKey.BottomBarCollapsed, value: 'true' }])

    await store.getState().focusTerminal()
    expect(ids(store)).toEqual(['term-1'])
    expect(store.getState().uiState[UiStateKey.BottomBarCollapsed]).toBe('false')
    await store.getState().setUiState({ key: UiStateKey.BottomBarCollapsed, value: 'true' })
    await store.getState().focusTerminal()

    expect(ids(store)).toEqual(['term-1'])
    expect(store.getState().uiState[UiStateKey.BottomBarCollapsed]).toBe('false')
    expect(store.getState().terminalFocusRequest).toBe(2)
  })

  it('puts a command at the prompt of the tab showing, without its line break, until the terminal takes it', async () => {
    const { store } = await load(
      [tab('a'), tab('b')],
      [picked({ w1: 'b' }), { key: UiStateKey.BottomBarCollapsed, value: 'true' }],
    )

    await store.getState().runInTerminal('npm test\n')
    expect(store.getState().terminalPaste).toEqual({ tabId: 'b', text: 'npm test', request: 1 })
    expect(store.getState().uiState[UiStateKey.BottomBarCollapsed]).toBe('false')
    await store.getState().runInTerminal('npm run build')
    store.getState().takeTerminalPaste(1)
    expect(store.getState().terminalPaste?.request).toBe(2)
    store.getState().takeTerminalPaste(2)

    expect(store.getState().terminalPaste).toBeNull()
  })

  it('puts a command in a new tab when there’s none', async () => {
    const { store } = await load()

    await store.getState().runInTerminal('npm test')

    expect(store.getState().terminalPaste).toEqual({ tabId: 'term-1', text: 'npm test', request: 1 })
  })
})

describe('each workspace’s terminal tabs', () => {
  const api = sampleWorkspace('w1', 'Acme API')
  const web = sampleWorkspace('w2', 'Acme Web')

  /** A store showing `w1`, with two tabs in it, two in `w2` and one of the window with no workspace. */
  async function loadTwo(
    uiState: UiStateEntry[] = [],
    overrides: Partial<FakeHandlers> = {},
  ): Promise<{ store: GladeStore; fake: FakeBridge }> {
    const fake = fakeBridge(
      {
        workspaces: [api, web],
        tasks: [],
        uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }, ...uiState],
        terminalTabs: [
          tab('a1'),
          sampleTerminalTab('w1', { workspaceId: 'w2', cwd: '/code/w2' }),
          tab('a2'),
          sampleTerminalTab('w2', { workspaceId: 'w2', cwd: '/code/w2' }),
          sampleTerminalTab('none'),
        ],
      },
      overrides,
    )
    const store = createGladeStore(fake.bridge)
    await store.getState().hydrate()
    return { store, fake }
  }

  it('shows the workspace’s own tabs, and the one last picked in each as you switch', async () => {
    const { store } = await loadTwo([picked({ w1: 'a2', w2: 'w2' })])
    expect(shown(store)).toBe('a2')

    await store.getState().openWorkspace('w2')
    expect(shown(store)).toBe('w2')
    await store.getState().selectTerminal('w1')
    expect(shown(store)).toBe('w1')

    await store.getState().openWorkspace('w1')
    expect(shown(store)).toBe('a2')
    await store.getState().openWorkspace('w2')
    expect(shown(store)).toBe('w1')
    expect(JSON.parse(store.getState().uiState[UiStateKey.TerminalSelection] ?? '')).toEqual({ w1: 'a2', w2: 'w1' })
  })

  it('never shows another workspace’s tab, even one picked for it: its own first shows instead', async () => {
    const { store } = await loadTwo([picked({ w1: 'w2' })])

    expect(shown(store)).toBe('a1')
  })

  it('adds a tab to the workspace showing, and picks it there alone', async () => {
    const { store, fake } = await loadTwo([picked({ w1: 'a1', w2: 'w2' })])
    await store.getState().openWorkspace('w2')

    const created = await store.getState().createTerminal()

    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TerminalCreate, { workspaceId: 'w2' })
    expect(created.workspaceId).toBe('w2')
    expect(shown(store)).toBe(created.id)
    await store.getState().openWorkspace('w1')
    expect(shown(store)).toBe('a1')
  })

  it('goes round only the workspace’s tabs', async () => {
    const { store } = await loadTwo()

    await store.getState().cycleTerminal(1)
    expect(shown(store)).toBe('a2')
    await store.getState().cycleTerminal(1)
    expect(shown(store)).toBe('a1')
  })

  it('closes the tab showing and shows the workspace’s next, never another workspace’s', async () => {
    const { store } = await loadTwo([picked({ w1: 'a2' })])

    await store.getState().closeTerminal('a2')
    expect(shown(store)).toBe('a1')
    await store.getState().closeTerminal('a1')
    expect(shown(store)).toBeUndefined()
    expect(ids(store)).toEqual(['w1', 'w2', 'none'])
  })

  it('opens a tab for ⌃` and Run again in terminal when the workspace showing has none, though others do', async () => {
    const { store } = await loadTwo()
    await store.getState().closeTerminal('a1')
    await store.getState().closeTerminal('a2')

    await store.getState().focusTerminal()
    expect(shown(store)).toBe('term-1')
    await store.getState().closeTerminal('term-1')
    await store.getState().runInTerminal('npm test')

    expect(store.getState().terminalPaste).toEqual({ tabId: 'term-2', text: 'npm test', request: 1 })
    expect(store.getState().terminalTabs.find(({ id }) => id === 'term-2')?.workspaceId).toBe('w1')
  })

  it('shows the tabs of none, and picks among them, with no workspace showing', async () => {
    const { store } = await loadTwo()

    await store.getState().removeWorkspace('w2')
    await store.getState().closeWorkspace('w1')

    expect(store.getState().selectedWorkspaceId).toBeNull()
    expect(shown(store)).toBe('none')
    await store.getState().createTerminal()
    expect(ids(store)).toEqual(['none', 'term-1'])
    expect(store.getState().terminalTabs[1]?.workspaceId).toBeNull()
    expect(shown(store)).toBe('term-1')
  })

  it('picks a tab main hasn’t told the window of in the workspace showing', async () => {
    const { store } = await loadTwo()

    await store.getState().selectTerminal('unheard')

    expect(JSON.parse(store.getState().uiState[UiStateKey.TerminalSelection] ?? '')).toEqual({ w1: 'unheard' })
  })

  it('ends a workspace’s shells when you close it, and forgets its pick, leaving the others’', async () => {
    const { store, fake } = await loadTwo([picked({ w1: 'a2', w2: 'w2' })])
    await store.getState().openWorkspace('w2')

    await store.getState().closeWorkspace('w2')

    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TerminalClose, { id: 'w1' })
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TerminalClose, { id: 'w2' })
    expect(ids(store)).toEqual(['a1', 'a2', 'none'])
    expect(store.getState().selectedWorkspaceId).toBe('w1')
    expect(shown(store)).toBe('a2')
    expect(JSON.parse(store.getState().uiState[UiStateKey.TerminalSelection] ?? '')).toEqual({ w1: 'a2' })
  })

  it('closes no tabs for a workspace that isn’t showing', async () => {
    const { store, fake } = await loadTwo()

    await store.getState().closeWorkspace('w2')

    expect(fake.invoke).not.toHaveBeenCalledWith(CommandName.TerminalClose, expect.anything())
    expect(ids(store)).toHaveLength(5)
  })

  it('drops a removed workspace’s tabs and its pick, and shows none’s once the last goes', async () => {
    const { store } = await loadTwo([picked({ w1: 'a1', w2: 'w2' })])

    await store.getState().removeWorkspace('w2')
    expect(ids(store)).toEqual(['a1', 'a2', 'none'])
    expect(JSON.parse(store.getState().uiState[UiStateKey.TerminalSelection] ?? '')).toEqual({ w1: 'a1' })

    await store.getState().removeWorkspace('w1')
    expect(ids(store)).toEqual(['none'])
    expect(shown(store)).toBe('none')
  })

  it('drops a removed workspace’s tabs even before main’s broadcast', async () => {
    const { store } = await loadTwo([], { [CommandName.WorkspacesRemove]: () => null })

    await store.getState().removeWorkspace('w2')

    expect(ids(store)).toEqual(['a1', 'a2', 'none'])
    expect(shown(store)).toBe('a1')
  })
})
