// The todo hub's subagents, watchers and commits under their todos (#499): what a subagent made as tiles of its own
// beside it, many subagents under one todo, a subagent under no todo, and showing a subagent a plugin opens.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TodoState, ToolCallState, UiStateKey, WatcherKind } from '../../shared/domain'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { ChildFilter, UNFILED_TODO_ID } from '../../shared/todoHub'
import { TaskPanel } from '../right-panel/TaskPanel'
import { useGladeStore } from '../store/react'
import { refuse, type FakeHandlers } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import type { SubagentShown } from '../subagents'
import {
  HUB_NOW,
  HubForTask,
  hubAgent,
  hubCommit,
  hubFiling,
  hubMain,
  hubTodo,
  hubWatcher,
  minutesAgo,
  refOf,
  type HubStore,
  type HubTask,
} from './test-hub'
import { TodoHub } from './TodoHub'
import { UNFILED_HEADING } from './todoHubModel'

/** The hub for task `t1`, asked to show a subagent as the right panel asks it. */
function HubShowing({
  focus,
  onShown,
}: {
  readonly focus: SubagentShown | null
  readonly onShown: () => void
}): React.JSX.Element {
  const list = useGladeStore((state) => state.todos.t1)
  return <TodoHub taskId="t1" list={list} focus={focus} onFocusShown={onShown} />
}

async function hubStore(task: HubTask, overrides: Partial<FakeHandlers> = {}): Promise<HubStore> {
  const main = { ...hubMain(task), stoppedWatchers: [] }
  const wrapper = storeWrapper(main, overrides)
  await act(() => wrapper.store.getState().hydrate())
  return { ...wrapper, main }
}

async function renderHub(task: HubTask, overrides: Partial<FakeHandlers> = {}): Promise<HubStore> {
  const store = await hubStore(task, overrides)
  render(<HubForTask />, { wrapper: store.wrapper })
  await waitFor(() => {
    expect(store.store.getState().filings.t1).toBeDefined()
  })
  return store
}

function card(text: string): HTMLElement {
  const found = [...screen.getByRole('list', { name: 'Todos' }).querySelectorAll<HTMLElement>(':scope > li')].find(
    (each) => (each.querySelector('[data-todo-head]')?.textContent ?? '').includes(text),
  )
  if (found === undefined) throw new Error(`No card says ${text}`)
  return found
}

function head(text: string): HTMLElement {
  const found = card(text).querySelector<HTMLElement>('[data-todo-head]')
  if (found === null) throw new Error(`The card that says ${text} has no head`)
  return found
}

function kinds(text: string): string[] {
  return within(card(text))
    .queryAllByRole('button')
    .filter((button) => button.hasAttribute('data-kind'))
    .map((button) => button.getAttribute('aria-label') ?? '')
}

function tiles(within_: HTMLElement): string[] {
  return [...within_.querySelectorAll('[role="group"][data-kind]')].map((tile) => tile.getAttribute('aria-label') ?? '')
}

function tile(name: string): HTMLElement {
  return screen.getByRole('group', { name })
}

/** The first todo of 48-todo-hub-tiles.html: a subagent, the watcher it left running and the commit it made. */
const SOAK = hubAgent('soak', 'soak-login', 4, { progressSummary: 'Running the login test 200 times' })
const TESTS = hubWatcher('tests', 3, {
  kind: WatcherKind.Command,
  label: 'Login test, 200 runs',
  detail: 'pytest tests/test_login.py --count 200 -x',
  parentToolUseId: 'soak',
})
const REPEAT = hubCommit('e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6', 'Let the login test repeat', 4, {
  subagentToolUseId: 'soak',
})
const CI = hubWatcher('ci', 2, { label: 'CI checks on PR #48' })

const FLAKY: HubTask = {
  todos: [
    hubTodo('1', 'Confirm the fix over 200 runs', TodoState.Doing, { note: 'In progress · 140 of 200 runs' }),
    hubTodo('2', 'Watch CI on PR #48 until it’s green', TodoState.Doing),
  ],
  toolEvents: [SOAK],
  watchers: [TESTS, CI],
  commits: [REPEAT],
  // Only the subagent is filed: what it made follows it.
  filings: [hubFiling(refOf.subagent('soak'), '1'), hubFiling(refOf.watcher('ci'), '2')],
}

let scrollIntoView: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(HUB_NOW)
  scrollIntoView = vi.fn()
  Element.prototype.scrollIntoView = scrollIntoView as unknown as Element['scrollIntoView']
})

afterEach(() => {
  vi.useRealTimers()
  // jsdom has none of its own.
  Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
})

describe('what a subagent made, under its todo', () => {
  it('is a tile of its own beside it: its watcher counted with the todo’s watchers, its commit with its changes', async () => {
    await renderHub(FLAKY)

    // Closed: the watcher it left running turns the todo's eye blue, as the task's own would.
    expect(kinds('Confirm the fix')).toEqual(['1 subagent, 1 running', '1 watcher, 1 running', '1 change'])
    expect(within(card('Confirm the fix')).getByRole('button', { name: '1 watcher, 1 running' })).toHaveAttribute(
      'data-live',
    )

    fireEvent.click(head('Confirm the fix'))
    expect(tiles(card('Confirm the fix'))).toEqual([
      'Watcher: Login test, 200 runs',
      'Subagent: soak-login',
      'Change: Let the login test repeat',
    ])
    // Each says which subagent it came from; nothing is nested in the subagent's own tile, opened or not.
    expect(within(tile('Watcher: Login test, 200 runs')).getByTitle(/^Started by/)).toHaveTextContent('soak-login')
    fireEvent.click(tile('Subagent: soak-login'))
    expect(tile('Subagent: soak-login')).not.toHaveTextContent('Login test, 200 runs')
    expect(screen.queryByText('Background work')).toBeNull()
    expect(screen.getByRole('log', { name: 'soak-login log' })).toHaveTextContent('Nothing yet.')
  })

  it('goes grey with its todo’s eye when it’s stopped from its tile, while the subagent runs on', async () => {
    const { main } = await renderHub({
      ...FLAKY,
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Watchers }],
    })
    const watcher = tile('Watcher: Login test, 200 runs')
    expect(watcher).toHaveAttribute('data-live')

    fireEvent.click(within(watcher).getByRole('button', { name: 'Stop Login test, 200 runs' }))
    await waitFor(() => {
      expect(tile('Watcher: Login test, 200 runs')).not.toHaveAttribute('data-live')
    })

    expect(main.stoppedWatchers).toEqual([TESTS.id])
    expect(kinds('Confirm the fix')).toEqual(['1 subagent, 1 running', '1 watcher', '1 change'])
    expect(within(card('Confirm the fix')).getByRole('button', { name: '1 watcher' })).not.toHaveAttribute('data-live')
    // Stopping a tile's watcher is no click on its todo: it stays open, on its filter.
    expect(head('Confirm the fix')).toHaveAttribute('aria-expanded', 'true')
    expect(within(card('Watch CI')).getByRole('button', { name: '1 watcher, 1 running' })).toHaveAttribute('data-live')
  })

  it('shows as it’s made: a watcher a running subagent starts lands in the subagent’s todo, tagged', async () => {
    const { fake } = await renderHub({
      ...FLAKY,
      watchers: [CI],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })
    expect(kinds('Confirm the fix')).toEqual(['1 subagent, 1 running', '1 change'])

    act(() => {
      fake.emit({ type: EventType.WatchersChanged, taskId: 't1', watchers: [CI, TESTS] })
    })

    expect(kinds('Confirm the fix')).toEqual(['1 subagent, 1 running', '1 watcher, 1 running', '1 change'])
    expect(within(tile('Watcher: Login test, 200 runs')).getByTitle(/^Started by/)).toHaveTextContent('soak-login')
  })
})

describe('a todo with 50 subagents', () => {
  const AGENTS = Array.from({ length: 50 }, (_, index) =>
    hubAgent(
      `kitten-${String(index)}`,
      `kitten-${String(index)}`,
      index,
      index % 5 === 0
        ? { progressSummary: `Working on part ${String(index)}` }
        : { state: ToolCallState.Done, output: 'Done.', finishedAt: minutesAgo(index) },
    ),
  )
  const MANY: HubTask = {
    todos: [hubTodo('1', 'Review every module')],
    toolEvents: AGENTS,
    filings: AGENTS.map(({ toolUseId }) => hubFiling(refOf.subagent(toolUseId), '1')),
    todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Subagents }],
  }

  it('shows a tile each, newest first, the running ones live, and opens any of them to its own log', async () => {
    const { fake } = await renderHub(MANY)

    expect(kinds('Review every module')).toEqual(['50 subagents, 10 running'])
    const shown = tiles(card('Review every module'))
    expect(shown).toHaveLength(50)
    expect(shown.slice(0, 3)).toEqual(['Subagent: kitten-0', 'Subagent: kitten-1', 'Subagent: kitten-2'])
    expect(card('Review every module').querySelectorAll('[role="group"][data-live]')).toHaveLength(10)

    // Several open at once, each to its own log.
    for (const index of [3, 20, 49]) fireEvent.click(tile(`Subagent: kitten-${String(index)}`))
    expect(screen.getAllByRole('log')).toHaveLength(3)

    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: {
          ...hubAgent('grep', 'grep', 0, { name: 'Grep', input: { pattern: 'TODO' }, parentToolUseId: 'kitten-20' }),
          state: ToolCallState.Done,
          output: '3 matches',
          createdAt: HUB_NOW + 1_000,
          finishedAt: HUB_NOW + 2_000,
        },
      })
    })
    expect(screen.getByRole('log', { name: 'kitten-20 log' })).toHaveTextContent('GrepTODO')
    expect(screen.getByRole('log', { name: 'kitten-3 log' })).toHaveTextContent(/^Nothing yet\.$/)
    // The one that just did something is now the newest.
    expect(tiles(card('Review every module'))[0]).toBe('Subagent: kitten-20')
    // And it's still open where it moved to.
    expect(screen.getByRole('log', { name: 'kitten-20 log' })).toBeInTheDocument()
  })
})

describe('a subagent under no todo', () => {
  it('has its tile in the placeholder group, with what it made, and opens to its log there', async () => {
    await renderHub({ ...FLAKY, filings: [] })

    fireEvent.click(head(UNFILED_HEADING))
    expect(tiles(card(UNFILED_HEADING))).toEqual([
      'Watcher: CI checks on PR #48',
      'Watcher: Login test, 200 runs',
      'Subagent: soak-login',
      'Change: Let the login test repeat',
    ])
    fireEvent.click(tile('Subagent: soak-login'))
    expect(screen.getByRole('log', { name: 'soak-login log' })).toBeInTheDocument()
  })
})

describe('showing a subagent a plugin opens', () => {
  async function renderShowing(
    task: HubTask,
    focus: SubagentShown | null,
    overrides: Partial<FakeHandlers> = {},
  ): Promise<HubStore & { readonly onShown: ReturnType<typeof vi.fn>; readonly show: (next: SubagentShown) => void }> {
    const store = await hubStore(task, overrides)
    const onShown = vi.fn()
    const { rerender } = render(<HubShowing focus={focus} onShown={onShown} />, { wrapper: store.wrapper })
    return {
      ...store,
      onShown,
      show: (next) => {
        rerender(<HubShowing focus={next} onShown={onShown} />)
      },
    }
  }

  it('opens its todo on the Subagents filter, puts the focus on its tile and scrolls it into view, once', async () => {
    const { main, onShown, fake } = await renderShowing(FLAKY, { subagentId: 'soak', request: 1 })

    await waitFor(() => {
      expect(tile('Subagent: soak-login')).toHaveFocus()
    })
    expect(head('Confirm the fix')).toHaveAttribute('aria-expanded', 'true')
    expect(within(card('Confirm the fix')).getByRole('button', { name: '1 subagent, 1 running' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(tiles(card('Confirm the fix'))).toEqual(['Subagent: soak-login'])
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
    expect(scrollIntoView.mock.contexts[0]).toBe(tile('Subagent: soak-login'))
    expect(onShown).toHaveBeenCalledOnce()
    // Its log stays shut: the focus says which tile was meant.
    expect(screen.queryByRole('log')).toBeNull()
    // The todo remembers how it was left, as after a click on its subagent icon.
    expect(main.todoPanels).toEqual([{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Subagents }])
    expect(fake.invoke.mock.calls.filter(([command]) => command === CommandName.TodoHubSetPanel)).toHaveLength(1)
    // The other todo is as it was.
    expect(head('Watch CI')).toHaveAttribute('aria-expanded', 'false')
  })

  it('changes an open todo’s filter to Subagents, and only gives the focus when it’s already on it', async () => {
    const all = { taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }
    const { show, onShown, fake } = await renderShowing({ ...FLAKY, todoPanels: [all] }, null)
    await waitFor(() => {
      expect(tiles(card('Confirm the fix'))).toHaveLength(3)
    })
    expect(onShown).not.toHaveBeenCalled()

    show({ subagentId: 'soak', request: 1 })
    await waitFor(() => {
      expect(tile('Subagent: soak-login')).toHaveFocus()
    })
    expect(tiles(card('Confirm the fix'))).toEqual(['Subagent: soak-login'])

    // Asked again for the same subagent, with the todo already on Subagents: the focus alone, and nothing to remember.
    act(() => {
      head('Watch CI').focus()
    })
    show({ subagentId: 'soak', request: 2 })
    expect(tile('Subagent: soak-login')).toHaveFocus()
    expect(onShown).toHaveBeenCalledTimes(2)
    expect(fake.invoke.mock.calls.filter(([command]) => command === CommandName.TodoHubSetPanel)).toHaveLength(1)
  })

  it('finds a subagent under no todo in the placeholder group, and in a task that never wrote todos', async () => {
    const { onShown } = await renderShowing({ ...FLAKY, filings: [] }, { subagentId: 'soak', request: 1 })
    await waitFor(() => {
      expect(tile('Subagent: soak-login')).toHaveFocus()
    })
    expect(head(UNFILED_HEADING)).toHaveAttribute('aria-expanded', 'true')
    expect(tiles(card(UNFILED_HEADING))).toEqual(['Subagent: soak-login'])
    expect(onShown).toHaveBeenCalledOnce()
  })

  it('finds one in a task with no todos, whose group is the whole list', async () => {
    const { main } = await renderShowing(
      { toolEvents: [SOAK], watchers: [TESTS], commits: [REPEAT] },
      { subagentId: 'soak', request: 1 },
    )
    await waitFor(() => {
      expect(tile('Subagent: soak-login')).toHaveFocus()
    })
    expect(screen.getAllByRole('group').filter((each) => each.hasAttribute('data-kind'))).toHaveLength(1)
    expect(main.todoPanels).toEqual([
      { taskId: 't1', todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.Subagents },
    ])
  })

  it('waits for a subagent that isn’t in the task yet, and shows it when it starts', async () => {
    const { fake, onShown } = await renderShowing(FLAKY, { subagentId: 'late', request: 1 })
    await waitFor(() => {
      expect(kinds('Confirm the fix')).toHaveLength(3)
    })
    expect(onShown).not.toHaveBeenCalled()
    expect(head('Confirm the fix')).toHaveAttribute('aria-expanded', 'false')

    // It starts, under the first subagent, so in the first subagent's todo.
    act(() => {
      fake.emit({
        type: EventType.ToolEventAppended,
        toolEvent: hubAgent('late', 'late-arrival', 0, { parentToolUseId: 'soak' }),
      })
    })
    await waitFor(() => {
      expect(tile('Subagent: late-arrival')).toHaveFocus()
    })
    expect(tiles(card('Confirm the fix'))).toEqual(['Subagent: soak-login', 'Subagent: late-arrival'])
    expect(onShown).toHaveBeenCalledOnce()
  })

  it('shows it though main can’t remember how the todo was left', async () => {
    const { onShown } = await renderShowing(
      FLAKY,
      { subagentId: 'soak', request: 1 },
      { [CommandName.TodoHubSetPanel]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'The disk is full')) },
    )
    await waitFor(() => {
      expect(tile('Subagent: soak-login')).toHaveFocus()
    })
    expect(onShown).toHaveBeenCalledOnce()
  })
})

describe('a plugin’s openTask with a subagent, in the right panel', () => {
  async function renderPanel(todoHubEnabled: boolean): Promise<HubStore> {
    const main = {
      ...hubMain(FLAKY),
      settings: { ...DEFAULT_SETTINGS, todoHubEnabled },
      uiState: [
        { key: UiStateKey.ActiveWorkspaceId, value: 'w1' },
        { key: UiStateKey.SelectedTaskId, value: 't1' },
        { key: UiStateKey.RightPanelCollapsed, value: 'true' },
        { key: UiStateKey.RightPanelTabs, value: JSON.stringify({ w1: 'files' }) },
      ],
    }
    const wrapper = storeWrapper(main)
    render(<TaskPanel />, { wrapper: wrapper.wrapper })
    await act(() => wrapper.store.getState().hydrate())
    return { ...wrapper, main }
  }

  it('with the hub on, opens the panel at Todos, on the subagent’s todo and its tile, once', async () => {
    const { fake } = await renderPanel(true)

    act(() => {
      fake.emit({ type: EventType.TaskOpenRequested, taskId: 't1', subagentId: 'soak' })
    })

    await waitFor(() => {
      expect(tile('Subagent: soak-login')).toHaveFocus()
    })
    expect(screen.getByRole('tab', { name: /^Todos/ })).toHaveAttribute('aria-selected', 'true')
    expect(tiles(card('Confirm the fix'))).toEqual(['Subagent: soak-login'])
    expect(scrollIntoView).toHaveBeenCalledOnce()

    // Shown once: coming back to the tab leaves the focus where you put it.
    fireEvent.click(screen.getByRole('tab', { name: 'Files' }))
    fireEvent.click(screen.getByRole('tab', { name: /^Todos/ }))
    await waitFor(() => {
      expect(tiles(card('Confirm the fix'))).toEqual(['Subagent: soak-login'])
    })
    expect(tile('Subagent: soak-login')).not.toHaveFocus()
    expect(scrollIntoView).toHaveBeenCalledOnce()
  })

  it('with the hub off, opens the Subagents tab on its log, as it always has', async () => {
    const { fake } = await renderPanel(false)

    act(() => {
      fake.emit({ type: EventType.TaskOpenRequested, taskId: 't1', subagentId: 'soak' })
    })

    await waitFor(() => {
      expect(screen.getByRole('log', { name: 'soak-login log' })).toBeInTheDocument()
    })
    expect(screen.getByRole('tab', { name: /^Subagents/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.queryByRole('list', { name: 'Todos' })).toBeNull()
  })
})
