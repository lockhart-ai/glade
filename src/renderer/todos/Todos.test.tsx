import { act, fireEvent, render as renderUnwrapped, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TodoState, type TodoList } from '../../shared/domain'
import { storeWrapper } from '../store/test-wrapper'
import { askAboutTodo, NO_TODOS, Todos, TODOS_EXPLAINER } from './Todos'

/** Renders under a store, which the items' context menus act through. */
function render(ui: React.ReactElement, wrapper = storeWrapper()) {
  return renderUnwrapped(ui, { wrapper: wrapper.wrapper })
}

const NOW = new Date(2026, 8, 23, 14, 30).getTime()
const MINUTE = 60_000

/** The list in 09-todos.html. */
const LIST: TodoList = {
  items: [
    { text: 'Find how uploads are stored today', state: TodoState.Done, note: null, completedAt: NOW - 19 * MINUTE },
    { text: 'Add an S3 backend for media files', state: TodoState.Done, note: null, completedAt: NOW - 17 * MINUTE },
    { text: 'Check new uploads land in the bucket', state: TodoState.Done, note: null, completedAt: NOW - 9 * MINUTE },
    {
      text: 'Copy the 3,900 existing files',
      state: TodoState.Doing,
      note: 'In progress · 1,240 of 3,900',
      completedAt: null,
    },
    { text: 'Spot-check a sample of copied files', state: TodoState.Todo, note: null, completedAt: null },
    { text: 'Update stored paths in the database', state: TodoState.Todo, note: null, completedAt: null },
    {
      text: 'Delete local copies',
      state: TodoState.Waiting,
      note: 'Will ask you before deleting anything',
      completedAt: null,
    },
  ],
  updatedAt: NOW - 20_000,
}

function items(): HTMLElement[] {
  return within(screen.getByRole('list', { name: 'Todos' })).getAllByRole('listitem')
}

describe('Todos', () => {
  it('shows how many are done, with a progress bar and when the list was last updated', () => {
    render(<Todos taskId="t1" list={LIST} now={NOW} />)

    expect(screen.getByText('3 of 7 done')).toBeInTheDocument()
    expect(screen.getByText('updated just now')).toBeInTheDocument()
    expect(screen.getByText(TODOS_EXPLAINER)).toBeInTheDocument()
    const bar = screen.getByRole('progressbar', { name: 'Todos done' })
    expect(bar).toHaveAttribute('aria-valuenow', '3')
    expect(bar).toHaveAttribute('aria-valuemax', '7')
    const [done, doing] = Array.from(bar.children) as HTMLElement[]
    expect(done?.style.width).toBe(`${String((3 / 7) * 100)}%`)
    expect(doing?.style.width).toBe(`${String((0.5 / 7) * 100)}%`)
  })

  it('says how long ago an older list was updated', () => {
    render(<Todos taskId="t1" list={{ ...LIST, updatedAt: NOW - 4 * 60_000 }} now={NOW} />)
    expect(screen.getByText('updated 4m ago')).toBeInTheDocument()
  })

  it('shows the active items, then the done ones (newest first, with when each finished), then those not started', () => {
    render(<Todos taskId="t1" list={LIST} now={NOW} />)

    expect(items().map((item) => item.textContent)).toEqual([
      'Doing: Copy the 3,900 existing filesIn progress · 1,240 of 3,900',
      'Waiting on you: Delete local copiesWill ask you before deleting anything',
      'Done: Check new uploads land in the bucketFinished 9m ago',
      'Done: Add an S3 backend for media filesFinished 17m ago',
      'Done: Find how uploads are stored todayFinished 19m ago',
      'To do: Spot-check a sample of copied files',
      'To do: Update stored paths in the database',
    ])
    const classes = items().map((item) => item.className)
    expect(classes[0]).toMatch(/doing/)
    expect(classes[1]).toMatch(/waiting/)
    expect(classes[2]).toMatch(/done/)
    expect(classes[5]).toMatch(/todo/)
    // Done items are ticked; the doing one has a dot in its ring instead of an icon.
    expect(items()[2]?.querySelector('path')).not.toBeNull()
    expect(items()[5]?.querySelector('path')).toBeNull()
    expect(items()[0]?.querySelector('svg')).toBeNull()
  })

  it("gives a done item's finish time exactly on hover, and none to the items not done", () => {
    render(<Todos taskId="t1" list={LIST} now={NOW} />)

    const times = items().map((item) => item.querySelector('time'))
    expect(times.map((time) => time?.title ?? null)).toEqual([
      null,
      null,
      'Sep 23, 2026, 2:21 PM',
      'Sep 23, 2026, 2:13 PM',
      'Sep 23, 2026, 2:11 PM',
      null,
      null,
    ])
    expect(times[2]?.dateTime).toBe(new Date(NOW - 9 * MINUTE).toISOString())
  })

  it('keeps the finish times current as the clock moves', () => {
    const list: TodoList = {
      items: [{ text: 'Fix the race', state: TodoState.Done, note: null, completedAt: NOW - 5_000 }],
      updatedAt: NOW - 5_000,
    }
    const { rerender } = render(<Todos taskId="t1" list={list} now={NOW} />)
    expect(items()[0]?.textContent).toBe('Done: Fix the raceFinished just now')
    rerender(<Todos taskId="t1" list={list} now={NOW + 4 * MINUTE} />)
    expect(items()[0]?.textContent).toBe('Done: Fix the raceFinished 4m ago')
    rerender(<Todos taskId="t1" list={list} now={NOW + 3 * 60 * MINUTE} />)
    expect(items()[0]?.textContent).toBe('Done: Fix the raceFinished 3h ago')
  })

  it('moves items between the groups as their states change, the one just finished to the top of the done ones', () => {
    const { rerender } = render(<Todos taskId="t1" list={LIST} now={NOW} />)
    const copying = items()[0]

    // The copy finishes and the spot-check starts.
    const next: TodoList = {
      items: LIST.items.map((todo, index) =>
        index === 3
          ? { ...todo, state: TodoState.Done, note: null, completedAt: NOW }
          : index === 4
            ? { ...todo, state: TodoState.Doing, note: 'Checking 50 files' }
            : todo,
      ),
      updatedAt: NOW,
    }
    rerender(<Todos taskId="t1" list={next} now={NOW} />)
    expect(items().map((item) => item.textContent)).toEqual([
      'Doing: Spot-check a sample of copied filesChecking 50 files',
      'Waiting on you: Delete local copiesWill ask you before deleting anything',
      'Done: Copy the 3,900 existing filesFinished just now',
      'Done: Check new uploads land in the bucketFinished 9m ago',
      'Done: Add an S3 backend for media filesFinished 17m ago',
      'Done: Find how uploads are stored todayFinished 19m ago',
      'To do: Update stored paths in the database',
    ])
    // The same element moved, so the focus and anything else on it goes with the item.
    expect(items()[2]).toBe(copying)

    // Reopened, a done item goes back to the active ones, without its time.
    const reopened: TodoList = {
      items: next.items.map((todo, index) =>
        index === 0 ? { ...todo, state: TodoState.Doing, note: 'Looking again', completedAt: null } : todo,
      ),
      updatedAt: NOW,
    }
    rerender(<Todos taskId="t1" list={reopened} now={NOW} />)
    expect(
      items()
        .map((item) => item.textContent)
        .slice(0, 3),
    ).toEqual([
      'Doing: Find how uploads are stored todayLooking again',
      'Doing: Spot-check a sample of copied filesChecking 50 files',
      'Waiting on you: Delete local copiesWill ask you before deleting anything',
    ])
    expect(items()[0]?.querySelector('time')).toBeNull()
  })

  it("shows a list with only one group in the agent's order, or newest first when all are done", () => {
    const only = (state: TodoState, completedAt: (index: number) => number | null): TodoList => ({
      items: ['Reproduce the flake', 'Fix the race', 'Run the test 200 times'].map((text, index) => ({
        text,
        state,
        note: null,
        completedAt: completedAt(index),
      })),
      updatedAt: NOW,
    })
    const texts = () => items().map((item) => item.querySelector('[class*="text"]')?.textContent)
    const { rerender } = render(<Todos taskId="t1" list={only(TodoState.Todo, () => null)} now={NOW} />)
    expect(texts()).toEqual(['Reproduce the flake', 'Fix the race', 'Run the test 200 times'])
    rerender(<Todos taskId="t1" list={only(TodoState.Doing, () => null)} now={NOW} />)
    expect(texts()).toEqual(['Reproduce the flake', 'Fix the race', 'Run the test 200 times'])
    rerender(<Todos taskId="t1" list={only(TodoState.Done, (index) => NOW - (3 - index) * MINUTE)} now={NOW} />)
    expect(texts()).toEqual(['Run the test 200 times', 'Fix the race', 'Reproduce the flake'])
    expect(screen.getByText('3 of 3 done')).toBeInTheDocument()
    // All finished by one call: the one furthest down the list first.
    rerender(<Todos taskId="t1" list={only(TodoState.Done, () => NOW)} now={NOW} />)
    expect(texts()).toEqual(['Run the test 200 times', 'Fix the race', 'Reproduce the flake'])
    expect(screen.getAllByText('just now')).toHaveLength(3)
  })

  it('shows a done item without a finish time with none', () => {
    const list: TodoList = {
      items: [{ text: 'Fix the race', state: TodoState.Done, note: null, completedAt: null }],
      updatedAt: NOW,
    }
    render(<Todos taskId="t1" list={list} now={NOW} />)
    expect(items()[0]?.textContent).toBe('Done: Fix the race')
  })

  it('says there are no todos until the agent keeps a list with something on it', () => {
    const { rerender } = render(<Todos taskId="t1" list={null} now={NOW} />)
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()
    rerender(<Todos taskId="t1" list={undefined} now={NOW} />)
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()
    rerender(<Todos taskId="t1" list={{ items: [], updatedAt: NOW }} now={NOW} />)
    expect(screen.getByText(NO_TODOS)).toBeInTheDocument()
    expect(screen.queryByRole('list')).toBeNull()
  })
})

describe('a todo’s context menu', () => {
  function item(text: string): HTMLElement {
    const found = screen.getAllByRole('listitem').find((element) => element.textContent.includes(text))
    if (found === undefined) throw new Error(`No todo ${text}`)
    return found
  }

  it('copies the todo, and asks the agent about it in the message field', async () => {
    const copied: string[] = []
    const wrapper = storeWrapper({ copied })
    render(<Todos taskId="t1" list={LIST} now={NOW} />, wrapper)

    fireEvent.contextMenu(item('Add an S3 backend'))
    await act(() => Promise.resolve())
    expect(screen.getAllByRole('menuitem').map((menuItem) => menuItem.textContent)).toEqual([
      'Copy',
      'Ask agent about this',
    ])
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }))
    await act(() => Promise.resolve())
    expect(copied).toEqual(['Add an S3 backend for media files'])

    item('Add an S3 backend').focus()
    fireEvent.keyDown(item('Add an S3 backend'), { key: 'F10', shiftKey: true })
    await act(() => Promise.resolve())
    fireEvent.click(screen.getByRole('menuitem', { name: 'Ask agent about this' }))
    expect(wrapper.store.getState().inputInsertion).toEqual({
      taskId: 't1',
      text: 'About the todo “Add an S3 backend for media files”: ',
      request: 1,
    })
  })
})

describe('askAboutTodo', () => {
  it('names the todo, for you to finish with your question', () => {
    expect(askAboutTodo({ text: 'Run the tests', state: TodoState.Todo, note: null, completedAt: null })).toBe(
      'About the todo “Run the tests”: ',
    )
  })
})
