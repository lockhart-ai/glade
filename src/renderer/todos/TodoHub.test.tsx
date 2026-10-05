import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { WindowCommandId } from '../../shared/commands'
import { DEFAULT_SETTINGS } from '../../shared/settings'
import { CommitFileStatus, TodoState, ToolCallState, WatcherState, type Artifact, type Todo } from '../../shared/domain'
import { commitFileKey } from '../../shared/files'
import { ChildFilter, FilingSource, UNFILED_TODO_ID } from '../../shared/todoHub'
import linkStyles from '../links/Link.module.css'
import { refuse } from '../store/test-bridge'
import { storeWrapper } from '../store/test-wrapper'
import { NOW_REFRESH_MS } from '../task-list/useNow'
import {
  HUB_NOW,
  HubForTask,
  hubAgent,
  hubCommit,
  hubFile,
  hubFiling,
  hubLink,
  hubMain,
  hubTodo,
  hubWatcher,
  minutesAgo,
  refOf,
  type HubStore,
  type HubTask,
} from './test-hub'
import { TodoHub } from './TodoHub'
import styles from './TodoHub.module.css'
import { NO_HUB_TODOS, UNFILED_HEADING } from './todoHubModel'
import { NO_TODOS } from './Todos'
import todosStyles from './Todos.module.css'

const PR_511 = 'https://github.com/acme/api/pull/511'
const ISSUE_501 = 'https://github.com/acme/api/issues/501'
const PR_513 = 'https://github.com/acme/api/pull/513'

/** Made by the subagent `fix-501`, and filed nowhere itself: it's under the todo that subagent works on. */
const C1 = hubCommit('a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', 'Return Retry-After on 429 responses', 11, {
  subagentToolUseId: 'fix-501',
})
const C2 = hubCommit('0c4d2e1f60718293a4b5c6d7e8f9012345678abc', 'Test the header under burst traffic', 8)
const C3 = hubCommit('5e6f7a8b9c0d1e2f3a4b5c6d7e8f901234567890', 'Limit /search per API key', 9)

/**
 * The task in 46-todo-hub.html: two todos in progress, one not started and one done. It has two subagents, each
 * working on the first todo, and two watchers, none of which any todo shows.
 */
const SHIP: HubTask = {
  todos: [
    hubTodo('1', '#501 Return Retry-After on 429s', TodoState.Doing, { note: 'CI failed on PR #511 · fixing' }),
    hubTodo('2', '#502 Per-key limits for /search', TodoState.Doing, { note: 'Waiting on CI · PR #513' }),
    hubTodo('3', 'Draft the 2.5 release notes', TodoState.Todo),
    hubTodo('4', '#503 Document the rate limits', TodoState.Done),
  ],
  artifacts: [
    hubLink(ISSUE_501, '429s don’t say when to retry', 22),
    hubLink(PR_511, 'Return Retry-After on 429s', 7),
    hubLink(PR_513, 'Per-key limits for /search', 2),
    hubFile('docs/rate-limits.md', 'Rate limits reference', 6),
  ],
  toolEvents: [
    hubAgent('fix-501', 'fix-501', 37, {
      state: ToolCallState.Done,
      output: 'Opened PR #511.',
      finishedAt: minutesAgo(9),
    }),
    hubAgent('fix-501-ci', 'fix-501-ci', 0, { progressSummary: 'Rerunning tests/test_throttle.py' }),
  ],
  watchers: [
    hubWatcher('watch-511', 6, {
      label: 'CI checks on PR #511',
      state: WatcherState.Finished,
      endedAt: minutesAgo(1),
      outcome: 'unit-tests fail test_retry_after_burst',
    }),
    hubWatcher('watch-513', 3, { label: 'CI checks on PR #513' }),
  ],
  commits: [C2, C1, C3],
  filings: [
    hubFiling(refOf.link(ISSUE_501), '1'),
    hubFiling(refOf.link(PR_511), '1'),
    hubFiling(refOf.subagent('fix-501'), '1'),
    hubFiling(refOf.subagent('fix-501-ci'), '1'),
    hubFiling(refOf.commit(C2), '1'),
    hubFiling(refOf.link(PR_513), '2'),
    hubFiling(refOf.commit(C3), '2'),
    hubFiling(refOf.file('docs/rate-limits.md'), '4'),
  ],
}

async function renderHub(task: HubTask, overrides: Parameters<typeof storeWrapper>[1] = {}): Promise<HubStore> {
  const main = hubMain(task)
  const wrapper = storeWrapper(main, overrides)
  await act(() => wrapper.store.getState().hydrate())
  render(<HubForTask />, { wrapper: wrapper.wrapper })
  await waitFor(() => {
    expect(wrapper.store.getState().filings.t1).toBeDefined()
  })
  return { ...wrapper, main }
}

/** Every card, in the tab's order: the todos, then the placeholder group. */
function cards(): HTMLElement[] {
  return [...screen.getByRole('list', { name: 'Todos' }).querySelectorAll<HTMLElement>(':scope > li')]
}

/** The card whose head says `text`. */
function card(text: string | RegExp): HTMLElement {
  const says = (content: string): boolean => (typeof text === 'string' ? content.includes(text) : text.test(content))
  const found = cards().find((each) => says(each.querySelector('[data-todo-head]')?.textContent ?? ''))
  if (found === undefined) throw new Error(`No card says ${String(text)}`)
  return found
}

/** A card's head: what takes the focus, and opens a todo with children. */
function head(text: string | RegExp): HTMLElement {
  const found = card(text).querySelector<HTMLElement>('[data-todo-head]')
  if (found === null) throw new Error(`The card that says ${String(text)} has no head`)
  return found
}

/** What a card's row of icons says, in order: each count's or pill's words. */
function kinds(text: string | RegExp): string[] {
  return within(card(text))
    .queryAllByRole('button')
    .filter((button) => button.hasAttribute('data-kind'))
    .map((button) => button.getAttribute('aria-label') ?? '')
}

/** The names of the tiles a card shows, in order; none while it's closed. */
function tiles(text: string | RegExp): string[] {
  return [...card(text).querySelectorAll('[role="group"][data-kind]')].map(
    (tile) => tile.getAttribute('aria-label') ?? '',
  )
}

function kind(text: string | RegExp, label: string): HTMLElement {
  return within(card(text)).getByRole('button', { name: label })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(HUB_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the hub’s todos', () => {
  it('shows how many are done, with a progress bar and when the list last changed, and no line explaining it', async () => {
    await renderHub(SHIP)

    expect(screen.getByText('1 of 4 done')).toBeInTheDocument()
    expect(screen.getByText('updated 1m ago')).toBeInTheDocument()
    const bar = screen.getByRole('progressbar', { name: 'Todos done' })
    expect(bar).toHaveAttribute('aria-valuenow', '1')
    expect(bar).toHaveAttribute('aria-valuemax', '4')
    const [done, doing] = Array.from(bar.children) as HTMLElement[]
    expect(done?.style.width).toBe('25%')
    expect(doing?.style.width).toBe('25%')
    expect(screen.queryByText(/writes this list/)).toBeNull()
  })

  it('shows every todo as a card, in the tab’s order: active, then not started, then done', async () => {
    await renderHub(SHIP)

    expect(cards().map((each) => each.querySelector('[data-todo-head]')?.textContent)).toEqual([
      'Doing: #501 Return Retry-After on 429sCI failed on PR #511 · fixing',
      'Doing: #502 Per-key limits for /searchWaiting on CI · PR #513',
      'To do: Draft the 2.5 release notes',
      'Done: #503 Document the rate limitsFinished 2m ago',
    ])
    for (const each of cards()) expect(each).toHaveClass(styles.card ?? '')
    expect(card(/#503/)).toHaveClass(styles.done ?? '')
    expect(card(/Draft the 2.5/)).toHaveClass(styles.todo ?? '')
  })

  it('counts a closed todo’s children by kind, in order, leaving out a kind with none', async () => {
    await renderHub(SHIP)

    expect(kinds(/#501/)).toEqual(['2 links', '2 changes'])
    expect(kinds(/#502/)).toEqual(['1 link', '1 change'])
    expect(kinds(/#503/)).toEqual(['1 file'])
    expect(kind(/#501/, '2 links')).toHaveTextContent(/^2$/)
    // Each says what it counts in words on hover.
    expect(kind(/#501/, '2 changes')).toHaveAttribute('title', '2 changes')
  })

  it('shows a todo with nothing under it as its title alone: no row of icons, no chevron, nothing to open', async () => {
    await renderHub(SHIP)

    const bare = card(/Draft the 2.5/)
    expect(within(bare).queryAllByRole('button')).toEqual([])
    expect(bare.children).toHaveLength(1)
    expect(head(/Draft the 2.5/)).not.toHaveAttribute('aria-expanded')
    expect(head(/Draft the 2.5/).querySelectorAll('svg')).toHaveLength(1)
    fireEvent.click(head(/Draft the 2.5/))
    fireEvent.keyDown(head(/Draft the 2.5/), { key: 'ArrowRight' })
    expect(tiles(/Draft the 2.5/)).toEqual([])
  })

  it('counts no subagent and no watcher, and nothing is live, whatever runs, starts or ends', async () => {
    const { fake } = await renderHub(SHIP)
    const counted = (): string[][] => [kinds(/#501/), kinds(/#502/), kinds(/Draft the 2.5/), kinds(/#503/)]
    const before = counted()
    expect(before).toEqual([['2 links', '2 changes'], ['1 link', '1 change'], [], ['1 file']])
    const nothingLive = (): void => {
      expect(document.querySelectorAll('[data-live]')).toHaveLength(0)
      expect(document.querySelectorAll('[data-kind="subagent"], [data-kind="watcher"]')).toHaveLength(0)
      expect(document.body.innerHTML).not.toMatch(/running/i)
    }
    nothingLive()

    // The running subagent finishes, the running watcher too, and a third of each starts.
    const [, running] = SHIP.toolEvents ?? []
    const [first, second] = SHIP.watchers ?? []
    act(() => {
      fake.emitBatch([
        {
          type: EventType.ToolEventUpdated,
          toolEvent: { ...running, state: ToolCallState.Done, output: 'Fixed.', finishedAt: HUB_NOW } as never,
        },
        { type: EventType.ToolEventAppended, toolEvent: hubAgent('limits-502', 'limits-502', 0) },
        {
          type: EventType.WatchersChanged,
          taskId: 't1',
          watchers: [
            first,
            { ...second, state: WatcherState.Finished, endedAt: HUB_NOW },
            hubWatcher('watch-502', 0, { label: 'Staging deploy', parentToolUseId: 'limits-502' }),
          ] as never,
        },
      ])
    })

    expect(counted()).toEqual(before)
    nothingLive()
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    // Open, every todo's tiles are what it produced, and nothing else.
    for (const each of [/#501/, /#502/, /#503/]) fireEvent.click(head(each))
    expect([...tiles(/#501/), ...tiles(/#502/), ...tiles(/#503/)].map((name) => name.split(':')[0])).toEqual([
      ...['Link', 'Change', 'Change', 'Link'],
      ...['Link', 'Change'],
      'File',
    ])
    nothingLive()
  })

  it('shows a subagent with commits and a watcher as its commits alone, under the todo it works on', async () => {
    const made = [
      hubCommit('b'.repeat(40), 'Add the burst test', 3, { subagentToolUseId: 'fix-501-ci' }),
      hubCommit('c'.repeat(40), 'Fix the header on the second 429', 1, { subagentToolUseId: 'fix-501-ci' }),
    ]
    await renderHub({
      todos: [hubTodo('1', '#501 Return Retry-After on 429s'), hubTodo('2', 'Draft the 2.5 release notes')],
      toolEvents: [hubAgent('fix-501-ci', 'fix-501-ci', 5)],
      watchers: [hubWatcher('watch-511', 4, { label: 'CI checks on PR #511', parentToolUseId: 'fix-501-ci' })],
      commits: made,
      filings: [hubFiling(refOf.subagent('fix-501-ci'), '1')],
    })

    expect(kinds(/#501/)).toEqual(['2 changes'])
    fireEvent.click(head(/#501/))
    expect(tiles(/#501/)).toEqual(['Change: Fix the header on the second 429', 'Change: Add the burst test'])
    expect(kinds(/Draft the 2.5/)).toEqual([])
    // Its watcher is under no todo either: there's no group for what no todo has.
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    expect(cards()).toHaveLength(2)
  })

  it('shows a task whose only children are watchers and subagents as its todos alone, each a title', async () => {
    await renderHub({
      todos: [hubTodo('1', 'Check the nightly report'), hubTodo('2', 'Watch the deploy')],
      toolEvents: [hubAgent('checker', 'checker', 2)],
      watchers: [
        hubWatcher('wake', 3, { state: WatcherState.Scheduled, nextDueAt: HUB_NOW + 60_000 }),
        hubWatcher('deploy', 1),
        hubWatcher('by-checker', 1, { parentToolUseId: 'checker' }),
      ],
      filings: [hubFiling(refOf.subagent('checker'), '1')],
    })

    expect(cards()).toHaveLength(2)
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    for (const each of [head(/nightly/), head(/deploy/)]) {
      expect(each).not.toHaveAttribute('aria-expanded')
      fireEvent.click(each)
    }
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(0)
  })

  it('says when a done todo was finished, and keeps that current by itself', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(HUB_NOW)
    const main = hubMain(SHIP)
    const wrapper = storeWrapper(main)
    await act(() => wrapper.store.getState().hydrate())
    render(<HubForTask />, { wrapper: wrapper.wrapper })
    await act(() => wrapper.store.getState().loadTodoHub('t1'))
    expect(within(card(/#503/)).getByText('2m ago')).toHaveAttribute('title', 'Sep 23, 2026, 2:28 PM')

    act(() => {
      vi.setSystemTime(HUB_NOW + 3 * 60_000)
      vi.advanceTimersByTime(NOW_REFRESH_MS)
    })

    expect(within(card(/#503/)).getByText('5m ago')).toBeInTheDocument()
    expect(screen.getByText('updated 4m ago')).toBeInTheDocument()
  })

  it('shows a todo waiting on you in purple, as everywhere', async () => {
    await renderHub({ todos: [hubTodo('1', 'Delete local copies', TodoState.Waiting, { note: 'Will ask you first' })] })
    expect(card(/Delete local copies/)).toHaveClass(styles.waiting ?? '')
    expect(head(/Delete local copies/)).toHaveTextContent('Waiting on you: Delete local copiesWill ask you first')
  })
})

describe('opening a todo', () => {
  it('opens on a click of its head: the icons become filter pills with All in front, over its children, newest first', async () => {
    await renderHub(SHIP)
    expect(tiles(/#501/)).toEqual([])
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(head(/#501/))

    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'true')
    const pills = within(card(/#501/)).getByRole('group', { name: 'Show' })
    expect(
      within(pills)
        .getAllByRole('button')
        .map((pill) => pill.textContent),
    ).toEqual(['All4', '2', '2'])
    expect(within(pills).getByRole('button', { name: 'All 4' })).toHaveAttribute('aria-pressed', 'true')
    expect(kind(/#501/, '2 links')).toHaveAttribute('aria-pressed', 'false')
    expect(tiles(/#501/)).toEqual([
      'Link: Return Retry-After on 429s',
      'Change: Test the header under burst traffic',
      'Change: Return Retry-After on 429 responses',
      'Link: 429s don’t say when to retry',
    ])
    expect(
      within(card(/#501/)).getByRole('list', { name: 'Under #501 Return Retry-After on 429s' }),
    ).toBeInTheDocument()
    // Opening it moved nothing above the list: the row of icons is the same box, closed and open.
    expect(card(/#501/).querySelector(`.${styles.kinds ?? ''}`)).toHaveClass(styles.pills ?? '')
  })

  it('never builds a closed todo’s list', async () => {
    await renderHub(SHIP)
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(0)
    expect(screen.queryByRole('list', { name: /^Under/ })).toBeNull()

    fireEvent.click(head(/#502/))

    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(2)
    expect(screen.getAllByRole('list', { name: /^Under/ })).toHaveLength(1)
  })

  it('closes again on another click, keeping its counts', async () => {
    await renderHub(SHIP)
    fireEvent.click(head(/#501/))
    fireEvent.click(head(/#501/))

    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'false')
    expect(tiles(/#501/)).toEqual([])
    expect(within(card(/#501/)).queryByRole('group', { name: 'Show' })).toBeNull()
    expect(kinds(/#501/)).toEqual(['2 links', '2 changes'])
  })

  it('shows one kind alone when its pill is picked, and all of them again under All', async () => {
    await renderHub(SHIP)
    fireEvent.click(head(/#501/))

    fireEvent.click(kind(/#501/, '2 links'))

    expect(tiles(/#501/)).toEqual(['Link: Return Retry-After on 429s', 'Link: 429s don’t say when to retry'])
    expect(kind(/#501/, '2 links')).toHaveAttribute('aria-pressed', 'true')
    expect(kind(/#501/, '2 links')).toHaveClass(styles.pill ?? '', styles.on ?? '')
    expect(within(card(/#501/)).getByRole('button', { name: 'All 4' })).toHaveAttribute('aria-pressed', 'false')

    fireEvent.click(kind(/#501/, '2 changes'))
    expect(tiles(/#501/)).toEqual([
      'Change: Test the header under burst traffic',
      'Change: Return Retry-After on 429 responses',
    ])
    fireEvent.click(within(card(/#501/)).getByRole('button', { name: 'All 4' }))
    expect(tiles(/#501/)).toHaveLength(4)
  })

  it('opens a closed todo on a kind when its icon is clicked, and the icon keeps the focus as it becomes the pill', async () => {
    await renderHub(SHIP)
    const closed = kind(/#502/, '1 change')
    expect(closed).toHaveClass(styles.count ?? '')
    closed.focus()

    fireEvent.click(closed)

    expect(tiles(/#502/)).toEqual(['Change: Limit /search per API key'])
    const pill = kind(/#502/, '1 change')
    expect(pill).toBe(closed)
    expect(pill).toHaveFocus()
    expect(pill).toHaveClass(styles.pill ?? '', styles.on ?? '')
    expect(pill).toHaveAttribute('aria-pressed', 'true')
  })

  it('keeps each todo’s own open state and filter as you open others', async () => {
    await renderHub(SHIP)
    const changes = ['Change: Test the header under burst traffic', 'Change: Return Retry-After on 429 responses']
    fireEvent.click(kind(/#501/, '2 changes'))
    fireEvent.click(kind(/#502/, '1 link'))
    fireEvent.click(head(/#503/))

    expect(tiles(/#501/)).toEqual(changes)
    expect(tiles(/#502/)).toEqual(['Link: Per-key limits for /search'])
    expect(tiles(/#503/)).toEqual(['File: Rate limits reference'])

    // Closed and opened again, it's still on its filter.
    fireEvent.click(head(/#501/))
    fireEvent.click(head(/#501/))
    expect(tiles(/#501/)).toEqual(changes)
  })

  it('leaves the todo as it is when a link in its text is clicked', async () => {
    const opened: string[] = []
    const main = hubMain({
      todos: [hubTodo('1', 'Watch CI on https://github.com/acme/api/pull/42 until it’s green')],
      commits: [C3],
      filings: [hubFiling(refOf.commit(C3), '1')],
    })
    const wrapper = storeWrapper({ ...main, opened })
    await act(() => wrapper.store.getState().hydrate())
    render(<HubForTask />, { wrapper: wrapper.wrapper })
    await screen.findByRole('button', { name: '1 change' })

    fireEvent.click(screen.getByRole('link', { name: 'https://github.com/acme/api/pull/42' }))
    await act(() => Promise.resolve())

    expect(head(/Watch CI/)).toHaveAttribute('aria-expanded', 'false')
    expect(opened).toEqual(['https://github.com/acme/api/pull/42'])
  })
})

describe('what a todo remembers', () => {
  it('has main remember each change to a todo’s panel, by task and todo', async () => {
    const { fake, main } = await renderHub(SHIP)

    fireEvent.click(head(/#501/))
    expect(fake.invoke).toHaveBeenLastCalledWith(CommandName.TodoHubSetPanel, {
      taskId: 't1',
      todoId: '1',
      open: true,
      filter: ChildFilter.All,
    })
    fireEvent.click(kind(/#501/, '2 links'))
    fireEvent.click(kind(/#502/, '1 change'))
    fireEvent.click(head(/#501/))
    await act(() => Promise.resolve())

    expect(main.todoPanels).toEqual([
      { taskId: 't1', todoId: '1', open: false, filter: ChildFilter.Links },
      { taskId: 't1', todoId: '2', open: true, filter: ChildFilter.Commits },
    ])
  })

  it('opens as main remembered it after a relaunch: each todo open or closed, on its own filter', async () => {
    await renderHub({
      ...SHIP,
      todoPanels: [
        { taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Commits },
        { taskId: 't1', todoId: '2', open: false, filter: ChildFilter.Links },
        { taskId: 't1', todoId: '4', open: true, filter: ChildFilter.All },
      ],
    })

    expect(tiles(/#501/)).toEqual([
      'Change: Test the header under burst traffic',
      'Change: Return Retry-After on 429 responses',
    ])
    expect(tiles(/#502/)).toEqual([])
    expect(tiles(/#503/)).toEqual(['File: Rate limits reference'])
    // The closed one opens on the filter it was left on.
    fireEvent.click(head(/#502/))
    expect(tiles(/#502/)).toEqual(['Link: Per-key limits for /search'])
  })

  it.each(['subagent', 'watcher'])(
    'opens a todo remembered on the %s filter, which is gone, on All, and remembers the next one you pick',
    async (removed) => {
      // As a window that had the panel from before #535 would: main itself reads such a row as All.
      const stored = removed as ChildFilter
      const { main } = await renderHub({
        ...SHIP,
        todoPanels: [
          { taskId: 't1', todoId: '1', open: true, filter: stored },
          { taskId: 't1', todoId: '2', open: false, filter: stored },
        ],
      })

      expect(within(card(/#501/)).getByRole('button', { name: 'All 4' })).toHaveAttribute('aria-pressed', 'true')
      expect(tiles(/#501/)).toHaveLength(4)
      expect(kinds(/#501/)).toEqual(['2 links', '2 changes'])
      for (const pill of within(card(/#501/)).getAllByRole('button', { pressed: false })) {
        expect(pill).toHaveAttribute('data-kind')
      }
      // The closed one opens on All too.
      fireEvent.click(head(/#502/))
      expect(within(card(/#502/)).getByRole('button', { name: 'All 2' })).toHaveAttribute('aria-pressed', 'true')
      expect(tiles(/#502/)).toHaveLength(2)

      fireEvent.click(kind(/#501/, '2 links'))
      await act(() => Promise.resolve())
      expect(tiles(/#501/)).toHaveLength(2)
      expect(main.todoPanels).toContainEqual({ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Links })
    },
  )

  it('is as you left it when you come back from another tab or another task', async () => {
    const main = hubMain(SHIP)
    const wrapper = storeWrapper(main)
    await act(() => wrapper.store.getState().hydrate())
    const first = render(<HubForTask />, { wrapper: wrapper.wrapper })
    await screen.findByRole('button', { name: '2 links' })
    fireEvent.click(kind(/#501/, '2 links'))
    first.unmount()

    render(<HubForTask />, { wrapper: wrapper.wrapper })

    const links = ['Link: Return Retry-After on 429s', 'Link: 429s don’t say when to retry']
    expect(tiles(/#501/)).toEqual(links)
    // The hub is read again as it shows the task, and the window's own panels stand.
    await waitFor(() => {
      expect(main.todoHubReads).toEqual(['t1', 't1'])
    })
    expect(tiles(/#501/)).toEqual(links)
  })

  it('falls back to All while its filter’s kind has no children, and goes back to the filter when it has again', async () => {
    const { fake } = await renderHub({
      ...SHIP,
      todoPanels: [{ taskId: 't1', todoId: '2', open: true, filter: ChildFilter.Links }],
    })
    expect(tiles(/#502/)).toEqual(['Link: Per-key limits for /search'])

    // Its one link is moved to the first todo.
    const moved = { ...hubFiling(refOf.link(PR_513), '1', HUB_NOW + 1), source: FilingSource.Moved }
    act(() => {
      fake.emit({ type: EventType.FilingsChanged, taskId: 't1', filed: [moved], removed: [] })
    })

    expect(kinds(/#502/)).toEqual(['1 change'])
    expect(within(card(/#502/)).getByRole('button', { name: 'All 1' })).toHaveAttribute('aria-pressed', 'true')
    expect(tiles(/#502/)).toEqual(['Change: Limit /search per API key'])
    expect(kinds(/#501/)).toEqual(['3 links', '2 changes'])

    // And back: the todo is on Links again.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.link(PR_513), '2', HUB_NOW + 2)],
        removed: [],
      })
    })
    expect(tiles(/#502/)).toEqual(['Link: Per-key limits for /search'])
  })

  it('shows a todo as you set it even when main can’t remember it', async () => {
    await renderHub(SHIP, {
      [CommandName.TodoHubSetPanel]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'The disk is full')),
    })
    fireEvent.click(head(/#501/))
    await act(() => Promise.resolve())
    expect(tiles(/#501/)).toHaveLength(4)
  })
})

describe('children as they change', () => {
  it('shows a child under its todo as soon as it’s filed, with no reload', async () => {
    const { fake, main } = await renderHub({ ...SHIP, filings: (SHIP.filings ?? []).slice(0, 2) })
    expect(kinds(/#501/)).toEqual(['2 links'])
    expect(screen.getByText(UNFILED_HEADING)).toBeInTheDocument()
    fireEvent.click(head(/#501/))

    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.commit(C2), '1')],
        removed: [],
      })
    })

    expect(kinds(/#501/)).toEqual(['2 links', '1 change'])
    expect(tiles(/#501/)).toEqual([
      'Link: Return Retry-After on 429s',
      'Change: Test the header under burst traffic',
      'Link: 429s don’t say when to retry',
    ])
    expect(main.todoHubReads).toEqual(['t1'])
  })

  it('puts a subagent’s commits under the todo it’s recorded as working on, and never the subagent', async () => {
    const { fake } = await renderHub({ ...SHIP, filings: (SHIP.filings ?? []).slice(0, 2) })
    fireEvent.click(head(/#501/))
    expect(tiles(/#501/)).toHaveLength(2)

    // Glade records the todo the subagent that made the first commit was started for.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [hubFiling(refOf.subagent('fix-501'), '1')],
        removed: [],
      })
    })

    expect(kinds(/#501/)).toEqual(['2 links', '1 change'])
    expect(tiles(/#501/)).toEqual([
      'Link: Return Retry-After on 429s',
      'Change: Return Retry-After on 429 responses',
      'Link: 429s don’t say when to retry',
    ])
    // And takes it back: the commit is under no todo again.
    act(() => {
      fake.emit({ type: EventType.FilingsChanged, taskId: 't1', filed: [], removed: [refOf.subagent('fix-501')] })
    })
    expect(kinds(/#501/)).toEqual(['2 links'])
  })

  it('moves a child from one todo to another: it leaves the first, filtered to its kind, and shows in the second', async () => {
    const { fake } = await renderHub({
      ...SHIP,
      todoPanels: [
        { taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Commits },
        { taskId: 't1', todoId: '2', open: true, filter: ChildFilter.Commits },
      ],
    })
    expect(tiles(/#501/)).toEqual([
      'Change: Test the header under burst traffic',
      'Change: Return Retry-After on 429 responses',
    ])

    // The agent moves one commit, and gives the subagent that made the other the second todo: both go there.
    const moved = [refOf.commit(C2), refOf.subagent('fix-501')].map((ref) => ({
      ...hubFiling(ref, '2', HUB_NOW + 1),
      source: FilingSource.Moved,
    }))
    act(() => {
      fake.emit({ type: EventType.FilingsChanged, taskId: 't1', filed: moved, removed: [] })
    })

    // The first todo has no changes left: it shows all it has. The second lists all three, newest first.
    expect(kinds(/#501/)).toEqual(['2 links'])
    expect(tiles(/#501/)).toHaveLength(2)
    expect(tiles(/#502/)).toEqual([
      'Change: Test the header under burst traffic',
      'Change: Limit /search per API key',
      'Change: Return Retry-After on 429 responses',
    ])
    expect(kinds(/#502/)).toEqual(['1 link', '3 changes'])
  })

  it('shows nothing for a subagent started under the todo, and its commit, on top, as soon as it’s made', async () => {
    const { fake } = await renderHub({
      ...SHIP,
      todoPanels: [{ taskId: 't1', todoId: '2', open: true, filter: ChildFilter.All }],
    })
    const before = tiles(/#502/)
    const started = hubAgent('limits-502', 'limits-502', 0)

    act(() => {
      fake.emitBatch([
        { type: EventType.ToolEventAppended, toolEvent: started },
        {
          type: EventType.FilingsChanged,
          taskId: 't1',
          filed: [hubFiling(refOf.subagent('limits-502'), '2')],
          removed: [],
        },
      ])
    })

    expect(tiles(/#502/)).toEqual(before)
    expect(kinds(/#502/)).toEqual(['1 link', '1 change'])

    const made = hubCommit('d'.repeat(40), 'Count requests per key', 0, { subagentToolUseId: 'limits-502' })
    act(() => {
      fake.emit({ type: EventType.CommitsChanged, taskId: 't1', commits: [made, ...(SHIP.commits ?? [])] })
    })

    expect(tiles(/#502/)).toEqual(['Change: Count requests per key', ...before])
    expect(kinds(/#502/)).toEqual(['1 link', '2 changes'])
  })

  it('takes a removed artifact out of its todo’s list and count', async () => {
    const { fake } = await renderHub({
      ...SHIP,
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Links }],
    })
    expect(tiles(/#501/)).toHaveLength(2)

    act(() => {
      fake.emit({
        type: EventType.ArtifactsChanged,
        taskId: 't1',
        artifacts: (SHIP.artifacts ?? []).filter((artifact) => !('url' in artifact) || artifact.url !== PR_511),
      })
    })

    expect(tiles(/#501/)).toEqual(['Link: 429s don’t say when to retry'])
    expect(kinds(/#501/)[0]).toBe('1 link')
  })

  it('drops a deleted todo’s card, open or not, and its children go under no todo', async () => {
    const { fake } = await renderHub({
      ...SHIP,
      todoPanels: [{ taskId: 't1', todoId: '2', open: true, filter: ChildFilter.All }],
    })
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    const [first, , third, fourth] = SHIP.todos ?? []

    act(() => {
      fake.emit({
        type: EventType.TodosChanged,
        taskId: 't1',
        todos: { items: [first, third, fourth] as Todo[], updatedAt: HUB_NOW },
      })
    })

    expect(cards()).toHaveLength(4)
    expect(screen.queryByText(/#502/)).toBeNull()
    expect(kinds(UNFILED_HEADING)).toEqual(['1 link', '1 change'])
    expect(screen.getByText('1 of 3 done')).toBeInTheDocument()
  })

  it('reorders an open todo’s list as a child is updated, most recent first', async () => {
    const { fake } = await renderHub({
      ...SHIP,
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.Links }],
    })
    expect(tiles(/#501/)).toEqual(['Link: Return Retry-After on 429s', 'Link: 429s don’t say when to retry'])
    vi.setSystemTime(HUB_NOW + 60_000)

    // The agent gives the issue's link another title: it's the one updated last.
    const retitled = (SHIP.artifacts ?? []).map((artifact) =>
      'url' in artifact && artifact.url === ISSUE_501
        ? { ...artifact, title: '429s should say when to retry', updatedAt: HUB_NOW + 30_000 }
        : artifact,
    )
    act(() => {
      fake.emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: retitled })
    })

    expect(tiles(/#501/)).toEqual(['Link: 429s should say when to retry', 'Link: Return Retry-After on 429s'])
  })
})

describe('Not under a todo', () => {
  const BEFORE: HubTask = {
    todos: [hubTodo('1', 'Fix the date formatting', TodoState.Done), hubTodo('2', 'Open a PR', TodoState.Done)],
    artifacts: [hubLink('https://github.com/acme/api/pull/42', 'Fix the UTC date test', 4330)],
    watchers: [
      hubWatcher('watch-42', 4332, {
        label: 'CI checks on PR #42',
        state: WatcherState.Finished,
        endedAt: minutesAgo(4325),
      }),
    ],
    commits: [hubCommit('e4f5a6b0718293a4b5c6d7e8f90123456789abcd', 'Fix the UTC date test', 4335)],
  }

  it('shows the children no todo has in a card of its own, after the todos, closed with its counts', async () => {
    await renderHub(BEFORE)

    const group = cards().at(-1)
    expect(group).toHaveTextContent(UNFILED_HEADING)
    expect(group).toHaveClass(styles.card ?? '')
    expect(cards()).toHaveLength(3)
    expect(kinds(UNFILED_HEADING)).toEqual(['1 link', '1 change'])
    expect(head(UNFILED_HEADING)).toHaveAttribute('aria-expanded', 'false')
    expect(tiles(UNFILED_HEADING)).toEqual([])
    // The todos themselves have nothing under them.
    expect(kinds(/Fix the date formatting/)).toEqual([])
  })

  it('opens a commit under no todo to its branch and files there, as under a todo (#499)', async () => {
    const [commit] = BEFORE.commits ?? []
    if (commit === undefined) throw new Error('No commit')
    const files = {
      files: [{ path: 'src/date.ts', oldPath: null, status: CommitFileStatus.Modified, additions: 1, deletions: 1 }],
      total: 1,
    }
    const main = { ...hubMain(BEFORE), commitFiles: { [commit.id]: files } }
    const wrapper = storeWrapper(main)
    await act(() => wrapper.store.getState().hydrate())
    render(<HubForTask />, { wrapper: wrapper.wrapper })
    await waitFor(() => {
      expect(wrapper.store.getState().filings.t1).toBeDefined()
    })
    fireEvent.click(head(UNFILED_HEADING))

    fireEvent.click(screen.getByRole('group', { name: 'Change: Fix the UTC date test' }))
    await act(() => Promise.resolve())

    const tile = screen.getByRole('group', { name: 'Change: Fix the UTC date test' })
    expect(tile).toHaveTextContent(/fix\/date-testMsrc\/date\.ts\+1−1$/)
    // Opening a tile, or a file in it, is no click on the group around it.
    fireEvent.click(within(tile).getByRole('button', { name: /src\/date\.ts/ }))
    await act(() => Promise.resolve())
    expect(head(UNFILED_HEADING)).toHaveAttribute('aria-expanded', 'true')
    expect(wrapper.store.getState().openFiles.t1?.activePath).toBe(
      commitFileKey({ commitId: commit.id, path: 'src/date.ts' }),
    )
  })

  it('opens, filters and remembers as a todo does, under its own id', async () => {
    const { fake, main } = await renderHub(BEFORE)

    fireEvent.click(head(UNFILED_HEADING))
    expect(head(UNFILED_HEADING)).toHaveAttribute('aria-expanded', 'true')
    expect(tiles(UNFILED_HEADING)).toEqual(['Link: Fix the UTC date test', 'Change: Fix the UTC date test'])
    expect(within(card(UNFILED_HEADING)).getByRole('list', { name: `Under ${UNFILED_HEADING}` })).toBeInTheDocument()
    fireEvent.click(kind(UNFILED_HEADING, '1 change'))
    expect(tiles(UNFILED_HEADING)).toEqual(['Change: Fix the UTC date test'])
    await act(() => Promise.resolve())

    expect(fake.invoke).toHaveBeenLastCalledWith(CommandName.TodoHubSetPanel, {
      taskId: 't1',
      todoId: UNFILED_TODO_ID,
      open: true,
      filter: ChildFilter.Commits,
    })
    expect(main.todoPanels).toEqual([
      { taskId: 't1', todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.Commits },
    ])
    fireEvent.click(head(UNFILED_HEADING))
    expect(tiles(UNFILED_HEADING)).toEqual([])
  })

  it('is hidden while it’s empty, and goes once its agent has filed the last of them', async () => {
    const { fake } = await renderHub(BEFORE)
    const [commit] = BEFORE.commits ?? []
    if (commit === undefined) throw new Error('No commit')

    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [
          hubFiling(refOf.link('https://github.com/acme/api/pull/42'), '2'),
          hubFiling(refOf.commit(commit), '1'),
        ],
        removed: [],
      })
    })

    // The watcher the task still has under no todo doesn't keep the group.
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    expect(cards()).toHaveLength(2)
    expect(kinds(/Open a PR/)).toEqual(['1 link'])
    expect(kinds(/Fix the date formatting/)).toEqual(['1 change'])

    // A child that loses its filing comes back to it.
    act(() => {
      fake.emit({
        type: EventType.FilingsChanged,
        taskId: 't1',
        filed: [],
        removed: [refOf.link('https://github.com/acme/api/pull/42')],
      })
    })
    expect(kinds(UNFILED_HEADING)).toEqual(['1 link'])
  })

  it('has no group for a task whose only unfiled things are subagents and watchers', async () => {
    const { fake } = await renderHub({
      todos: BEFORE.todos,
      toolEvents: [hubAgent('review', 'review', 9), hubAgent('nested', 'nested', 8, { parentToolUseId: 'review' })],
      watchers: [...(BEFORE.watchers ?? []), hubWatcher('by-review', 2, { parentToolUseId: 'review' })],
    })

    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    expect(cards()).toHaveLength(2)
    expect(screen.queryAllByRole('button')).toEqual([])

    // The subagent commits: that is something produced, under no todo, and the group shows for it alone.
    const made = hubCommit('e'.repeat(40), 'Note the review', 0, { subagentToolUseId: 'nested' })
    act(() => {
      fake.emit({ type: EventType.CommitsChanged, taskId: 't1', commits: [made] })
    })
    expect(kinds(UNFILED_HEADING)).toEqual(['1 change'])
    fireEvent.click(head(UNFILED_HEADING))
    expect(tiles(UNFILED_HEADING)).toEqual(['Change: Note the review'])
  })

  it('is the whole list in a task with no todos: the line, then the group alone, open, with no heading', async () => {
    await renderHub({ ...BEFORE, todos: undefined })

    expect(screen.getByText(NO_HUB_TODOS)).toBeInTheDocument()
    expect(screen.queryByText(NO_TODOS)).toBeNull()
    expect(screen.queryByRole('progressbar')).toBeNull()
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()
    expect(cards()).toHaveLength(1)
    expect(document.querySelector('[data-todo-head]')).toBeNull()
    const pills = screen.getByRole('group', { name: 'Show' })
    expect(
      within(pills)
        .getAllByRole('button')
        .map((pill) => pill.getAttribute('aria-label') ?? pill.textContent),
    ).toEqual(['All 2', '1 link', '1 change'])
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(2)

    // It filters, and remembers the filter.
    fireEvent.click(screen.getByRole('button', { name: '1 link' }))
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(1)
    expect(screen.getByRole('button', { name: '1 link' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('shows the Todos tab’s own centred empty state for a task with nothing at all: no todos, and nothing made', async () => {
    await renderHub({})
    const empty = screen.getByText(NO_TODOS)
    expect(empty).toHaveClass(todosStyles.empty ?? '')
    expect(screen.queryByText(NO_HUB_TODOS)).toBeNull()
    expect(screen.queryByRole('list', { name: 'Todos' })).toBeNull()
    // An empty list reads the same, and so does none.
    const { unmount } = render(<TodoHub taskId="t9" list={{ items: [], updatedAt: 1 }} />, {
      wrapper: storeWrapper().wrapper,
    })
    expect(screen.getAllByText(NO_TODOS)).toHaveLength(2)
    unmount()
    render(<TodoHub taskId="t9" list={null} />, { wrapper: storeWrapper().wrapper })
    expect(screen.getAllByText(NO_TODOS)).toHaveLength(2)
    expect(screen.queryByText(NO_HUB_TODOS)).toBeNull()
  })

  it('says “No todos for this task.” only for a task that produced something and kept no todos, whatever it produced', async () => {
    const made: HubTask[] = [
      { artifacts: [hubFile('docs/rate-limits.md', 'Rate limits reference')] },
      { artifacts: [hubLink(PR_511, 'Return Retry-After on 429s')] },
      { commits: [C1] },
      // Whatever else it has going on, and whatever is filed.
      { commits: [C1], toolEvents: [hubAgent('fix-501', 'fix-501')], watchers: [hubWatcher('watch-511')] },
    ]
    for (const task of made) {
      await renderHub(task)
      expect(screen.getByText(NO_HUB_TODOS)).toBeInTheDocument()
      expect(screen.queryByText(NO_TODOS)).toBeNull()
      expect(cards()).toHaveLength(1)
      cleanup()
    }
  })

  it('counts a task with only subagents and watchers as having nothing at all: it has produced nothing', async () => {
    const going: HubTask[] = [
      { toolEvents: [hubAgent('fix-501', 'fix-501')] },
      { watchers: [hubWatcher('watch-511')] },
      {
        toolEvents: [hubAgent('fix-501', 'fix-501'), hubAgent('fix-501-ci', 'fix-501-ci')],
        watchers: [hubWatcher('watch-511', 5, { parentToolUseId: 'fix-501' }), hubWatcher('watch-513')],
        // Filings left from before: a subagent's todo, for a todo the task no longer has.
        filings: [hubFiling(refOf.subagent('fix-501'), '1')],
      },
    ]
    for (const task of going) {
      await renderHub(task)
      expect(screen.getByText(NO_TODOS)).toHaveClass(todosStyles.empty ?? '')
      expect(screen.queryByText(NO_HUB_TODOS)).toBeNull()
      expect(screen.queryByRole('list', { name: 'Todos' })).toBeNull()
      cleanup()
    }
  })

  it('goes from one empty state to the other as the task makes its first thing, and to the summary with its first todo', async () => {
    const { fake } = await renderHub({})
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()

    // It makes something, with no todo list: the line, and the group alone.
    act(() => {
      fake.emit({ type: EventType.CommitsChanged, taskId: 't1', commits: [C1] })
    })
    expect(screen.queryByText(NO_TODOS)).toBeNull()
    expect(screen.getByText(NO_HUB_TODOS)).toBeInTheDocument()
    expect(cards()).toHaveLength(1)

    // It writes a todo: the summary, with neither line.
    act(() => {
      fake.emit({
        type: EventType.TodosChanged,
        taskId: 't1',
        todos: { items: [hubTodo('1', 'Fix the date formatting')], updatedAt: HUB_NOW },
      })
    })
    expect(screen.getByText('0 of 1 done')).toBeInTheDocument()
    expect(screen.queryByText(NO_HUB_TODOS)).toBeNull()
    expect(screen.queryByText(NO_TODOS)).toBeNull()

    // And back, as each goes: the todo list, then the commit.
    act(() => {
      fake.emit({ type: EventType.TodosChanged, taskId: 't1', todos: { items: [], updatedAt: HUB_NOW } })
    })
    expect(screen.getByText(NO_HUB_TODOS)).toBeInTheDocument()
    act(() => {
      fake.emit({ type: EventType.CommitsChanged, taskId: 't1', commits: [] })
    })
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()
    expect(screen.queryByText(NO_HUB_TODOS)).toBeNull()
  })

  it('knows which empty state to show before the filings are read, and when they can’t be', async () => {
    const failing = (): never => refuse(bridgeError(BridgeErrorCode.Internal, 'The database is locked')) as never
    // Nothing at all: the centred line, at once and for good.
    const nothing = storeWrapper(hubMain({}), { [CommandName.TodoHubGet]: failing })
    await act(() => nothing.store.getState().hydrate())
    const first = render(<HubForTask />, { wrapper: nothing.wrapper })
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()
    await act(() => Promise.resolve())
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()
    first.unmount()

    // Something made: the line at the top, never the centred one, though no group shows without the filings.
    const made = storeWrapper(hubMain({ commits: [C1] }), { [CommandName.TodoHubGet]: failing })
    await act(() => made.store.getState().hydrate())
    render(<HubForTask />, { wrapper: made.wrapper })
    expect(screen.getByText(NO_HUB_TODOS)).toBeInTheDocument()
    await act(() => Promise.resolve())
    expect(screen.getByText(NO_HUB_TODOS)).toBeInTheDocument()
    expect(screen.queryByText(NO_TODOS)).toBeNull()
    expect(cards()).toEqual([])
  })

  it('shows a child filed under a todo that isn’t in the list', async () => {
    await renderHub({
      ...BEFORE,
      filings: [hubFiling(refOf.link('https://github.com/acme/api/pull/42'), '99')],
    })
    expect(kinds(UNFILED_HEADING)).toEqual(['1 link', '1 change'])
  })
})

describe('the keyboard', () => {
  it('moves between todos with ↑ and ↓, the placeholder group included, and stops at the ends', async () => {
    await renderHub({ ...SHIP, filings: (SHIP.filings ?? []).filter(({ todoId }) => todoId !== '4') })
    const heads = [head(/#501/), head(/#502/), head(/Draft the 2.5/), head(/#503/), head(UNFILED_HEADING)]
    heads[0]?.focus()

    for (const next of heads.slice(1)) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
      expect(next).toHaveFocus()
    }
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowDown' })
    expect(heads[4]).toHaveFocus()
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowUp' })
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'ArrowUp' })
    expect(heads[2]).toHaveFocus()
    heads[0]?.focus()
    fireEvent.keyDown(heads[0] ?? document.body, { key: 'ArrowUp' })
    expect(heads[0]).toHaveFocus()
  })

  it('opens a todo with →, closes it with ←, and ↵ or Space does what a click does', async () => {
    await renderHub(SHIP)
    const first = head(/#501/)
    first.focus()

    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(first).toHaveAttribute('aria-expanded', 'true')
    // → on an open todo leaves it open.
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(first).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(first).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(first).toHaveAttribute('aria-expanded', 'false')
    fireEvent.keyDown(first, { key: 'Enter' })
    expect(first).toHaveAttribute('aria-expanded', 'true')
    fireEvent.keyDown(first, { key: ' ' })
    expect(first).toHaveAttribute('aria-expanded', 'false')
    // Any other key is left alone.
    fireEvent.keyDown(first, { key: 'a' })
    fireEvent.keyDown(first, { key: 'Tab' })
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(first).toHaveFocus()
  })

  it('leaves a key held with a modifier to whatever command has it: ⌥↓ is Next task, wherever the focus is', async () => {
    await renderHub(SHIP)
    const first = head(/#501/)
    first.focus()

    fireEvent.keyDown(first, { key: 'ArrowDown', altKey: true })
    fireEvent.keyDown(first, { key: 'ArrowUp', metaKey: true })
    expect(first).toHaveFocus()
    fireEvent.keyDown(first, { key: 'ArrowRight', altKey: true })
    fireEvent.keyDown(first, { key: 'Enter', metaKey: true })
    fireEvent.keyDown(first, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(first, { key: ' ', ctrlKey: true })
    expect(first).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens and closes the placeholder group the same way', async () => {
    await renderHub({ todos: [hubTodo('1', 'Open a PR')], commits: [C1] })
    const group = head(UNFILED_HEADING)

    fireEvent.keyDown(group, { key: 'ArrowRight' })
    expect(tiles(UNFILED_HEADING)).toEqual(['Change: Return Retry-After on 429 responses'])
    fireEvent.keyDown(group, { key: 'ArrowLeft' })
    expect(tiles(UNFILED_HEADING)).toEqual([])
    fireEvent.keyDown(group, { key: 'Enter' })
    expect(group).toHaveAttribute('aria-expanded', 'true')
  })

  it('reaches every todo, pill and tile with Tab: each takes the focus, and a closed todo’s counts are skipped', async () => {
    await renderHub(SHIP)
    for (const each of [head(/#501/), head(/Draft the 2.5/), head(/#503/)])
      expect(each).toHaveAttribute('tabindex', '0')
    for (const count of within(card(/#501/))
      .getAllByRole('button')
      .filter((button) => button.hasAttribute('data-kind'))) {
      expect(count).toHaveAttribute('tabindex', '-1')
    }

    fireEvent.keyDown(head(/#501/), { key: 'ArrowRight' })

    for (const pill of within(within(card(/#501/)).getByRole('group', { name: 'Show' })).getAllByRole('button')) {
      expect(pill).not.toHaveAttribute('tabindex')
    }
    for (const tile of card(/#501/).querySelectorAll('[role="group"][data-kind]')) {
      expect(tile).toHaveAttribute('tabindex', '0')
    }
  })

  it('leaves the arrow keys alone on a pill, a tile or a link in a todo’s text', async () => {
    await renderHub({
      ...SHIP,
      todos: [hubTodo('1', 'See https://example.com/limits for #501'), ...(SHIP.todos ?? []).slice(1)],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })
    const pill = kind(/See/, '2 links')
    pill.focus()
    fireEvent.keyDown(pill, { key: 'ArrowDown' })
    fireEvent.keyDown(pill, { key: 'ArrowLeft' })
    expect(pill).toHaveFocus()
    expect(head(/See/)).toHaveAttribute('aria-expanded', 'true')

    const tile = card(/See/).querySelector<HTMLElement>('[role="group"][data-kind]')
    tile?.focus()
    fireEvent.keyDown(tile ?? document.body, { key: 'ArrowUp' })
    expect(tile).toHaveFocus()

    const link = screen.getByRole('link', { name: 'https://example.com/limits' })
    link.focus()
    fireEvent.keyDown(link, { key: 'ArrowLeft' })
    fireEvent.keyDown(link, { key: 'Enter' })
    expect(head(/See/)).toHaveAttribute('aria-expanded', 'true')
    expect(link).toHaveFocus()
  })
})

describe('a todo’s menu', () => {
  it('copies the todo, and asks the agent about it, from a right-click or ⇧F10 on its head', async () => {
    const { main, store } = await renderHub(SHIP)

    fireEvent.contextMenu(head(/#502/))
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent)).toEqual(['Copy', 'Ask agent about this'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    await act(() => Promise.resolve())
    expect(main.copied).toEqual(['#502 Per-key limits for /search'])

    head(/#501/).focus()
    fireEvent.keyDown(head(/#501/), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask agent about this' }))
    expect(store.getState().inputInsertion).toEqual({
      taskId: 't1',
      text: 'About the todo “#501 Return Retry-After on 429s”: ',
      request: 1,
    })
    // Neither way of opening the menu opened the todo.
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'false')
    expect(head(/#502/)).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens the menu, and not the todo, when the key that opens menus is one that opens todos', async () => {
    // Context menu rebound to →, which opens a todo.
    const main = hubMain(SHIP)
    const settings = {
      ...DEFAULT_SETTINGS,
      keyBindings: { [WindowCommandId.ContextMenu]: 'ArrowRight' },
    }
    const wrapper = storeWrapper({ ...main, settings })
    await act(() => wrapper.store.getState().hydrate())
    render(<HubForTask />, { wrapper: wrapper.wrapper })
    await screen.findByRole('button', { name: '2 links' })

    const first = head(/#501/)
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    await act(() => Promise.resolve())

    expect(screen.getAllByRole('menuitem')).toHaveLength(2)
    expect(first).toHaveAttribute('aria-expanded', 'false')
  })

  it('is about the todo as it reads now, and opens none for a todo that has gone', async () => {
    const { fake, main } = await renderHub(SHIP)
    const [first, ...rest] = SHIP.todos ?? []
    const renamed = { ...first, text: '#501 Return Retry-After on every 429' } as Todo
    act(() => {
      fake.emit({
        type: EventType.TodosChanged,
        taskId: 't1',
        todos: { items: [renamed, ...rest], updatedAt: HUB_NOW },
      })
    })

    fireEvent.contextMenu(head(/every 429/))
    await act(() => Promise.resolve())
    // While the menu is open, the agent deletes the todo: the menu has nothing to act on.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    await act(() => Promise.resolve())
    expect(main.copied).toEqual(['#501 Return Retry-After on every 429'])

    fireEvent.contextMenu(head(/every 429/))
    await act(() => Promise.resolve())
    act(() => {
      fake.emit({ type: EventType.TodosChanged, taskId: 't1', todos: { items: rest, updatedAt: HUB_NOW } })
    })
    expect(screen.queryAllByRole('menuitem')).toEqual([])
  })
})

describe('reading the hub', () => {
  it('reads the task’s hub as it shows it, and has main watch its file artifacts until it no longer does', async () => {
    const main = hubMain(SHIP)
    const wrapper = storeWrapper(main)
    await act(() => wrapper.store.getState().hydrate())
    const view = render(<HubForTask />, { wrapper: wrapper.wrapper })
    await screen.findByRole('button', { name: '2 links' })

    expect(main.todoHubReads).toEqual(['t1'])
    expect(main.watchedArtifacts).toEqual(['watch t1'])
    view.unmount()
    expect(main.watchedArtifacts).toEqual(['watch t1', 'unwatch t1'])
  })

  it('shows the todos with nothing under them, and no group, until the filings are read', async () => {
    const main = hubMain(SHIP)
    let answer: () => void = () => undefined
    const waiting = new Promise<void>((resolve) => {
      answer = resolve
    })
    const wrapper = storeWrapper(main)
    await act(() => wrapper.store.getState().hydrate())
    const get = wrapper.fake.invoke.getMockImplementation()
    wrapper.fake.invoke.mockImplementation(async (command, request) => {
      if (command === CommandName.TodoHubGet) await waiting
      return get?.(command, request) as never
    })
    render(<HubForTask />, { wrapper: wrapper.wrapper })

    expect(cards()).toHaveLength(4)
    expect(screen.queryAllByRole('button')).toEqual([])
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()

    answer()
    expect(await screen.findByRole('button', { name: '2 links' })).toBeInTheDocument()
  })

  it('still shows the todos when the hub can’t be read, or main can’t watch the files', async () => {
    const failing = (): never => refuse(bridgeError(BridgeErrorCode.Internal, 'The database is locked')) as never
    const main = hubMain(SHIP)
    const wrapper = storeWrapper(main, {
      [CommandName.TodoHubGet]: failing,
      [CommandName.ArtifactsWatch]: failing,
      [CommandName.ArtifactsUnwatch]: failing,
    })
    await act(() => wrapper.store.getState().hydrate())
    const view = render(<HubForTask />, { wrapper: wrapper.wrapper })
    await act(() => Promise.resolve())

    expect(cards()).toHaveLength(4)
    expect(screen.queryAllByRole('button')).toEqual([])
    view.unmount()
    await act(() => Promise.resolve())
  })
})

describe('todos nothing can be filed under', () => {
  it('shows a todo with no id of its own as a card that doesn’t open, and files nothing under it', async () => {
    await renderHub({
      todos: [hubTodo(null, 'Find how uploads are stored'), hubTodo(null, 'Add an S3 backend', TodoState.Todo)],
      commits: [C1],
    })

    expect(cards()).toHaveLength(3)
    expect(kinds(/Find how uploads/)).toEqual([])
    fireEvent.keyDown(head(/Find how uploads/), { key: 'Enter' })
    expect(head(/Find how uploads/)).not.toHaveAttribute('aria-expanded')
    expect(kinds(UNFILED_HEADING)).toEqual(['1 change'])
  })

  it('gives two todos that share an id, which Claude Code never does, the children once: under the first', async () => {
    await renderHub({
      todos: [hubTodo('1', 'The first of them'), hubTodo('1', 'The second of them')],
      commits: [C1],
      filings: [hubFiling(refOf.commit(C1), '1')],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })

    expect(tiles(/The first of them/)).toEqual(['Change: Return Retry-After on 429 responses'])
    expect(kinds(/The second of them/)).toEqual([])
    expect(tiles(/The second of them/)).toEqual([])
  })
})

describe('the PRs, issues and tickets a todo names (#500)', () => {
  const TICKET = 'https://acme.atlassian.net/browse/API-123'
  const ISSUE_503 = 'https://github.com/acme/api/issues/503'

  /** The links in a card's head, each as its words and the address it opens. */
  function linksIn(text: string | RegExp): [string, string][] {
    return within(head(text))
      .queryAllByRole('link')
      .map((link) => [link.textContent, link.getAttribute('href') ?? ''])
  }

  /** Main sends the task's artifacts again: these. */
  function artifactsAre(fake: HubStore['fake'], artifacts: readonly Artifact[]): void {
    act(() => {
      fake.emit({ type: EventType.ArtifactsChanged, taskId: 't1', artifacts: [...artifacts] })
    })
  }

  it('links what a title and a status line name to the task’s own link, and leaves the rest of the text as it was', async () => {
    await renderHub(SHIP)

    expect(linksIn(/Return Retry-After/)).toEqual([
      ['#501', ISSUE_501],
      ['PR #511', PR_511],
    ])
    expect(head(/Return Retry-After/)).toHaveTextContent(
      'Doing: #501 Return Retry-After on 429sCI failed on PR #511 · fixing',
    )
    // The title's is in the title, and the status line's in the status line.
    const [issue, pr] = within(head(/Return Retry-After/)).getAllByRole('link')
    expect(issue?.parentElement).toHaveClass(styles.title ?? '')
    expect(pr?.parentElement).toHaveClass(styles.note ?? '')
    // The task has the PR the second todo's status line names, and no link for the issue its title names.
    expect(linksIn(/Per-key limits/)).toEqual([['PR #513', PR_513]])
    // Nothing it has is named by the third, and it has no link for the fourth's.
    expect(linksIn(/Draft the 2.5/)).toEqual([])
    expect(linksIn(/Document the rate limits/)).toEqual([])
  })

  it('is the app’s link: its address as its tooltip, in the Tab order, and in the app’s link style', async () => {
    await renderHub(SHIP)
    const link = screen.getByRole('link', { name: 'PR #511' })

    expect(link).toHaveAttribute('title', PR_511)
    expect(link).toHaveAttribute('href', PR_511)
    expect(link).toHaveClass(linkStyles.link ?? '')
    expect(link).not.toHaveAttribute('tabindex')
    link.focus()
    expect(link).toHaveFocus()
  })

  it('opens in the browser on a click, and neither opens nor closes the todo', async () => {
    const { main } = await renderHub(SHIP)
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'false')

    fireEvent.click(screen.getByRole('link', { name: '#501' }))
    await act(() => Promise.resolve())
    expect(main.opened).toEqual([ISSUE_501])
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'false')

    // Nor an open one, from its status line, with ⌘ held or not.
    fireEvent.click(head(/#501/))
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'true')
    fireEvent.click(screen.getByRole('link', { name: 'PR #511' }), { metaKey: true })
    await act(() => Promise.resolve())
    expect(main.opened).toEqual([ISSUE_501, PR_511])
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'true')
    // ↵ and Space on it are the link's, not the todo's.
    fireEvent.keyDown(screen.getByRole('link', { name: 'PR #511' }), { key: 'Enter' })
    fireEvent.keyDown(screen.getByRole('link', { name: 'PR #511' }), { key: ' ' })
    fireEvent.keyDown(screen.getByRole('link', { name: 'PR #511' }), { key: 'ArrowLeft' })
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'true')
  })

  it('has the link’s menu, not the todo’s: Open link and Copy link, and nothing to add, as the task has it already', async () => {
    const { main } = await renderHub(SHIP)
    const link = screen.getByRole('link', { name: 'PR #511' })

    fireEvent.contextMenu(link)
    await act(() => Promise.resolve())
    expect(screen.queryByRole('menu', { name: 'Todo actions' })).toBeNull()
    const menu = screen.getByRole('menu', { name: 'Link actions' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.textContent),
    ).toEqual(['Open link', 'Copy link'])
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Copy link' }))
    await act(() => Promise.resolve())
    expect(main.copied).toEqual([PR_511])
    // Choosing from it leaves the todo as it is, closed here: the menu's clicks aren't clicks on the todo.
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'false')

    // ⇧F10 on it opens the same menu, and an open todo stays open.
    fireEvent.click(head(/#501/))
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'true')
    link.focus()
    fireEvent.keyDown(link, { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(screen.queryByRole('menu', { name: 'Todo actions' })).toBeNull()
    const again = screen.getByRole('menu', { name: 'Link actions' })
    fireEvent.keyDown(within(again).getByRole('menuitem', { name: 'Open link' }), { key: 'ArrowLeft' })
    fireEvent.click(within(again).getByRole('menuitem', { name: 'Open link' }))
    await act(() => Promise.resolve())
    expect(main.opened).toEqual([PR_511])
    expect(head(/#501/)).toHaveAttribute('aria-expanded', 'true')
  })

  it('turns the words into a link when the link is added later, and back when it’s removed', async () => {
    const todos = [hubTodo('1', 'Watch CI on PR #42 until it’s green', TodoState.Doing, { note: 'Watching #42' })]
    const { fake } = await renderHub({ todos })
    expect(linksIn(/Watch CI/)).toEqual([])
    expect(head(/Watch CI/)).toHaveTextContent('Doing: Watch CI on PR #42 until it’s greenWatching #42')

    const pr = hubLink('https://github.com/acme/api/pull/42', 'Fix the UTC date test')
    artifactsAre(fake, [pr])
    expect(linksIn(/Watch CI/)).toEqual([
      ['PR #42', pr.url],
      ['#42', pr.url],
    ])
    expect(head(/Watch CI/)).toHaveTextContent('Doing: Watch CI on PR #42 until it’s greenWatching #42')

    artifactsAre(fake, [])
    expect(linksIn(/Watch CI/)).toEqual([])
    expect(head(/Watch CI/)).toHaveTextContent('Doing: Watch CI on PR #42 until it’s greenWatching #42')
  })

  it('follows the todo as its text changes: a status line that now names the PR, and one that no longer does', async () => {
    const { fake } = await renderHub(SHIP)
    const [first, ...rest] = SHIP.todos ?? []
    const noteIs = (note: string | null): void => {
      act(() => {
        fake.emit({
          type: EventType.TodosChanged,
          taskId: 't1',
          todos: { items: [{ ...first, note } as Todo, ...rest], updatedAt: HUB_NOW },
        })
      })
    }

    noteIs('Waiting on review')
    expect(linksIn(/Return Retry-After/)).toEqual([['#501', ISSUE_501]])
    noteIs('PR #511 is green; see also PR #513')
    expect(linksIn(/Return Retry-After/)).toEqual([
      ['#501', ISSUE_501],
      ['PR #511', PR_511],
      ['PR #513', PR_513],
    ])
    noteIs(null)
    expect(linksIn(/Return Retry-After/)).toEqual([['#501', ISSUE_501]])
  })

  it('leaves a number two of the task’s links share as text, and links it again once only one has it', async () => {
    const todos = [hubTodo('1', 'Watch CI on PR #42')]
    const api = hubLink('https://github.com/acme/api/pull/42', 'Fix the UTC date test')
    const web = hubLink('https://github.com/acme/web/pull/42', 'Show dates in UTC')
    const { fake } = await renderHub({ todos, artifacts: [api, web] })
    expect(linksIn(/Watch CI/)).toEqual([])

    artifactsAre(fake, [web])
    expect(linksIn(/Watch CI/)).toEqual([['PR #42', web.url]])
    artifactsAre(fake, [api])
    expect(linksIn(/Watch CI/)).toEqual([['PR #42', api.url]])
    artifactsAre(fake, [api, web])
    expect(linksIn(/Watch CI/)).toEqual([])
  })

  it('links a ticket by its key in capitals, and never a number inside a word or an address', async () => {
    await renderHub({
      todos: [
        hubTodo('1', 'Close API-123 once PR #511 lands', TodoState.Doing, { note: 'api-123 is waiting on fix#511' }),
        hubTodo('2', `Review ${PR_511} and example.com/#511`),
      ],
      artifacts: [hubLink(TICKET, 'Rate limits are too strict'), hubLink(PR_511, 'Return Retry-After on 429s')],
    })

    expect(linksIn(/Close/)).toEqual([
      ['API-123', TICKET],
      ['PR #511', PR_511],
    ])
    // The bare URL is the link it always was, whole; the number after the other address is text.
    expect(linksIn(/Review/)).toEqual([[PR_511, PR_511]])
    expect(within(head(/Review/)).getByRole('link')).not.toHaveAttribute('title')
  })

  it('links in a done todo’s title too, struck through as the title is', async () => {
    await renderHub({ ...SHIP, artifacts: [...(SHIP.artifacts ?? []), hubLink(ISSUE_503, 'Document the limits')] })

    expect(card(/Document the rate limits/)).toHaveClass(styles.done ?? '')
    expect(linksIn(/Document the rate limits/)).toEqual([['#503', ISSUE_503]])
  })

  it('links every reference of a todo that names five', async () => {
    const prs = [601, 602, 603, 604].map((number) =>
      hubLink(`https://github.com/acme/api/pull/${String(number)}`, 'A fix'),
    )
    await renderHub({
      todos: [hubTodo('1', 'Merge #601, #602, PR #603 and PR #604', TodoState.Doing, { note: 'For API-123' })],
      artifacts: [...prs, hubLink(TICKET, 'Rate limits are too strict')],
    })

    expect(linksIn(/Merge/).map(([words]) => words)).toEqual(['#601', '#602', 'PR #603', 'PR #604', 'API-123'])
    expect(head(/Merge/)).toHaveTextContent('Doing: Merge #601, #602, PR #603 and PR #604For API-123')
  })

  it('links each of 100 todos to its own PR, of 100 the task has', async () => {
    const prs = Array.from({ length: 100 }, (_, index) =>
      hubLink(`https://github.com/acme/api/pull/${String(index + 1)}`, `Fix ${String(index + 1)}`),
    )
    const todos = prs.map((_, index) => hubTodo(String(index + 1), `Review PR #${String(index + 1)}`))
    const { fake } = await renderHub({ todos, artifacts: prs })

    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(100)
    expect(new Set(links.map((link) => link.getAttribute('href'))).size).toBe(100)
    expect(linksIn(/Review PR #5$/)).toEqual([['PR #5', prs[4]?.url]])
    expect(linksIn(/Review PR #51$/)).toEqual([['PR #51', prs[50]?.url]])

    // Half of them go: those todos are text again, and the others keep their links.
    artifactsAre(fake, prs.slice(0, 50))
    expect(screen.getAllByRole('link')).toHaveLength(50)
    expect(linksIn(/Review PR #51$/)).toEqual([])
    expect(linksIn(/Review PR #50$/)).toEqual([['PR #50', prs[49]?.url]])
  })
})

describe('the hub under load', () => {
  it('shows 100 todos, each a card with its own counts, and opens the last without touching the rest', async () => {
    const todos = Array.from({ length: 100 }, (_, index) =>
      hubTodo(String(index + 1), `Step ${String(index + 1)} of the plan`),
    )
    const commits = todos.map((_, index) =>
      hubCommit(`${String(index).padStart(4, '0')}${'ab'.repeat(18)}`, `Commit for step ${String(index + 1)}`, index),
    )
    const filings = commits.map((commit, index) => hubFiling(refOf.commit(commit), String(index + 1)))
    await renderHub({ todos, commits, filings })

    expect(cards()).toHaveLength(100)
    expect(screen.getAllByRole('button', { name: '1 change' })).toHaveLength(100)
    expect(screen.getByText('0 of 100 done')).toBeInTheDocument()

    fireEvent.click(head('Step 100 of the plan'))

    expect(tiles('Step 100 of the plan')).toEqual(['Change: Commit for step 100'])
    expect(document.querySelectorAll('[role="group"][data-kind]')).toHaveLength(1)
    expect(screen.getAllByRole('button', { name: '1 change' })).toHaveLength(100)
  })

  it('shows 50 children under one todo, newest first, each kind alone under its pill, and none of its 30 subagents', async () => {
    const agents = Array.from({ length: 30 }, (_, index) =>
      hubAgent(
        `agent-${String(index)}`,
        `kitten-${String(index)}`,
        index,
        index < 12 ? {} : { state: ToolCallState.Done, finishedAt: minutesAgo(index) },
      ),
    )
    // A commit from each subagent, which follows it to its todo, and 20 links filed there themselves.
    const commits = agents.map(({ toolUseId }, index) =>
      hubCommit(`${String(index).padStart(4, '0')}${'cd'.repeat(18)}`, `Fix ${String(index)}`, index, {
        subagentToolUseId: toolUseId,
      }),
    )
    const links = Array.from({ length: 20 }, (_, index) =>
      hubLink(`https://github.com/acme/api/pull/${String(600 + index)}`, `PR ${String(600 + index)}`, 100 + index),
    )
    await renderHub({
      todos: [hubTodo('1', 'Review every open PR')],
      toolEvents: agents,
      watchers: agents.map(({ toolUseId }) => hubWatcher(`watch-${toolUseId}`, 1, { parentToolUseId: toolUseId })),
      artifacts: links,
      commits,
      filings: [
        ...agents.map(({ toolUseId }) => hubFiling(refOf.subagent(toolUseId), '1')),
        ...links.map(({ url }) => hubFiling(refOf.link(url), '1')),
      ],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })

    expect(kinds(/Review every/)).toEqual(['20 links', '30 changes'])
    const all = tiles(/Review every/)
    expect(all).toHaveLength(50)
    expect(all[0]).toBe('Change: Fix 0')
    expect(all[29]).toBe('Change: Fix 29')
    expect(all[30]).toBe('Link: PR 600')
    expect(all[49]).toBe('Link: PR 619')
    expect(card(/Review every/).querySelectorAll('[data-live]')).toHaveLength(0)
    expect(screen.queryByText(UNFILED_HEADING)).toBeNull()

    fireEvent.click(kind(/Review every/, '20 links'))
    expect(tiles(/Review every/)).toHaveLength(20)
  })

  it('wraps a long title and a long status line within its card, and cuts a long tile title short', async () => {
    const title = `Rewrite ${'the-very-long-module-name-'.repeat(12)}so it fits`
    const note = `Waiting on ${'a remarkably long explanation of what is happening '.repeat(8)}`.trim()
    const long = hubLink(
      PR_511,
      'A pull request whose title runs on and on and on past the end of the tile it is shown in',
    )
    await renderHub({
      todos: [hubTodo('1', title, TodoState.Doing, { note })],
      artifacts: [long],
      filings: [hubFiling(refOf.link(PR_511), '1')],
      todoPanels: [{ taskId: 't1', todoId: '1', open: true, filter: ChildFilter.All }],
    })

    expect(head(/Rewrite/)).toHaveTextContent(`Doing: ${title}${note}`)
    expect(within(card(/Rewrite/)).getByText(title)).toHaveClass(styles.title ?? '')
    expect(within(card(/Rewrite/)).getByText(note)).toHaveClass(styles.note ?? '')
    expect(tiles(/Rewrite/)).toEqual([`Link: ${long.title}`])
    expect(within(card(/Rewrite/)).getByTitle(long.title)).toBeInTheDocument()
  })

  it('shows a todo with one kind only as All and that kind', async () => {
    await renderHub({
      todos: [hubTodo('1', 'Watch the deploy')],
      commits: [C2, C3],
      filings: [hubFiling(refOf.commit(C2), '1'), hubFiling(refOf.commit(C3), '1')],
    })
    expect(kinds(/Watch the deploy/)).toEqual(['2 changes'])

    fireEvent.click(kind(/Watch the deploy/, '2 changes'))

    const pills = within(card(/Watch the deploy/)).getByRole('group', { name: 'Show' })
    expect(within(pills).getAllByRole('button')).toHaveLength(2)
    expect(tiles(/Watch the deploy/)).toHaveLength(2)
    expect(within(card(/Watch the deploy/)).getByRole('button', { name: 'All 2' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})
