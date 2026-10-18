// #680: the Todos tab's own small purple count of what's waiting on you, hidden at 0, capped at "9+". The
// render-count guard is the Performance one from CLAUDE.md: the badge reads its count through its own narrow store
// selector, so it (and only it) renders again when that number changes, and not otherwise.
import { act, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { EventType } from '../../shared/bridge'
import { TodoState, UiStateKey, type TodoList } from '../../shared/domain'
import { storeWrapper, type StoreWrapper } from '../store/test-wrapper'
import { TodoWaitingBadge } from './TodoWaitingBadge'
import { waitingLabel } from './todoWaitingBadgeModel'

// One `waitingLabel` call per render of the badge that shows it (it returns null, without calling it, at 0).
vi.mock('./todoWaitingBadgeModel', async (importOriginal) => {
  const original = await importOriginal<typeof import('./todoWaitingBadgeModel')>()
  return { ...original, waitingLabel: vi.fn(original.waitingLabel) }
})

function renders(): number {
  return vi.mocked(waitingLabel).mock.calls.length
}

/** A list with `waiting` todos waiting on you and the rest just not started. */
function list(waiting: number, total: number): TodoList {
  return {
    items: Array.from({ length: total }, (_, index) => ({
      id: String(index + 1),
      text: `Step ${String(index + 1)}`,
      state: index < waiting ? TodoState.Waiting : TodoState.Todo,
      note: index < waiting ? 'Pick one' : null,
      completedAt: null,
    })),
    updatedAt: Date.now(),
  }
}

/** `t1` selected, with `todos` as its full todo list (the right panel's own, loaded on selection). */
async function renderBadge(todos: Readonly<Record<string, TodoList>>, taskId = 't1'): Promise<StoreWrapper> {
  const wrapper = storeWrapper({
    uiState: [{ key: UiStateKey.SelectedTaskId, value: taskId }],
    todos,
  })
  render(<TodoWaitingBadge taskId={taskId} />, { wrapper: wrapper.wrapper })
  await act(() => wrapper.store.getState().hydrate())
  return wrapper
}

describe('TodoWaitingBadge', () => {
  it('is hidden with nothing waiting on you', async () => {
    await renderBadge({ t1: list(0, 4) })

    expect(screen.queryByRole('img')).toBeNull()
  })

  it('is hidden without a list at all', async () => {
    await renderBadge({})

    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows how many are waiting on you, named for a screen reader and on hover', async () => {
    await renderBadge({ t1: list(1, 4) })

    const badge = screen.getByRole('img', { name: '1 todo waiting on you' })
    expect(badge).toHaveTextContent('1')
    expect(badge).toHaveAttribute('title', '1 todo waiting on you')
  })

  it('shows 9+ past nine', async () => {
    await renderBadge({ t1: list(10, 10) })

    expect(screen.getByRole('img', { name: '10 todos waiting on you' })).toHaveTextContent('9+')
  })

  it('updates live as todos start and stop waiting on you', async () => {
    const { fake } = await renderBadge({ t1: list(0, 4) })
    expect(screen.queryByRole('img')).toBeNull()

    act(() => {
      fake.emit({ type: EventType.TodosChanged, taskId: 't1', todos: list(2, 4) })
    })
    expect(screen.getByRole('img')).toHaveTextContent('2')

    act(() => {
      fake.emit({ type: EventType.TodosChanged, taskId: 't1', todos: list(0, 4) })
    })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('renders again only when its own count changes, not on every change to the task’s todos', async () => {
    const { fake } = await renderBadge({ t1: list(1, 4) })
    vi.mocked(waitingLabel).mockClear()

    // The waiting item's own note changes; the waiting count doesn't: no extra render.
    const renoted = list(1, 4)
    act(() => {
      fake.emit({
        type: EventType.TodosChanged,
        taskId: 't1',
        todos: {
          ...renoted,
          items: renoted.items.map((item, index) => (index === 0 ? { ...item, note: 'Pick A or B' } : item)),
        },
      })
    })
    expect(renders()).toBe(0)
    expect(screen.getByRole('img')).toHaveTextContent('1')

    // A second item starts waiting: the count changes, one render.
    act(() => {
      fake.emit({ type: EventType.TodosChanged, taskId: 't1', todos: list(2, 4) })
    })
    expect(renders()).toBe(1)
    expect(screen.getByRole('img')).toHaveTextContent('2')
  })

  it('is its own badge per task: another task’s waiting todos don’t show on it', async () => {
    await renderBadge({ t1: list(0, 4), t2: list(3, 4) })

    expect(screen.queryByRole('img')).toBeNull()
  })
})
