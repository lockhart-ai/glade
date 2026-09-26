import { describe, expect, it } from 'vitest'
import { TodoState, type Todo, type TodoList } from '../../shared/domain'
import { orderTodos, progressBar, progressHeading, TodoGroup, todoGroup, todoProgress } from './todosModel'

const list = (...states: TodoState[]): TodoList => ({
  items: states.map((state, index) => ({ text: `Step ${String(index)}`, state, note: null, completedAt: null })),
  updatedAt: 0,
})

describe('todoProgress', () => {
  it('counts the done, doing and all items; waiting and todo items count only towards the total', () => {
    const { Done, Doing, Todo, Waiting } = TodoState
    expect(todoProgress(list(Done, Done, Done, Doing, Todo, Todo, Waiting))).toEqual({ done: 3, doing: 1, total: 7 })
  })

  it('is none of none without a list', () => {
    expect(todoProgress(null)).toEqual({ done: 0, doing: 0, total: 0 })
    expect(todoProgress(undefined)).toEqual({ done: 0, doing: 0, total: 0 })
  })
})

describe('progressHeading', () => {
  it('says how many of the items are done', () => {
    expect(progressHeading({ done: 3, doing: 1, total: 7 })).toBe('3 of 7 done')
  })
})

describe('progressBar', () => {
  it("fills the done items' share, then half an item's share for each item being worked on", () => {
    expect(progressBar({ done: 1, doing: 1, total: 4 })).toEqual({ done: 25, doing: 12.5 })
    expect(progressBar({ done: 4, doing: 0, total: 4 })).toEqual({ done: 100, doing: 0 })
  })

  it('is empty for an empty list', () => {
    expect(progressBar({ done: 0, doing: 0, total: 0 })).toEqual({ done: 0, doing: 0 })
  })
})

describe('todoGroup', () => {
  it('puts doing and waiting items in the active group, done ones in completed, and todo ones in not started', () => {
    expect(todoGroup(TodoState.Doing)).toBe(TodoGroup.Active)
    expect(todoGroup(TodoState.Waiting)).toBe(TodoGroup.Active)
    expect(todoGroup(TodoState.Done)).toBe(TodoGroup.Completed)
    expect(todoGroup(TodoState.Todo)).toBe(TodoGroup.NotStarted)
  })
})

describe('orderTodos', () => {
  const todo = (text: string, state: TodoState, completedAt: number | null = null): Todo => ({
    text,
    state,
    note: null,
    completedAt,
  })
  const texts = (items: readonly Todo[]) => orderTodos(items).map(({ todo: { text } }) => text)

  it('shows the active items, then the completed ones newest first, then the ones not started', () => {
    const items = [
      todo('a', TodoState.Todo),
      todo('b', TodoState.Done, 10),
      todo('c', TodoState.Doing),
      todo('d', TodoState.Done, 30),
      todo('e', TodoState.Todo),
      todo('f', TodoState.Waiting),
      todo('g', TodoState.Done, 20),
    ]
    expect(texts(items)).toEqual(['c', 'f', 'd', 'g', 'b', 'a', 'e'])
    // Each keeps its place in the agent's list.
    expect(orderTodos(items).map(({ position }) => position)).toEqual([2, 5, 3, 6, 1, 0, 4])
  })

  it('shows items finished at the same moment with the one further down the list first', () => {
    expect(texts([todo('a', TodoState.Done, 5), todo('b', TodoState.Done, 5), todo('c', TodoState.Done, 9)])).toEqual([
      'c',
      'b',
      'a',
    ])
  })

  it('counts a done item with no time as the oldest', () => {
    expect(texts([todo('a', TodoState.Done), todo('b', TodoState.Done, 1), todo('c', TodoState.Done)])).toEqual([
      'b',
      'c',
      'a',
    ])
  })

  it('keeps a list of one group, or none, as it is', () => {
    expect(texts([])).toEqual([])
    expect(texts([todo('a', TodoState.Todo), todo('b', TodoState.Todo)])).toEqual(['a', 'b'])
    expect(texts([todo('a', TodoState.Doing), todo('b', TodoState.Waiting)])).toEqual(['a', 'b'])
  })

  it('leaves the list it was given alone', () => {
    const items = [todo('a', TodoState.Todo), todo('b', TodoState.Doing)]
    orderTodos(items)
    expect(items.map(({ text }) => text)).toEqual(['a', 'b'])
  })

  it('orders a long list of every state, keeping each item once', () => {
    const states = [TodoState.Todo, TodoState.Doing, TodoState.Done, TodoState.Waiting]
    // A made-up but repeatable mix: states and finish times spread over the list, with ties.
    const items = Array.from({ length: 1_000 }, (_, index) =>
      todo(`Step ${String(index)}`, states[(index * 7) % 4] ?? TodoState.Todo, ((index * 37) % 101) * 1_000),
    ).map((item) => (item.state === TodoState.Done ? item : { ...item, completedAt: null }))

    const ordered = orderTodos(items)
    expect(new Set(ordered.map(({ position }) => position)).size).toBe(items.length)
    const ranks = ordered.map(({ todo: { state } }) =>
      [TodoGroup.Active, TodoGroup.Completed, TodoGroup.NotStarted].indexOf(todoGroup(state)),
    )
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b))
    for (let index = 1; index < ordered.length; index += 1) {
      const before = ordered[index - 1]
      const after = ordered[index]
      if (before === undefined || after === undefined) continue
      if (todoGroup(before.todo.state) !== todoGroup(after.todo.state)) continue
      if (after.todo.state !== TodoState.Done) {
        expect(after.position).toBeGreaterThan(before.position)
        continue
      }
      const newer = before.todo.completedAt ?? 0
      const older = after.todo.completedAt ?? 0
      expect(newer).toBeGreaterThanOrEqual(older)
      if (newer === older) expect(after.position).toBeLessThan(before.position)
    }
  })
})
