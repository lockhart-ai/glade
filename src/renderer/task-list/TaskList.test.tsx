import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeError, BridgeErrorCode, CommandName, EventType } from '../../shared/bridge'
import { TaskActivity, TaskState, UiStateKey, type Task, type UiStateEntry } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import {
  fakeBridge,
  refuse,
  sampleTask,
  sampleWorkspace,
  type FakeBridge,
  type FakeHandlers,
} from '../store/test-bridge'
import { TaskList, TaskListToolbar } from '.'
import { NOW_REFRESH_MS } from './useNow'

const NOW = Date.UTC(2026, 8, 23, 11, 30)
const MINUTE = 60_000

function task(id: string, title: string, minutesAgo: number, change: Partial<Task> = {}): Task {
  return { ...sampleTask(id, 'w1', title), updatedAt: NOW - minutesAgo * MINUTE, ...change }
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
): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1'), sampleWorkspace('w2')],
      tasks: [...tasks],
      uiState: [{ key: UiStateKey.ActiveWorkspaceId, value: 'w1' }, ...uiState],
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

  it('marks an unread row with a blue dot', async () => {
    await renderList()

    expect(within(row('Fix flaky login test')).getByRole('img', { name: 'Unread' })).toBeInTheDocument()
    expect(within(row('Add rate limiting')).queryByRole('img', { name: 'Unread' })).toBeNull()
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

  it('starts from the top with ⌥↓ when nothing is selected', async () => {
    const { store } = await renderList()

    pressAlt('ArrowDown')

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('p1')
    })
  })

  it('leaves other keys, other modifiers and text fields alone', async () => {
    const { store, fake } = await renderList()
    fake.invoke.mockClear()

    fireEvent.keyDown(window, { key: 'ArrowDown' })
    fireEvent.keyDown(window, { key: 'ArrowLeft', altKey: true })
    fireEvent.keyDown(window, { key: 'ArrowDown', altKey: true, metaKey: true })
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

  it('creates a task in the workspace with +, and selects it', async () => {
    const { store, fake } = await renderList()

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe('task-7')
    })
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TasksCreate, { workspaceId: 'w1' })
    expect(row('New task')).toHaveAttribute('aria-current', 'true')
  })

  it('shows a toast when a task can’t be created', async () => {
    await renderList(TASKS, [], {
      [CommandName.TasksCreate]: () => refuse(bridgeError(BridgeErrorCode.NotFound, 'No workspace w1')),
    })

    fireEvent.click(screen.getByRole('button', { name: 'New task' }))

    expect(await screen.findByText('No workspace w1')).toBeInTheDocument()
  })
})
