// A task row's third line (#290): its todo progress, running subagents and live watchers, each only while there's some,
// in a fixed order under the title and status lines, which keep the row's full width for themselves.
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TaskState, type Task, type TodoSummary } from '../../shared/domain'
import { sampleTask } from '../store/test-bridge'
import { hasIndicators } from './RowIndicators'
import { TaskRow, type TaskRowProps } from './TaskRow'

const NOW = Date.UTC(2026, 8, 23, 11, 30)
const TODOS: TodoSummary = { done: 2, total: 11, doing: ['Write the migration'] }
const LONG_TITLE = 'Catch up on the release branch and every open pull request that touches the public API surface'
const LONG_STATUS =
  'Reviewed the chat clipping change, captured media for it, and moved on to the three follow-ups it left behind'

function task(change: Partial<Task> = {}): Task {
  return { ...sampleTask('t1', 'w1', 'Move image uploads to S3'), status: 'Copying files', updatedAt: NOW, ...change }
}

function renderRow(row: Task, extra: Partial<TaskRowProps> = {}): HTMLElement {
  render(<TaskRow task={row} now={NOW} selected={false} onSelect={vi.fn()} {...extra} />)
  return screen.getByRole('button')
}

/** The row's third line, if it has one. */
function indicatorsOf(row: HTMLElement): HTMLElement | null {
  return row.querySelector('[data-indicators]')
}

/** What each indicator on the row's third line is called, left to right. */
function namesOn(row: HTMLElement): string[] {
  const line = indicatorsOf(row)
  if (line === null) return []
  return Array.from(line.children).map((indicator) => indicator.getAttribute('aria-label') ?? '')
}

describe("a task row's indicators line", () => {
  it('isn’t there when the task has no todo list, no running subagents and no live watchers', () => {
    const row = renderRow(task(), { subagents: 0, watching: 0 })
    expect(indicatorsOf(row)).toBeNull()
    // The title line and the status line, and nothing else: the row keeps its two lines.
    expect(row.children).toHaveLength(2)
    expect(within(row).queryAllByRole('img')).toHaveLength(0)
  })

  it('isn’t there by default, with no counts given', () => {
    expect(indicatorsOf(renderRow(task()))).toBeNull()
  })

  it('shows todos alone', () => {
    const row = renderRow(task({ todos: TODOS }))
    expect(namesOn(row)).toEqual(['2 of 11 todos done · Now: Write the migration'])
    expect(indicatorsOf(row)).toHaveTextContent('2/11')
    expect(row.children).toHaveLength(3)
  })

  it('shows running subagents alone, with a count and a tooltip', () => {
    const row = renderRow(task(), { subagents: 3 })
    const count = within(row).getByRole('img', { name: '3 subagents running' })
    expect(count).toHaveAttribute('title', '3 subagents running')
    expect(count).toHaveTextContent(/^3$/)
    expect(namesOn(row)).toEqual(['3 subagents running'])
  })

  it('shows live watchers alone, with a count and a tooltip', () => {
    const row = renderRow(task(), { watching: 1 })
    const count = within(row).getByRole('img', { name: '1 watcher running' })
    expect(count).toHaveAttribute('title', '1 watcher running')
    expect(count).toHaveTextContent(/^1$/)
  })

  it('says one subagent in the singular', () => {
    const row = renderRow(task(), { subagents: 1 })
    expect(namesOn(row)).toEqual(['1 subagent running'])
  })

  it('orders them todos, subagents, watchers, whatever the mix', () => {
    const cases: [Partial<Task>, Partial<TaskRowProps>, string[]][] = [
      [{ todos: TODOS }, { subagents: 3, watching: 13 }, ['todos', 'subagents', 'watchers']],
      [{ todos: TODOS }, { subagents: 2 }, ['todos', 'subagents']],
      [{ todos: TODOS }, { watching: 2 }, ['todos', 'watchers']],
      [{}, { subagents: 2, watching: 2 }, ['subagents', 'watchers']],
    ]
    for (const [change, counts, kinds] of cases) {
      const { unmount } = render(
        <TaskRow task={task(change)} now={NOW} selected={false} onSelect={vi.fn()} {...counts} />,
      )
      const names = namesOn(screen.getByRole('button'))
      expect(names.map((name) => /todos|subagents|watchers/.exec(name)?.[0])).toEqual(kinds)
      unmount()
    }
  })

  it('leaves out each count that is zero', () => {
    const row = renderRow(task({ todos: TODOS }), { subagents: 0, watching: 0 })
    expect(namesOn(row)).toEqual(['2 of 11 todos done · Now: Write the migration'])
  })

  it('shows a finished list’s check on a done task, with its live watchers', () => {
    const row = renderRow(task({ state: TaskState.Done, todos: { done: 6, total: 6, doing: [] } }), { watching: 2 })
    expect(namesOn(row)).toEqual(['6 of 6 todos done', '2 watchers running'])
  })

  it('keeps the title line to the dot, the title and the time, and the status line to the status', () => {
    const row = renderRow(task({ todos: TODOS, unread: true }), { subagents: 3, watching: 13 })
    const [titleLine, statusLine, indicators] = Array.from(row.children)
    // Nothing but the time and the unread dot beside the title.
    expect(titleLine).toHaveTextContent(/^Move image uploads to S3now$/)
    expect(
      within(titleLine as HTMLElement)
        .getAllByRole('img')
        .map((img) => img.getAttribute('aria-label')),
    ).toEqual(['Unread'])
    expect(statusLine).toHaveTextContent(/^Copying files$/)
    expect(within(statusLine as HTMLElement).queryAllByRole('img')).toHaveLength(0)
    expect(indicators).toHaveAttribute('data-indicators')
    expect(indicators).toHaveTextContent(/^2\/11313$/)
  })

  it('keeps long titles and statuses whole on their own lines, however many indicators follow', () => {
    const row = renderRow(task({ title: LONG_TITLE, status: LONG_STATUS, todos: TODOS }), {
      subagents: 12,
      watching: 104,
    })
    const [titleLine, statusLine] = Array.from(row.children)
    expect(titleLine?.children[1]).toHaveTextContent(LONG_TITLE)
    expect(statusLine).toHaveTextContent(new RegExp(`^${LONG_STATUS}$`))
    expect(namesOn(row)).toEqual([
      '2 of 11 todos done · Now: Write the migration',
      '12 subagents running',
      '104 watchers running',
    ])
  })

  it('shows under a search result’s snippet, which takes the status line’s place', () => {
    const row = renderRow(task({ todos: TODOS }), {
      snippet: [{ text: 'image uploads', match: true }],
      watching: 1,
    })
    expect(row.children).toHaveLength(3)
    expect(row.children[1]).toHaveTextContent(/^image uploads$/)
    expect(namesOn(row)).toEqual(['2 of 11 todos done · Now: Write the migration', '1 watcher running'])
  })

  it('stays while the title is renamed', () => {
    render(
      <TaskRow
        task={task()}
        now={NOW}
        selected
        onSelect={vi.fn()}
        renaming
        onRename={() => Promise.resolve(true)}
        onCancelRename={vi.fn()}
        subagents={2}
      />,
    )
    expect(screen.getByRole('textbox', { name: 'Task title' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '2 subagents running' })).toBeInTheDocument()
  })
})

describe('hasIndicators', () => {
  it('is true only with a todo list or a count above zero', () => {
    expect(hasIndicators({ todos: null, subagents: 0, watching: 0 })).toBe(false)
    expect(hasIndicators({ todos: TODOS, subagents: 0, watching: 0 })).toBe(true)
    expect(hasIndicators({ todos: null, subagents: 1, watching: 0 })).toBe(true)
    expect(hasIndicators({ todos: null, subagents: 0, watching: 1 })).toBe(true)
  })
})
