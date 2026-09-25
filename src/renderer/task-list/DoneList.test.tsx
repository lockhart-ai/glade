// The task list's Done section with more done tasks than the window ever loads or renders at once: it pages them in from
// main as you scroll, and renders only the rows in view, while looking and behaving as a list of them all would.
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommandName, EventType } from '../../shared/bridge'
import { TaskFilter } from '../../shared/attention'
import { DONE_PAGE_SIZE } from '../../shared/doneList'
import { TaskState, UiStateKey, type Task, type UiStateEntry } from '../../shared/domain'
import { ToastProvider } from '../components'
import { GladeStoreProvider } from '../store/react'
import { createGladeStore, type GladeStore } from '../store/store'
import { fakeBridge, sampleTask, sampleWorkspace, type FakeBridge, type FakeHandlers } from '../store/test-bridge'
import { STUB_ROW_HEIGHT, STUB_VIEWPORT_HEIGHT } from '../test-layout'
import { InputBar } from '../input-bar'
import { TaskList, TaskListToolbar } from '.'

const NOW = Date.UTC(2026, 8, 23, 11, 30)
const MINUTE = 60_000
const DONE_TASKS = 1_200
/** Rows fit in the stand-in viewport (test-setup.ts), plus a generous margin for the ones rendered past its edges. */
const MOST_ROWS_RENDERED = STUB_VIEWPORT_HEIGHT / STUB_ROW_HEIGHT + 30

/** A done task in w1, `index` places down the Done section: `Done 0` is the most recent. */
function done(index: number, change: Partial<Task> = {}): Task {
  return {
    ...sampleTask(doneId(index), 'w1', `Done ${String(index)}`),
    sessionId: `session-${String(index)}`,
    state: TaskState.Done,
    status: `Outcome ${String(index)}`,
    updatedAt: NOW - (index + 60) * MINUTE,
    ...change,
  }
}

function doneId(index: number): string {
  return `d${String(index).padStart(4, '0')}`
}

function manyDone(count = DONE_TASKS): Task[] {
  return Array.from({ length: count }, (_, index) => done(index, { unread: index % 8 === 0 }))
}

const ACTIVE = { ...sampleTask('a1', 'w1', 'Add rate limiting'), sessionId: 's', updatedAt: NOW - MINUTE }

interface Rendered {
  store: GladeStore
  fake: FakeBridge
}

const EXPANDED: UiStateEntry = { key: UiStateKey.DoneSectionCollapsed, value: 'false' }

async function renderList(
  tasks: Task[],
  uiState: UiStateEntry[] = [EXPANDED],
  overrides: Partial<FakeHandlers> = {},
  withInputBar = false,
): Promise<Rendered> {
  const fake = fakeBridge(
    {
      workspaces: [sampleWorkspace('w1')],
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
        {withInputBar && <InputBar />}
      </ToastProvider>
    </GladeStoreProvider>,
  )
  return { store, fake }
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name })
}

function header(name: string): HTMLElement {
  return within(section(name)).getAllByRole('button')[0] ?? section(name)
}

/** The Done section's rendered rows' titles, top to bottom. */
function doneTitles(): string[] {
  return within(section('Done'))
    .queryAllByRole('button')
    .slice(1)
    .map((row) => row.firstElementChild?.children[1]?.textContent ?? '')
}

/** The task list's scroller. */
function scroller(): HTMLElement {
  const list = section('Done').parentElement
  if (list === null) throw new Error('no task list')
  return list
}

/** Scrolls the task list to `top`, as a wheel or the scroll bar would. */
function scrollTo(top: number): void {
  act(() => {
    scroller().scrollTop = top
    fireEvent.scroll(scroller())
  })
}

/** Scrolls to the bottom of what's loaded, over and over, until the whole Done section has loaded and shows its end. */
async function scrollToBottom(store: GladeStore): Promise<number> {
  let scrolls = 0
  for (;;) {
    const height = Number.parseFloat(within(section('Done')).getByRole('list').style.height)
    scrollTo(height)
    scrolls += 1
    await act(async () => {
      await Promise.resolve()
    })
    const pages = store.getState().doneLists['w1:all']
    if (pages?.hasMore === false && doneTitles().includes(`Done ${String(DONE_TASKS - 1)}`)) return scrolls
    if (scrolls > 50) throw new Error('never reached the bottom')
  }
}

function pageLoads(fake: FakeBridge): number {
  return fake.invoke.mock.calls.filter(([command]) => command === CommandName.TasksListDone).length
}

function pressAlt(key: 'ArrowUp' | 'ArrowDown'): void {
  fireEvent.keyDown(window, { key, altKey: true })
}

let scrolledTo: ReturnType<typeof vi.fn<(options: ScrollToOptions) => void>>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  // jsdom doesn't scroll: scrolling to a place sets it and says so, as a browser would.
  scrolledTo = vi.fn<(options: ScrollToOptions) => void>()
  HTMLElement.prototype.scrollTo = function scrollTo(this: HTMLElement, options?: ScrollToOptions | number) {
    if (typeof options !== 'object') return
    scrolledTo(options)
    this.scrollTop = options.top ?? this.scrollTop
    fireEvent.scroll(this)
  }
  // Nor does it know how far a list can scroll: as far as anyone likes.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 10_000_000 })
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollTo')
  Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight')
})

describe('the Done section with more than a thousand tasks', () => {
  it('counts them all, and renders only the rows in view', async () => {
    const { store } = await renderList([ACTIVE, ...manyDone()])

    expect(header('Done')).toHaveTextContent(`Done${String(DONE_TASKS)}`)
    expect(Object.values(store.getState().tasks)).toHaveLength(1 + DONE_PAGE_SIZE)
    const titles = doneTitles()
    expect(titles.length).toBeGreaterThanOrEqual(STUB_VIEWPORT_HEIGHT / STUB_ROW_HEIGHT)
    expect(titles.length).toBeLessThan(MOST_ROWS_RENDERED)
    expect(titles.slice(0, 3)).toEqual(['Done 0', 'Done 1', 'Done 2'])
    // The list is as tall as the rows loaded so far, so the scroll bar is right for them.
    const list = within(section('Done')).getByRole('list')
    expect(list.style.height).toBe(`${String(DONE_PAGE_SIZE * STUB_ROW_HEIGHT + (DONE_PAGE_SIZE - 1) * 2)}px`)
  })

  it('counts them all with Done collapsed, loading one page and rendering no rows', async () => {
    const { fake } = await renderList(manyDone(), [])

    expect(header('Done')).toHaveTextContent(`Done${String(DONE_TASKS)}`)
    expect(doneTitles()).toEqual([])
    expect(pageLoads(fake)).toBe(1)
  })

  it('loads the next page as you scroll near the end of the last, and scrolls down to the very last task', async () => {
    const { store, fake } = await renderList(manyDone())

    scrollTo(20 * STUB_ROW_HEIGHT)
    expect(pageLoads(fake)).toBe(1)
    expect(doneTitles()).toContain('Done 25')

    const scrolls = await scrollToBottom(store)

    expect(scrolls).toBeGreaterThan(1)
    expect(pageLoads(fake)).toBe(Math.ceil(DONE_TASKS / DONE_PAGE_SIZE))
    expect(doneTitles().at(-1)).toBe(`Done ${String(DONE_TASKS - 1)}`)
    expect(doneTitles().length).toBeLessThan(MOST_ROWS_RENDERED)
    expect(new Set(doneTitles()).size).toBe(doneTitles().length)
  })

  it('keeps a selected row selected, and rendered as selected, as more pages load', async () => {
    const { store } = await renderList(manyDone(), [EXPANDED, { key: UiStateKey.SelectedTaskId, value: doneId(2) }])
    const selectedRow = (): HTMLElement | null => section('Done').querySelector('[aria-current="true"]')
    expect(selectedRow()).toHaveTextContent('Done 2')

    await scrollToBottom(store)
    expect(store.getState().selectedTaskId).toBe(doneId(2))
    expect(selectedRow()).toBeNull()

    scrollTo(0)
    expect(selectedRow()).toHaveTextContent('Done 2')
  })

  it('shows a task marked done while scrolled down at the top of Done, without moving what you’re looking at', async () => {
    const { store, fake } = await renderList([ACTIVE, ...manyDone()])
    await scrollToBottom(store)
    scrollTo(500 * (STUB_ROW_HEIGHT + 2))
    const before = doneTitles()
    expect(before).toContain('Done 505')

    act(() => {
      fake.emit({ type: EventType.TaskUpdated, task: { ...ACTIVE, state: TaskState.Done, updatedAt: NOW } })
    })

    expect(header('Done')).toHaveTextContent(`Done${String(DONE_TASKS + 1)}`)
    expect(header('Active')).toHaveTextContent('Active0')
    expect(doneTitles()).toContain('Done 505')
    scrollTo(0)
    expect(doneTitles()[0]).toBe('Add rate limiting')
  })

  it('takes a reopened task out of Done while scrolled down, and counts it out', async () => {
    const tasks = manyDone()
    const { store, fake } = await renderList(tasks)
    await act(() => store.getState().loadDoneThrough('w1', TaskFilter.All, null))
    scrollTo(300 * (STUB_ROW_HEIGHT + 2))
    await act(async () => {
      await Promise.resolve()
    })
    expect(doneTitles()).toContain('Done 305')

    act(() => {
      fake.emit({
        type: EventType.TaskUpdated,
        task: { ...done(305, { unread: tasks[305]?.unread }), state: TaskState.Active, updatedAt: NOW },
      })
    })

    expect(header('Done')).toHaveTextContent(`Done${String(DONE_TASKS - 1)}`)
    expect(doneTitles()).not.toContain('Done 305')
    expect(within(section('Active')).getByRole('button', { name: /^Done 305/ })).toBeInTheDocument()
  })

  it('steps with ⌥↓ from the last loaded task onto the next page once it loads, and back with ⌥↑', async () => {
    const tasks = manyDone()
    const lastLoaded = doneId(DONE_PAGE_SIZE - 1)
    // The second page waits until the test lets it through.
    let release = (): void => undefined
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    const { store } = await renderList(tasks, [EXPANDED, { key: UiStateKey.SelectedTaskId, value: lastLoaded }], {
      [CommandName.TasksListDone]: async (request) => {
        if (request.after !== null) await released
        return fakeBridge({ workspaces: [], tasks, uiState: [] }).bridge.invoke(CommandName.TasksListDone, request)
      },
    })
    const selected = (): string | null => store.getState().selectedTaskId

    await act(async () => {
      pressAlt('ArrowDown')
      await Promise.resolve()
    })
    // Nothing follows the last loaded task until its page arrives: the selection waits for it rather than staying put.
    expect(selected()).toBe(lastLoaded)
    release()
    await vi.waitFor(() => {
      expect(selected()).toBe(doneId(DONE_PAGE_SIZE))
    })
    expect(section('Done').querySelector('[aria-current="true"]')).toHaveTextContent(`Done ${String(DONE_PAGE_SIZE)}`)

    pressAlt('ArrowUp')
    await vi.waitFor(() => {
      expect(selected()).toBe(lastLoaded)
    })
    // The selection is scrolled to, and its row shows selected.
    expect(scrolledTo).toHaveBeenCalled()
    expect(section('Done').querySelector('[aria-current="true"]')).toHaveTextContent(
      `Done ${String(DONE_PAGE_SIZE - 1)}`,
    )
  })

  it('steps onto the next page with ⌥↓ from the input bar too, the focus going on to the next task’s', async () => {
    const lastLoaded = doneId(DONE_PAGE_SIZE - 1)
    const { store, fake } = await renderList(
      manyDone(),
      [EXPANDED, { key: UiStateKey.SelectedTaskId, value: lastLoaded }],
      {},
      true,
    )
    const field = (): HTMLElement => screen.getByRole('textbox', { name: 'Message the agent' })
    act(() => {
      field().focus()
    })

    expect(fireEvent.keyDown(field(), { key: 'ArrowDown', altKey: true })).toBe(false)

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe(doneId(DONE_PAGE_SIZE))
      expect(field()).toHaveFocus()
    })
    expect(pageLoads(fake)).toBe(2)
    expect(section('Done').querySelector('[aria-current="true"]')).toHaveTextContent(`Done ${String(DONE_PAGE_SIZE)}`)
  })

  it('goes to the very last done task with ⌥↑ when nothing is selected, loading every page', async () => {
    const { store, fake } = await renderList(manyDone())

    pressAlt('ArrowUp')

    await vi.waitFor(() => {
      expect(store.getState().selectedTaskId).toBe(doneId(DONE_TASKS - 1))
    })
    expect(pageLoads(fake)).toBe(Math.ceil(DONE_TASKS / DONE_PAGE_SIZE))
  })

  it('stays on the last task with ⌥↓ once every page has loaded', async () => {
    const last = doneId(DONE_TASKS - 1)
    const { store, fake } = await renderList(manyDone(), [EXPANDED, { key: UiStateKey.SelectedTaskId, value: last }])
    await vi.waitFor(() => {
      expect(store.getState().doneLists['w1:all']?.hasMore).toBe(false)
    })
    const loads = pageLoads(fake)

    await act(async () => {
      pressAlt('ArrowDown')
      await Promise.resolve()
    })

    expect(store.getState().selectedTaskId).toBe(last)
    expect(pageLoads(fake)).toBe(loads)
  })

  it('loads down to a selected task far down the section, and scrolls it into view', async () => {
    const deep = doneId(640)
    const { store } = await renderList(manyDone(), [EXPANDED, { key: UiStateKey.SelectedTaskId, value: deep }])

    await vi.waitFor(() => {
      expect(section('Done').querySelector('[aria-current="true"]')).toHaveTextContent('Done 640')
    })
    expect(store.getState().doneLists['w1:all']?.end?.id).toBe(doneId(699))
    expect(scrolledTo).toHaveBeenCalledWith(expect.objectContaining({ top: expect.any(Number) as unknown }))
  })

  it('counts and pages the unread done tasks under the Unread chip, from their own first page', async () => {
    const { fake } = await renderList([ACTIVE, ...manyDone()])
    const unreadChip = within(screen.getByRole('group', { name: 'Filter tasks' })).getByRole('button', {
      name: /^Unread/,
    })
    expect(unreadChip).toHaveTextContent(`Unread${String(DONE_TASKS / 8)}`)

    fireEvent.click(unreadChip)
    await vi.waitFor(() => {
      expect(doneTitles().slice(0, 2)).toEqual(['Done 0', 'Done 8'])
    })

    expect(header('Done')).toHaveTextContent(`Done${String(DONE_TASKS / 8)}`)
    expect(fake.invoke).toHaveBeenCalledWith(CommandName.TasksListDone, {
      workspaceId: 'w1',
      filter: TaskFilter.Unread,
      after: null,
      limit: DONE_PAGE_SIZE,
    })
  })

  it('shows a failed page as a toast', async () => {
    const tasks = manyDone()
    let fail = false
    const { store } = await renderList(tasks, [EXPANDED], {
      [CommandName.TasksListDone]: async (request) => {
        if (fail) throw new Error('disk full')
        return fakeBridge({ workspaces: [], tasks, uiState: [] }).bridge.invoke(CommandName.TasksListDone, request)
      },
    })
    fail = true

    scrollTo(90 * STUB_ROW_HEIGHT)

    expect(await screen.findByText('disk full')).toBeInTheDocument()
    expect(store.getState().doneLists['w1:all']?.hasMore).toBe(true)
  })

  it('opens the Done section on 2,000 done tasks quickly, rendering a screenful of rows', async () => {
    await renderList(manyDone(2_000), [])
    vi.useRealTimers()

    const started = performance.now()
    act(() => {
      fireEvent.click(header('Done'))
    })
    const took = performance.now() - started

    expect(doneTitles().length).toBeLessThan(MOST_ROWS_RENDERED)
    expect(doneTitles()[0]).toBe('Done 0')
    // Rendering all 2,000 rows takes seconds in jsdom; a screenful takes a few milliseconds. The budget is generous so
    // a busy machine never trips it, and still far below what rendering every row would take.
    expect(took).toBeLessThan(500)
  })
})
