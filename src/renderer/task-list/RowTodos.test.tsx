import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskState, type Task, type TodoSummary } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import { ringDash } from './RowTodos'
import { TaskRow } from './TaskRow'

const NOW = Date.UTC(2026, 8, 23, 11, 30)

function task(todos: TodoSummary | null, change: Partial<Task> = {}): Task {
  return { ...sampleTask('t1', 'w1', 'Move image uploads to S3'), status: 'Copying files', todos, ...change }
}

function renderRow(row: Task, extra: Partial<Parameters<typeof TaskRow>[0]> = {}): void {
  render(<TaskRow task={row} now={NOW} selected={false} onSelect={vi.fn()} {...extra} />)
}

function progress(): HTMLElement | null {
  return screen.queryByRole('img', { name: /todos done/ })
}

describe("a task row's todo progress", () => {
  it('shows nothing while the agent keeps no list', () => {
    renderRow(task(null))
    expect(progress()).toBeNull()
    expect(screen.getByText('Copying files')).toBeInTheDocument()
  })

  it('shows a ring filling with the done items and 3/7 at the end of the status line, naming the item in progress', () => {
    renderRow(task({ done: 3, total: 7, doing: ['Copy the 3,900 existing files'] }))
    const shown = progress()
    expect(shown).toHaveTextContent('3/7')
    expect(shown).toHaveAccessibleName('3 of 7 todos done · Now: Copy the 3,900 existing files')
    expect(shown).toHaveAttribute('title', '3 of 7 todos done · Now: Copy the 3,900 existing files')
    expect(shown).toHaveAttribute('data-done', 'false')
    expect(shown?.querySelectorAll('circle')[1]).toHaveAttribute('stroke-dasharray', '12.12 28.27')
    // The status still reads in full to a screen reader, before the progress.
    expect(shown?.previousElementSibling).toHaveTextContent('Copying files')
  })

  it('shows a check once every item is done', () => {
    renderRow(task({ done: 7, total: 7, doing: [] }, { state: TaskState.Done }))
    const shown = progress()
    expect(shown).toHaveTextContent('7/7')
    expect(shown).toHaveAttribute('data-done', 'true')
    expect(shown).toHaveAttribute('title', '7 of 7 todos done')
    expect(shown?.querySelector('path')).not.toBeNull()
  })

  it('keeps showing while the title is renamed, and not on a search result, whose snippet replaces the status', () => {
    const summary = { done: 1, total: 2, doing: [] }
    const { unmount } = render(
      <TaskRow
        task={task(summary)}
        now={NOW}
        selected
        onSelect={vi.fn()}
        renaming
        onRename={() => Promise.resolve(true)}
        onCancelRename={vi.fn()}
      />,
    )
    expect(progress()).toHaveTextContent('1/2')
    unmount()

    renderRow(task(summary), { snippet: [{ text: 'Copying', match: true }] })
    expect(progress()).toBeNull()
  })

  it('fits a list of hundreds of items', () => {
    renderRow(task({ done: 321, total: 500, doing: ['Migrate table 322'] }))
    expect(progress()).toHaveTextContent('321/500')
  })
})

describe('ringDash', () => {
  it('fills the ring by the share done, from none to all', () => {
    expect(ringDash({ done: 0, total: 7, doing: [] })).toBe('0.00 28.27')
    expect(ringDash({ done: 7, total: 7, doing: [] })).toBe('28.27 28.27')
  })
})
