import { describe, expect, it } from 'vitest'
import { TodoState, type Todo, type TodoList } from './domain'
import { allTodosDone, sameTodoSummary, summarizeTodos, todoProgress, todoSummaryLabel } from './todoSummary'

function list(...items: [string, TodoState][]): TodoList {
  return { items: items.map(([text, state]): Todo => ({ text, state, note: null })), updatedAt: 1 }
}

describe('todoProgress', () => {
  it('counts the done and doing items, and every item', () => {
    const todos = list(
      ['Find the uploads', TodoState.Done],
      ['Add the backend', TodoState.Doing],
      ['Copy the files', TodoState.Todo],
      ['Ask about the bucket', TodoState.Waiting],
    )
    expect(todoProgress(todos)).toEqual({ done: 1, doing: 1, total: 4 })
  })

  it('is none of none without a list', () => {
    expect(todoProgress(null)).toEqual({ done: 0, doing: 0, total: 0 })
    expect(todoProgress(undefined)).toEqual({ done: 0, doing: 0, total: 0 })
  })
})

describe('summarizeTodos', () => {
  it('is null without a list, or with an empty one: the row shows nothing', () => {
    expect(summarizeTodos(null)).toBeNull()
    expect(summarizeTodos(list())).toBeNull()
  })

  it('counts as the Todos tab does, and names the items being worked on, in order', () => {
    const todos = list(
      ['Find the uploads', TodoState.Done],
      ['Add the backend', TodoState.Doing],
      ['Copy the files', TodoState.Todo],
      ['Update the paths', TodoState.Doing],
      ['Ask about the bucket', TodoState.Waiting],
    )
    const summary = summarizeTodos(todos)
    expect(summary).toEqual({ done: 1, total: 5, doing: ['Add the backend', 'Update the paths'] })
    const tab = todoProgress(todos)
    expect({ done: summary?.done, total: summary?.total, doing: summary?.doing.length }).toEqual(tab)
  })

  it('keeps up with a list of hundreds of items', () => {
    const items: [string, TodoState][] = Array.from({ length: 500 }, (_, index) => [
      `Item ${String(index)}`,
      index < 321 ? TodoState.Done : index === 321 ? TodoState.Doing : TodoState.Todo,
    ])
    expect(summarizeTodos(list(...items))).toEqual({ done: 321, total: 500, doing: ['Item 321'] })
  })
})

describe('allTodosDone', () => {
  it('is true once every item is done', () => {
    expect(allTodosDone({ done: 7, total: 7, doing: [] })).toBe(true)
    expect(allTodosDone({ done: 6, total: 7, doing: [] })).toBe(false)
  })
})

describe('todoSummaryLabel', () => {
  it('says how many are done, and what the agent is working on now', () => {
    expect(todoSummaryLabel({ done: 3, total: 7, doing: [] })).toBe('3 of 7 todos done')
    expect(todoSummaryLabel({ done: 3, total: 7, doing: ['Copy the files'] })).toBe(
      '3 of 7 todos done · Now: Copy the files',
    )
    expect(todoSummaryLabel({ done: 0, total: 3, doing: ['Copy the files', 'Update the paths'] })).toBe(
      '0 of 3 todos done · Now: Copy the files; Update the paths',
    )
  })
})

describe('sameTodoSummary', () => {
  const summary = { done: 3, total: 7, doing: ['Copy the files'] }

  it('compares the counts and the items being worked on', () => {
    expect(sameTodoSummary(summary, { ...summary, doing: ['Copy the files'] })).toBe(true)
    expect(sameTodoSummary(summary, { ...summary, done: 4 })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, total: 8 })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, doing: [] })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, doing: ['Update the paths'] })).toBe(false)
  })

  it('tells no summary from one', () => {
    expect(sameTodoSummary(null, null)).toBe(true)
    expect(sameTodoSummary(summary, null)).toBe(false)
    expect(sameTodoSummary(null, summary)).toBe(false)
  })
})
