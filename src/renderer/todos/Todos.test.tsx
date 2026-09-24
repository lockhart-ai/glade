import { render as renderUnwrapped, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TodoState, type TodoList } from '../../shared/domain'
import { storeWrapper } from '../store/test-wrapper'
import { NO_TODOS, Todos, TODOS_EXPLAINER } from './Todos'

/** Renders under a store, which the items' context menus act through. */
function render(ui: React.ReactElement) {
  return renderUnwrapped(ui, { wrapper: storeWrapper().wrapper })
}

const NOW = new Date(2026, 8, 23, 14, 30).getTime()

/** The list in 09-todos.html. */
const LIST: TodoList = {
  items: [
    { text: 'Find how uploads are stored today', state: TodoState.Done, note: null },
    { text: 'Add an S3 backend for media files', state: TodoState.Done, note: null },
    { text: 'Check new uploads land in the bucket', state: TodoState.Done, note: null },
    { text: 'Copy the 3,900 existing files', state: TodoState.Doing, note: 'In progress · 1,240 of 3,900' },
    { text: 'Spot-check a sample of copied files', state: TodoState.Todo, note: null },
    { text: 'Update stored paths in the database', state: TodoState.Todo, note: null },
    { text: 'Delete local copies', state: TodoState.Waiting, note: 'Will ask you before deleting anything' },
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

  it('shows each item in its state, with its note under a doing or waiting one', () => {
    render(<Todos taskId="t1" list={LIST} now={NOW} />)

    expect(items().map((item) => item.textContent)).toEqual([
      'Done: Find how uploads are stored today',
      'Done: Add an S3 backend for media files',
      'Done: Check new uploads land in the bucket',
      'Doing: Copy the 3,900 existing filesIn progress · 1,240 of 3,900',
      'To do: Spot-check a sample of copied files',
      'To do: Update stored paths in the database',
      'Waiting on you: Delete local copiesWill ask you before deleting anything',
    ])
    const classes = items().map((item) => item.className)
    expect(classes[0]).toMatch(/done/)
    expect(classes[3]).toMatch(/doing/)
    expect(classes[4]).toMatch(/todo/)
    expect(classes[6]).toMatch(/waiting/)
    // Done items are ticked; the doing one has a dot in its ring instead of an icon.
    expect(items()[0]?.querySelector('path')).not.toBeNull()
    expect(items()[4]?.querySelector('path')).toBeNull()
    expect(items()[3]?.querySelector('svg')).toBeNull()
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
