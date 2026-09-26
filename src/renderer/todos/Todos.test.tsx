import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { act, fireEvent, render as renderUnwrapped, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { TodoState, type TodoList } from '../../shared/domain'
import { contrastRatio, relativeLuminance } from '../contrast'
import { storeWrapper } from '../store/test-wrapper'
import { colors, type ColorToken } from '../tokens'
import { askAboutTodo, NO_TODOS, Todos, TODOS_EXPLAINER } from './Todos'

const todosCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'Todos.module.css'), 'utf8')

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

  it('draws done as a filled check and not started as a hollow ring, so the two tell apart (#308)', () => {
    render(<Todos taskId="t1" list={LIST} now={NOW} />)
    const icon = (index: number) => items()[index]?.querySelector('svg')
    const circle = (index: number) => icon(index)?.querySelector('circle')

    // Every done item: a filled circle with the tick cut out of it.
    for (const index of [2, 3, 4]) {
      expect(items()[index]?.className).toMatch(/done/)
      expect(circle(index)).toHaveAttribute('fill', 'currentColor')
      expect(icon(index)?.querySelector('path')?.getAttribute('class')).toMatch(/check/)
    }
    // Every item not started: an outlined ring, unfilled and unticked.
    for (const index of [5, 6]) {
      expect(items()[index]?.className).toMatch(/todo/)
      expect(icon(index)).toHaveAttribute('stroke', 'currentColor')
      expect(circle(index)).not.toHaveAttribute('fill')
      expect(icon(index)?.querySelector('path')).toBeNull()
    }
    // Waiting on you keeps its ring, and doing its dotted ring, unchanged.
    expect(items()[1]?.className).toMatch(/waiting/)
    expect(circle(1)).not.toHaveAttribute('fill')
    expect(items()[0]?.querySelector('[class*="doingDot"]')).not.toBeNull()
  })

  it('switches an item from the hollow ring to the filled check as it gets done, and back when reopened', () => {
    const list = (state: TodoState): TodoList => ({
      items: [{ text: 'Fix the race', state, note: null, completedAt: state === TodoState.Done ? NOW : null }],
      updatedAt: NOW,
    })
    const { rerender } = render(<Todos taskId="t1" list={list(TodoState.Todo)} now={NOW} />)
    const circle = () => items()[0]?.querySelector('circle')
    expect(circle()).not.toHaveAttribute('fill')
    rerender(<Todos taskId="t1" list={list(TodoState.Done)} now={NOW} />)
    expect(items()[0]?.className).toMatch(/done/)
    expect(circle()).toHaveAttribute('fill', 'currentColor')
    rerender(<Todos taskId="t1" list={list(TodoState.Todo)} now={NOW} />)
    expect(items()[0]?.className).toMatch(/todo/)
    expect(circle()).not.toHaveAttribute('fill')
    expect(items()[0]?.querySelector('path')).toBeNull()
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

/** The declarations of one rule in Todos.module.css, by its exact selector. */
function rule(selector: string): Map<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = new RegExp(`(?:^|\\n)${escaped} \\{([^}]*)\\}`).exec(todosCss)?.[1]
  if (body === undefined) throw new Error(`No rule for ${selector}`)
  return new Map([...body.matchAll(/([\w-]+):\s*([^;]+);/g)].map(([, name = '', value = '']) => [name, value]))
}

function isColorToken(name: string | undefined): name is ColorToken {
  return name !== undefined && name in colors
}

/** The token a `var(--color-…)` value names. */
function token(value: string | undefined): ColorToken {
  const name = /^var\((--color-[\w-]+)\)$/.exec(value ?? '')?.[1]
  if (!isColorToken(name)) throw new Error(`Not a colour token: ${String(value)}`)
  return name
}

describe('Todos state colours (#308)', () => {
  // The Todos tab sits in the right panel, a nested card.
  const surface = colors['--color-inner']

  it('fills a done item in the teal accent, with the tick in the panel colour and its text dimmed', () => {
    expect(token(rule('.done .icon').get('color'))).toBe('--color-teal')
    expect(token(rule('.check').get('stroke'))).toBe('--color-panel')
    expect(token(rule('.done .text').get('color'))).toBe('--color-faint')
    expect(rule('.done .text').get('text-decoration')).toBe('line-through')
  })

  it('outlines an item not started, with its text at full strength', () => {
    expect(token(rule('.todo .icon').get('color'))).toBe('--color-muted')
    expect(token(rule('.todo .text').get('color'))).toBe('--color-text')
  })

  it('keeps each icon at 3:1 against the panel and each text at 4.5:1, as the tokens require', () => {
    // WCAG's floor for icons and other non-text marks is 3:1; text is held to 4.5:1 (tokens.md).
    const teal = colors[token(rule('.done .icon').get('color'))]
    expect(contrastRatio(teal, surface)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(colors[token(rule('.check').get('stroke'))], teal)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(colors[token(rule('.todo .icon').get('color'))], surface)).toBeGreaterThanOrEqual(3)
    expect(contrastRatio(colors[token(rule('.done .text').get('color'))], surface)).toBeGreaterThanOrEqual(4.5)
    expect(contrastRatio(colors[token(rule('.todo .text').get('color'))], surface)).toBeGreaterThanOrEqual(4.5)
  })

  it('sets the not-started text brighter than the done text, so done reads as finished', () => {
    const todoText = colors[token(rule('.todo .text').get('color'))]
    const doneText = colors[token(rule('.done .text').get('color'))]
    expect(relativeLuminance(todoText)).toBeGreaterThan(relativeLuminance(doneText))
  })

  it('names a rule it cannot find, or a colour that is not a token', () => {
    expect(() => rule('.nowhere')).toThrow('No rule for .nowhere')
    expect(() => token('#4e5468')).toThrow('Not a colour token: #4e5468')
    expect(() => token(undefined)).toThrow('Not a colour token: undefined')
  })
})
