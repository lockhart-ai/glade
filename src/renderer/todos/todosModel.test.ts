import { describe, expect, it } from 'vitest'
import { TodoState, type TodoList } from '../../shared/domain'
import { progressBar, progressHeading, todoProgress } from './todosModel'

const list = (...states: TodoState[]): TodoList => ({
  items: states.map((state, index) => ({ text: `Step ${String(index)}`, state, note: null })),
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
