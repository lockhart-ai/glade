import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import {
  AgentErrorKind,
  PauseReason,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  ToolCallState,
  ToolEventKind,
  UiStateKey,
  WatcherKind,
  WatcherState,
  type Task,
  type ToolCallEvent,
  type UiStateEntry,
} from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWatcher,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
  type FakeMain,
} from '../store/test-bridge'
import { TaskFilter } from '../../shared/attention'
import { WindowCommandId } from '../../shared/commands'
import { InputBar } from '../input-bar'
import { TaskList, TaskListToolbar } from '.'
import { NOW_REFRESH_MS } from './useNow'

const NOW = Date.UTC(2026, 8, 23, 11, 30)
const MINUTE = 60_000

/** A task that has run: its agent has a session. */
function task(id: string, title: string, minutesAgo: number, change: Partial<Task> = {}): Task {
  return { ...sampleTask(id, 'w1', title), sessionId: `session-${id}`, updatedAt: NOW - minutesAgo * MINUTE, ...change }
}

const TASKS: Task[] = [
  task('p1', 'Draft release notes for 2.4', 25, { pinned: true, status: 'Waiting on you: two questions' }),
  task('a1', 'Add rate limiting to public API', 4, { status: 'Waiting on you: pick a limit for /search' }),
  task('a2', 'Move image uploads to S3', 0, { status: 'Copying existing files', activity: TaskActivity.Working }),
  task('a3', 'Fix flaky login test', 9, { status: 'Found the race', unread: true }),
  task('d1', 'Upgrade Django', 3 * 24 * 60, { state: TaskState.Done, status: 'Upgraded to 5.2' }),
  { ...task('x1', 'Another workspace’s task', 1), workspaceId: 'w2' },
]

interface Rendered {
  store: GladeStore
  fake: FakeBridge
}

async function renderList(
  tasks: Task[] = TASKS,
  uiState: UiStateEntry[] = [],
  overrides: Partial<FakeHandlers> = {},
  main: Partial<FakeMain> = {},
): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
      tasks: [...tasks],
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }, ...uiState],
      ...main,
    },
    overrides,
  )
  const store = createGladeStore(fake.bridge)
  await act(() => store.getState().hydrate())
  render(
    <GladeStoreProvider store={store}>
      <ToastProvider>
        <TaskListToolbar workspaceId="w1" />
        <TaskList workspaceId="w1" />
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { store, fake }
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function rowTitles(name: string): string[] {
  return within(section(name))
    .queryAllByRole('button')
    .slice(1)
    .map((row) => row.firstElementChild?.textContent ?? '')
}

function row(title: string): HTMLElement {
  // Anchored and followed by the time, so it doesn't match the New task button.
  return screen.getByRole('button', { name: new RegExp(`^${title}.+`) })
}

function chip(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Filter tasks' })).getByRole('button', {
    name: new RegExp(`^${name}`),
  })
}

function pressAlt(key: 'ArrowUp' | 'ArrowDown', target: Element | Window = window): void {
  fireEvent.keyDown(target, { key, altKey: true })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('TaskList', () => {
  it('shows every section, with a zero count, in an empty workspace', async () => {
    await renderList([])

    expect(section('Pinned')).toHaveTextContent(/^Pinned0$/)
    expect(section('Active')).toHaveTextContent(/^Active0$/)
    expect(section('Done')).toHaveTextContent(/^Done0$/)
  })

  it('shows the workspace’s tasks in Pinned, Active and Done, most recently updated first, with counts', async () => {
    await renderList(TASKS, [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }])

    expect(rowTitles('Pinned')).toEqual(['Draft release notes for 2.425m'])
    expect(rowTitles('Active')).toEqual([
      'Move image uploads to S3now',
      'Add rate limiting to public API4m',
      'Fix flaky login test9m',
    ])
    expect(rowTitles('Done')).toEqual(['Upgrade Django3d'])
    expect(within(section('Pinned')).getByRole('button', { expanded: true })).toHaveTextContent('Pinned1')
    expect(within(section('Active')).getByRole('button', { expanded: true })).toHaveTextContent('Active3')
    expect(screen.queryByText('Another workspace’s task')).toBeNull()
  })

  it('shows a row’s status, and stand-ins for a missing title or status', async () => {
    await renderList(
      [task('n1', '', 0), task('d1', 'Finished', 0, { state: TaskState.Done })],
      [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }],
    )

    expect(row('New task')).toHaveTextContent('New tasknowWaiting for instructions')
    expect(row('Finished')).toHaveTextContent(/^Finishednow$/)
  })

  it('says what stopped the agent in place of the status while an error has, with a pink dot', async () => {
    const error = {
      kind: AgentErrorKind.Transient,
      source: TaskErrorSource.Api,
      status: 529,
      code: 'overloaded',
      details: 'API Error: 529 Overloaded',
      retries: 3,
      retryingMs: 120_000,
    }
    await renderList([
      task('e1', 'Fix flaky login test', 0, { status: 'Found the race', activity: TaskActivity.Error, error }),
    ])

    expect(row('Fix flaky login test')).toHaveTextContent('Fix flaky login testnowError: API overloaded · retry?')
    expect(row('Fix flaky login test').querySelector('[data-state]')).toHaveAttribute('data-state', 'error')
  })

  it('says why a paused task is paused and when it resumes in place of the status, with a blue dot', async () => {
    const resumesAt = new Date(2099, 8, 23, 11, 42).getTime()
    const pause = { reason: PauseReason.UsageLimit, since: 0, resumesAt, checks: 0, details: 'Limit.' }
    await renderList([task('p1', 'Move image uploads to S3', 0, { activity: TaskActivity.Paused, pause })])

    expect(row('Move image uploads to S3')).toHaveTextContent(
      'Move image uploads to S3nowPaused: usage limit · resumes Sep 23 11:42',
    )
    expect(row('Move image uploads to S3').querySelector('[data-state]')).toHaveAttribute('data-state', 'working')
  })

  it('marks an unread row with a blue dot', async () => {
    await renderList()

    expect(within(row('Fix flaky login test')).getByRole('img', { name: 'Unread' })).toBeInTheDocument()
    expect(within(row('Add rate limiting')).queryByRole('img', { name: 'Unread' })).toBeNull()
  })

  it('counts a row’s live watchers on its indicators line, done or not, and follows them', async () => {
    const watchers = [
      sampleWatcher('ci', 'a1'),
      sampleWatcher('queue', 'a1', { kind: WatcherKind.Cron, state: WatcherState.Scheduled }),
      sampleWatcher('ended', 'a1', { state: WatcherState.Finished }),
      sampleWatcher('only-ended', 'a3', { state: WatcherState.Stopped }),
      sampleWatcher('backup', 'd1', { kind: WatcherKind.Cron, state: WatcherState.Suspended }),
    ]
    const { fake } = await renderList(
      TASKS,
      [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }],
      {},
      { watchers },
    )
    const mark = (title: string) => within(row(title)).queryByRole('img', { name: /watchers? running$/ })

    expect(mark('Add rate limiting')).toHaveAccessibleName('2 watchers running')
    expect(mark('Add rate limiting')).toHaveTextContent('2')
    expect(mark('Add rate limiting')?.parentElement).toHaveAttribute('data-indicators')
    expect(mark('Upgrade Django')).toHaveAccessibleName('1 watcher running')
    expect(mark('Fix flaky login test')).toBeNull()
    expect(mark('Move image uploads')).toBeNull()

    act(() => {
      fake.emit({ type: EventType.WatchersChanged, taskId: 'a1', watchers: [sampleWatcher('ci', 'a1')] })
      fake.emit({ type: EventType.WatchersChanged, taskId: 'd1', watchers: [] })
    })
    expect(mark('Add rate limiting')).toHaveAccessibleName('1 watcher running')
    expect(mark('Upgrade Django')).toBeNull()
    // With nothing left to show, the row is back to its two lines.
    expect(row('Upgrade Django').querySelector('[data-indicators]')).toBeNull()
  })

  it('counts a row’s running subagents, from main on start and then from events, for a task that isn’t open', async () => {
    const running = (id: string, taskId: string, change: Partial<ToolCallEvent> = {}): ToolCallEvent => ({
      id,
      taskId,
      turn: 1,
      createdAt: NOW,
      kind: ToolEventKind.ToolCall,
      name: 'Agent',
      input: { description: id },
      output: null,
      state: ToolCallState.Running,
      finishedAt: null,
      toolUseId: `use-${id}`,
      parentToolUseId: null,
      progressSummary: null,
      ...change,
    })
    const { fake } = await renderList(
      TASKS,
      [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }],
      {},
      {
        toolEvents: [
          running('api', 'a1'),
          running('dashboard', 'a1'),
          running('nested', 'a1', { parentToolUseId: 'use-api' }),
          running('links', 'a1', { state: ToolCallState.Done, output: 'Done.' }),
          running('read', 'a1', { name: 'Read' }),
          running('cleanup', 'd1', { name: 'Task' }),
        ],
      },
    )
    const count = (title: string) => within(row(title)).queryByRole('img', { name: /subagents? running$/ })

    // None of these tasks is open: the counts come from what main says is running.
    expect(count('Add rate limiting')).toHaveAccessibleName('3 subagents running')
    expect(count('Add rate limiting')).toHaveAttribute('title', '3 subagents running')
    expect(count('Add rate limiting')).toHaveTextContent(/^3$/)
    expect(count('Upgrade Django')).toHaveAccessibleName('1 subagent running')
    expect(count('Move image uploads')).toBeNull()
    expect(row('Move image uploads').querySelector('[data-indicators]')).toBeNull()

    act(() => {
      fake.emit({ type: EventType.ToolEventAppended, toolEvent: running('upload', 'a2') })
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: running('api', 'a1', { state: ToolCallState.Done, output: 'Done.' }),
      })
      fake.emit({
        type: EventType.ToolEventUpdated,
        toolEvent: running('cleanup', 'd1', { name: 'Task', state: ToolCallState.Interrupted, output: 'Stopped.' }),
      })
    })
    expect(count('Move image uploads')).toHaveAccessibleName('1 subagent running')
    expect(count('Add rate limiting')).toHaveAccessibleName('2 subagents running')
    expect(count('Upgrade Django')).toBeNull()
    expect(row('Upgrade Django').querySelector('[data-indicators]')).toBeNull()
  })

  it('shows each row’s dot for its indicator', async () => {
    await renderList(TASKS, [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }])

    const dotOf = (title: string): string | null =>
      row(title).querySelector('[data-state]')?.getAttribute('data-state') ?? null
    expect(dotOf('Add rate limiting')).toBe('waiting')
    expect(dotOf('Move image uploads')).toBe('working')
    expect(dotOf('Upgrade Django')).toBe('done')
  })

  it('selects a task when its row is clicked', async () => {
    const { store } = await renderList()

    fireEvent.click(row('Fix flaky login test'))

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('a3')
    })
    expect(row('Fix flaky login test')).toHaveAttribute('aria-current', 'true')
    expect(row('Add rate limiting')).not.toHaveAttribute('aria-current')
  })

  it('moves the selection through the expanded sections with ⌥↑ and ⌥↓', async () => {
    const { store } = await renderList(TASKS, [{ key: UiStateKey.SelectedTaskId, value: 'a2' }])
    const selected = (): string | null => store.getState().selectedTaskId

    pressAlt('ArrowDown')
    await vi.waitFor(() => {
      expect(selected()).toBe('a1')
    })
    pressAlt('ArrowUp')
    await vi.waitFor(() => {
      expect(selected()).toBe('a2')
    })
    pressAlt('ArrowUp')
    await vi.waitFor(() => {
      expect(selected()).toBe('p1')
    })
    // Done is collapsed, so the last active task is the bottom of the list.
    act(() => {
      pressAlt('ArrowUp')
    })
    expect(selected()).toBe('p1')
  })

  it('scrolls a newly selected row into view when it’s off screen, and leaves one that shows where it is', async () => {
    const { store } = await renderList(TASKS, [{ key: UiStateKey.SelectedTaskId, value: 'a2' }])
    const scrollIntoView = vi.fn()
    Element.prototype.scrollIntoView = scrollIntoView
    // The list shows 0–100px; the row for a1 is below that, the rest within it.
    const rect = (top: number): DOMRect => DOMRect.fromRect({ x: 0, y: top, width: 100, height: 40 })
    const bounds = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function bounds(
      this: Element,
    ) {
      if (this.textContent.startsWith('Add rate limiting')) return rect(300)
      return this.getAttribute('data-task-id') === null ? DOMRect.fromRect({ height: 100 }) : rect(10)
    })

    pressAlt('ArrowDown')
    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('a1')
    })
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' })
    pressAlt('ArrowUp')
    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('a2')
    })
    expect(scrollIntoView).toHaveBeenCalledOnce()
    bounds.mockRestore()
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  it('starts from the top with ⌥↓ when nothing is selected', async () => {
    const { store } = await renderList()

    pressAlt('ArrowDown')

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('p1')
    })
  })

  it('jumps to the next task that needs you with ⌘⌥↓, going round from the top, even from a text field', async () => {
    const { store } = await renderList(TASKS, [{ key: UiStateKey.SelectedTaskId, value: 'a2' }])
    const search = screen.getByRole('searchbox', { name: 'Search tasks' })
    const press = (target: Element | Window = window): boolean =>
      fireEvent.keyDown(target, { key: 'ArrowDown', altKey: true, metaKey: true })

    // a2 is working; a1 and a3 are waiting on you, and so is the pinned p1.
    for (const [target, expected] of [
      [window, 'a1'],
      [search, 'a3'],
      [window, 'p1'],
      [window, 'a1'],
    ] as const) {
      expect(press(target)).toBe(false)
      await vi.waitFor(() => {
        expect(store.getState().selectedTaskId).toBe(expected)
      })
    }
  })

  it('stays put on ⌘⌥↓ when no other task needs you', async () => {
    const { store, fake } = await renderList(TASKS.slice(1, 3), [{ key: UiStateKey.SelectedTaskId, value: 'a1' }])
    fake.invoke.mockClear()

    expect(fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true, metaKey: true })).toBe(false)

    expect(fake.invoke).not.toHaveBeenCalled()
    expect(store.getState().selectedTaskId).toBe('a1')
  })

  it('leaves other keys, other modifiers and text fields alone', async () => {
    const { store, fake } = await renderList()
    fake.invoke.mockClear()

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true, ctrlKey: true })
    pressAlt('ArrowDown', screen.getByRole('searchbox', { name: 'Search tasks' }))

    expect(fake.invoke).not.toHaveBeenCalled()
    expect(store.getState().selectedTaskId).toBeNull()
  })

  it('does nothing on ⌥↓ with no tasks', async () => {
    const { fake } = await renderList([])
    fake.invoke.mockClear()

    pressAlt('ArrowDown')

    expect(fake.invoke).not.toHaveBeenCalled()
  })

  it('collapses and expands a section, and remembers it', async () => {
    const { fake } = await renderList()
    const header = within(section('Active')).getByRole('button', { name: /Active/ })

    fireEvent.click(header)

    await vi.waitFor(() => {
      expect(header).toHaveAttribute('aria-expanded', 'false')
    })
    expect(rowTitles('Active')).toEqual([])
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.UiStateSet, {
      key: UiStateKey.ActiveSectionCollapsed,
      value: 'true',
    })

    const done = within(section('Done')).getByRole('button', { name: /Done/ })
    expect(done).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(done)
    await vi.waitFor(() => {
      expect(rowTitles('Done')).toEqual(['Upgrade Django3d'])
    })
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.UiStateSet, {
      key: UiStateKey.DoneSectionCollapsed,
      value: 'false',
    })
  })

  it('restores collapsed sections from the saved UI state', async () => {
    await renderList(TASKS, [{ key: UiStateKey.PinnedSectionCollapsed, value: 'true' }])

    expect(within(section('Pinned')).getByRole('button', { name: /Pinned/ })).toHaveAttribute('aria-expanded', 'false')
    expect(rowTitles('Pinned')).toEqual([])
    expect(section('Pinned')).toHaveTextContent('Pinned1')
  })

  it('updates live as tasks change', async () => {
    const { fake } = await renderList()

    act(() => {
      fake.emit({
        type: EventType.TaskUpdated,
        task: task('a3', 'Fix flaky login test', 0, { pinned: true, status: 'Passing' }),
      })
    })
    expect(rowTitles('Pinned')).toEqual(['Fix flaky login testnow', 'Draft release notes for 2.425m'])
    expect(rowTitles('Active')).toEqual(['Move image uploads to S3now', 'Add rate limiting to public API4m'])

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: task('n1', '', 0) })
    })
    expect(rowTitles('Active')).toContain('New tasknow')
  })

  it('moves relative times on as time passes', async () => {
    await renderList()
    expect(row('Move image uploads')).toHaveTextContent('now')

    act(() => {
      vi.advanceTimersByTime(4 * NOW_REFRESH_MS)
    })

    expect(row('Move image uploads')).toHaveTextContent('2m')
  })
})

describe('TaskListToolbar', () => {
  it('shows the search field and the filter chips, with All on', async () => {
    await renderList()

    expect(screen.getByRole('searchbox', { name: 'Search tasks' })).toHaveAttribute('placeholder', 'Search')
    const chips = within(screen.getByRole('group', { name: 'Filter tasks' })).getAllByRole('button')
    expect(chips.map((chip) => [chip.textContent, chip.getAttribute('aria-pressed')])).toEqual([
      ['All', 'true'],
      // The active tasks in w1 whose agent is waiting on you.
      ['Needs you3', 'false'],
      ['Unread1', 'false'],
    ])
  })

  it('counts the tasks that need you: active, turn over (waiting or errored), and run at least once', async () => {
    await renderList([
      task('w', 'Waiting', 1),
      task('e', 'Errored', 2, { activity: TaskActivity.Error }),
      task('e0', 'Failed before its session started', 3, { activity: TaskActivity.Error, sessionId: null }),
      task('k', 'Working', 4, { activity: TaskActivity.Working }),
      task('n', 'Brand new', 5, { sessionId: null }),
      task('d', 'Done', 6, { state: TaskState.Done, unread: true }),
      task('p', 'Pinned', 7, { pinned: true, unread: true }),
    ])

    expect(chip('Needs you')).toHaveTextContent('Needs you4')
    expect(chip('Unread')).toHaveTextContent('Unread2')
  })

  it('filters the list to the tasks that need you, or the unread ones, and remembers the choice', async () => {
    const { fake } = await renderList(TASKS, [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }])

    fireEvent.click(chip('Needs you'))

    await vi.waitFor(() => {
      expect(chip('Needs you')).toHaveAttribute('aria-pressed', 'true')
    })
    expect(chip('All')).toHaveAttribute('aria-pressed', 'false')
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.UiStateSet, {
      key: UiStateKey.TaskFilter,
      value: TaskFilter.NeedsYou,
    })
    expect(rowTitles('Pinned')).toEqual(['Draft release notes for 2.425m'])
    expect(rowTitles('Active')).toEqual(['Add rate limiting to public API4m', 'Fix flaky login test9m'])
    expect(rowTitles('Done')).toEqual([])
    // Each section counts what it shows; the chips count the whole workspace.
    expect(section('Active')).toHaveTextContent(/^Active2/)
    expect(section('Done')).toHaveTextContent(/^Done0$/)
    expect(chip('Unread')).toHaveTextContent('Unread1')

    fireEvent.click(chip('Unread'))
    await vi.waitFor(() => {
      expect(rowTitles('Active')).toEqual(['Fix flaky login test9m'])
    })
    expect(rowTitles('Pinned')).toEqual([])

    fireEvent.click(chip('All'))
    await vi.waitFor(() => {
      expect(rowTitles('Active')).toHaveLength(3)
    })
    expect(fake.invoke).toHaveBeenLastCalledWith(CommandName.UiStateSet, {
      key: UiStateKey.TaskFilter,
      value: TaskFilter.All,
    })
  })

  it('does nothing when the chosen chip is clicked again', async () => {
    const { fake } = await renderList()

    fireEvent.click(chip('All'))

    expect(fake.invoke).not.toHaveBeenCalledWith(CommandName.UiStateSet, expect.anything())
  })

  it('restores the chosen filter, and moves ⌥↓ through the rows it shows', async () => {
    const { store } = await renderList(TASKS, [
      { key: UiStateKey.TaskFilter, value: TaskFilter.NeedsYou },
      { key: UiStateKey.SelectedTaskId, value: 'p1' },
    ])

    expect(chip('Needs you')).toHaveAttribute('aria-pressed', 'true')
    expect(rowTitles('Active')).toEqual(['Add rate limiting to public API4m', 'Fix flaky login test9m'])

    pressAlt('ArrowDown')
    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('a1')
    })
  })

  it('shows All for a stored filter it does not know', async () => {
    await renderList(TASKS, [{ key: UiStateKey.TaskFilter, value: 'starred' }])

    expect(chip('All')).toHaveAttribute('aria-pressed', 'true')
    expect(rowTitles('Active')).toHaveLength(3)
  })

  it('keeps the counts and the filtered rows live as tasks change', async () => {
    const { fake } = await renderList(TASKS, [{ key: UiStateKey.TaskFilter, value: TaskFilter.Unread }])

    act(() => {
      fake.emit({
        type: EventType.TaskUpdated,
        task: task('a1', 'Add rate limiting to public API', 4, { unread: true }),
      })
    })
    expect(chip('Unread')).toHaveTextContent('Unread2')
    expect(rowTitles('Active')).toEqual(['Add rate limiting to public API4m', 'Fix flaky login test9m'])

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: task('a3', 'Fix flaky login test', 9) })
      fake.emit({
        type: EventType.TaskUpdated,
        task: task('a2', 'Move image uploads to S3', 0, { activity: TaskActivity.Waiting }),
      })
    })
    expect(chip('Unread')).toHaveTextContent('Unread1')
    expect(chip('Needs you')).toHaveTextContent('Needs you4')
    expect(rowTitles('Active')).toEqual(['Add rate limiting to public API4m'])
  })

  it('creates a task in the workspace with +, and selects it', async () => {
    const { store, fake } = await renderList()

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('task-7')
    })
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TasksCreate, { workspaceId: 'w1' })
    expect(row('New task')).toHaveAttribute('aria-current', 'true')
    await vi.waitFor(() => {
      expect(store.getState().inputFocusRequest).toBe(1)
    })
  })

  it('shows a toast when a task can’t be created', async () => {
    await renderList(TASKS, [], {
      [CommandName.TasksCreate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w1')),
    })

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))

    expect(await screen.findByText('No workspace w1')).toBeInTheDocument()
  })
})

describe('the task context menu', () => {
  /** Opens a row's menu with a right-click, and answers its items' labels. */
  async function openMenu(title: string): Promise<string[]> {
    fireEvent.contextMenu(row(title))
    await act(() => Promise.resolve())
    return screen.getAllByRole('menuitem').map((item) => item.textContent)
  }

  async function choose(title: string, label: string): Promise<void> {
    await openMenu(title)
    fireEvent.click(screen.getByRole('menuitem', { name: new RegExp(`^${label}`) }))
    await act(() => Promise.resolve())
  }

  const DONE_OPEN = [{ key: UiStateKey.DoneSectionCollapsed, value: 'false' }]

  it('opens on a row with a right-click, or ⇧F10 on the focused row, with the items for its state', async () => {
    await renderList(TASKS, DONE_OPEN)

    expect(await openMenu('Add rate limiting')).toEqual([
      'Open↵',
      'Pin to top⌘⇧P',
      'Rename…F2',
      'Mark as unread⌘⇧U',
      'Mark done⌘⇧D',
      'Copy link to task',
      'Delete task…',
    ])
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    fireEvent.keyDown(row('Upgrade Django'), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    expect(screen.getByRole('menu', { name: 'Task actions' })).toHaveTextContent(/^Open↵Pin to topRename…Reopen/)
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })

    expect(await openMenu('Draft release notes')).toContain('Unpin⌘⇧P')
  })

  it('opens, pins, renames, marks unread and deletes (asking first) through the store', async () => {
    const { store } = await renderList()

    await choose('Add rate limiting', 'Open')
    expect(store.getState().selectedTaskId).toBe('a1')

    await choose('Add rate limiting', 'Pin to top')
    expect(store.getState().tasks.a1?.pinned).toBe(true)

    await choose('Add rate limiting', 'Mark as unread')
    expect(store.getState().tasks.a1?.unread).toBe(true)

    await choose('Add rate limiting', 'Rename…')
    expect(store.getState().renamingTaskId).toBe('a1')
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Task title' }), { key: 'Escape' })

    await choose('Move image uploads', 'Delete task…')
    expect(store.getState().deletingTaskId).toBe('a2')
    expect(store.getState().tasks.a2).toBeDefined()
  })

  it('marks a task done with the Undo toast, and reopens a done one', async () => {
    const { store } = await renderList()

    await choose('Fix flaky login test', 'Mark done')
    await vi.waitFor(() => {
      expect(store.getState().tasks.a3?.state).toBe(TaskState.Done)
    })
    expect(await screen.findByRole('button', { name: 'Undo' })).toBeInTheDocument()

    await choose('Upgrade Django', 'Reopen')
    expect(store.getState().tasks.d1?.state).toBe(TaskState.Active)
  })

  it('copies a task’s link, and a done task’s outcome', async () => {
    const copied: string[] = []
    await renderList(TASKS, DONE_OPEN, {}, { copied })

    await choose('Add rate limiting', 'Copy link to task')
    await choose('Upgrade Django', 'Copy outcome')

    expect(copied).toEqual(['glade://task/a1', 'Upgraded to 5.2'])
  })

  it('shows a toast when an item’s command fails', async () => {
    await renderList(TASKS, [], {
      [CommandName.ClipboardWriteText]: () => refuse(bridgeError(BridgeErrorCode.Internal, 'No clipboard')),
    })

    await choose('Add rate limiting', 'Copy link to task')

    expect(await screen.findByText('No clipboard')).toBeInTheDocument()
  })
})

describe('⌥↓ / ⌥↑ from the input bar', () => {
  /** The task list beside the selected task's input bar, with the focus in its message field. */
  async function renderWithBar(uiState: UiStateEntry[]): Promise<Rendered> {
    const fake = fakeBridge({
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
      tasks: [...TASKS],
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }, ...uiState],
    })
    const store = createGladeStore(fake.bridge)
    await act(() => store.getState().hydrate())
    render(
      <GladeStoreProvider store={store}>
        <ToastProvider>
          <TaskList workspaceId="w1" />
          <InputBar />
        </ToastProvider>
      </GladeStoreProvider>,
    )
    act(() => {
      field().focus()
    })
    return { store, fake }
  }

  function field(): HTMLTextAreaElement {
    return screen.getByRole('textbox', { name: 'Message the agent' })
  }

  /** Presses ⌥ and an arrow in the message field; answers whether the field's own action (moving the caret) went ahead. */
  async function pressInField(key: 'ArrowUp' | 'ArrowDown', init: Partial<KeyboardEventInit> = {}): Promise<boolean> {
    let allowed = true
    await act(async () => {
      allowed = fireEvent.keyDown(field(), { key, altKey: true, ...init })
      await Promise.resolve()
    })
    return allowed
  }

  /** Waits for the task to be selected, with the focus in its input bar. */
  async function selectedWithFocus(store: GladeStore, taskId: string): Promise<void> {
    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe(taskId)
      expect(field()).toHaveFocus()
    })
  }

  it('selects the next task with ⌥↓ in the message field, and the focus goes on to its input bar', async () => {
    const { store } = await renderWithBar([{ key: UiStateKey.SelectedTaskId, value: 'a2' }])

    expect(await pressInField('ArrowDown')).toBe(false)

    await selectedWithFocus(store, 'a1')
    expect(row('Add rate limiting')).toHaveAttribute('aria-current', 'true')
  })

  it('goes across sections with ⌥↑ and ⌥↓, as in the list', async () => {
    const { store } = await renderWithBar([
      { key: UiStateKey.SelectedTaskId, value: 'a3' },
      { key: UiStateKey.DoneSectionCollapsed, value: 'false' },
    ])

    await pressInField('ArrowDown')
    await selectedWithFocus(store, 'd1')
    expect(field()).toHaveAttribute('placeholder', 'Send a message to reopen this task…')
    for (const expected of ['a3', 'a1', 'a2', 'p1']) {
      await pressInField('ArrowUp')
      await selectedWithFocus(store, expected)
    }
  })

  it('stays put at either end of the list, leaving the draft and the focus where they are', async () => {
    const { store, fake } = await renderWithBar([{ key: UiStateKey.SelectedTaskId, value: 'p1' }])
    fireEvent.change(field(), { target: { value: 'Half a thought' } })
    fake.invoke.mockClear()

    expect(await pressInField('ArrowUp')).toBe(false)
    expect(store.getState().selectedTaskId).toBe('p1')
    expect(field()).toHaveFocus()
    expect(field()).toHaveValue('Half a thought')

    // Done is collapsed, so the last active task is the bottom of the list.
    await act(() => store.getState().selectTask('a3'))
    act(() => {
      field().focus()
    })
    fake.invoke.mockClear()
    expect(await pressInField('ArrowDown')).toBe(false)
    expect(store.getState().selectedTaskId).toBe('a3')
    expect(field()).toHaveFocus()
    expect(fake.invoke).not.toHaveBeenCalled()
  })

  it('skips a collapsed section', async () => {
    const { store } = await renderWithBar([
      { key: UiStateKey.SelectedTaskId, value: 'p1' },
      { key: UiStateKey.ActiveSectionCollapsed, value: 'true' },
      { key: UiStateKey.DoneSectionCollapsed, value: 'false' },
    ])

    await pressInField('ArrowDown')
    await selectedWithFocus(store, 'd1')
    await pressInField('ArrowUp')
    await selectedWithFocus(store, 'p1')
  })

  it('keeps each task’s draft as it switches away and back', async () => {
    const { store } = await renderWithBar([{ key: UiStateKey.SelectedTaskId, value: 'a2' }])
    fireEvent.change(field(), { target: { value: 'Use the Glacier storage class.' } })

    await pressInField('ArrowDown')
    await selectedWithFocus(store, 'a1')
    expect(field()).toHaveValue('')
    await pressInField('ArrowUp')
    await selectedWithFocus(store, 'a2')

    expect(field()).toHaveValue('Use the Glacier storage class.')
  })

  it('follows the keys you rebound it to, leaving ⌥↓ to the field', async () => {
    const { store } = await renderWithBar([{ key: UiStateKey.SelectedTaskId, value: 'a2' }])
    await act(() =>
      store.getState().updateSettings({
        keyBindings: { [WindowCommandId.NextTask]: 'Ctrl+Alt+J', [WindowCommandId.PreviousTask]: 'Ctrl+Alt+K' },
      }),
    )

    expect(await pressInField('ArrowDown')).toBe(true)
    expect(store.getState().selectedTaskId).toBe('a2')

    await act(async () => {
      fireEvent.keyDown(field(), { key: '∆', code: 'KeyJ', ctrlKey: true, altKey: true })
      await Promise.resolve()
    })
    await selectedWithFocus(store, 'a1')
    await act(async () => {
      fireEvent.keyDown(field(), { key: '˚', code: 'KeyK', ctrlKey: true, altKey: true })
      await Promise.resolve()
    })
    await selectedWithFocus(store, 'a2')
  })

  it('leaves the focus where it was when ⌥↓ is pressed outside the message field', async () => {
    const { store } = await renderWithBar([{ key: UiStateKey.SelectedTaskId, value: 'a2' }])
    act(() => {
      field().blur()
    })

    pressAlt('ArrowDown')

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('a1')
    })
    expect(document.body).toHaveFocus()
  })
})
