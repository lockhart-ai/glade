import { describe, expect, it } from 'vitest'
import { TodoState, type Todo, type TodoList } from './domain'
import { allTodosDone, sameTodoSummary, summarizeTodos, todoProgress, todoSummaryLabel } from './todoSummary'

function list(...items: [string, TodoState][]): TodoList {
  return {
    items: items.map(([text, state], index): Todo => ({
      id: String(index + 1),
      text,
      state,
      note: null,
      completedAt: null,
    })),
    updatedAt: 1,
  }
}

describe('todoProgress', () => {
  it('counts the done, doing and waiting items, and every item', () => {
    const todos = list(
      ['Find the uploads', TodoState.Done],
      ['Add the backend', TodoState.Doing],
      ['Copy the files', TodoState.Todo],
      ['Ask about the bucket', TodoState.Waiting],
    )
    expect(todoProgress(todos)).toEqual({ done: 1, doing: 1, waiting: 1, total: 4 })
  })

  it('is none of none without a list', () => {
    expect(todoProgress(null)).toEqual({ done: 0, doing: 0, waiting: 0, total: 0 })
    expect(todoProgress(undefined)).toEqual({ done: 0, doing: 0, waiting: 0, total: 0 })
  })
})

describe('summarizeTodos', () => {
  it('is null without a list, or with an empty one: the row shows nothing', () => {
    expect(summarizeTodos(null)).toBeNull()
    expect(summarizeTodos(list())).toBeNull()
  })

  it('counts as the Todos tab does, and names the items being worked on and waiting on you, in order', () => {
    const todos = list(
      ['Find the uploads', TodoState.Done],
      ['Add the backend', TodoState.Doing],
      ['Copy the files', TodoState.Todo],
      ['Update the paths', TodoState.Doing],
      ['Ask about the bucket', TodoState.Waiting],
    )
    const summary = summarizeTodos(todos)
    expect(summary).toEqual({
      done: 1,
      total: 5,
      doing: ['Add the backend', 'Update the paths'],
      waiting: ['Ask about the bucket'],
    })
    const tab = todoProgress(todos)
    expect({
      done: summary?.done,
      total: summary?.total,
      doing: summary?.doing.length,
      waiting: summary?.waiting.length,
    }).toEqual(tab)
  })

  it('keeps up with a list of hundreds of items', () => {
    const items: [string, TodoState][] = Array.from({ length: 500 }, (_, index) => [
      `Item ${String(index)}`,
      index < 321 ? TodoState.Done : index === 321 ? TodoState.Doing : TodoState.Todo,
    ])
    expect(summarizeTodos(list(...items))).toEqual({ done: 321, total: 500, doing: ['Item 321'], waiting: [] })
  })
})

describe('allTodosDone', () => {
  it('is true once every item is done', () => {
    expect(allTodosDone({ done: 7, total: 7, doing: [], waiting: [] })).toBe(true)
    expect(allTodosDone({ done: 6, total: 7, doing: [], waiting: [] })).toBe(false)
  })
})

describe('todoSummaryLabel', () => {
  it('says how many are done, what is waiting on you, and what the agent is working on now', () => {
    expect(todoSummaryLabel({ done: 3, total: 7, doing: [], waiting: [] })).toBe('3 of 7 todos done')
    expect(todoSummaryLabel({ done: 3, total: 7, doing: ['Copy the files'], waiting: [] })).toBe(
      '3 of 7 todos done · Now: Copy the files',
    )
    expect(todoSummaryLabel({ done: 0, total: 3, doing: ['Copy the files', 'Update the paths'], waiting: [] })).toBe(
      '0 of 3 todos done · Now: Copy the files; Update the paths',
    )
    expect(todoSummaryLabel({ done: 0, total: 2, doing: [], waiting: ['Ask about the bucket'] })).toBe(
      '0 of 2 todos done · Waiting on you: Ask about the bucket',
    )
    expect(todoSummaryLabel({ done: 0, total: 3, doing: ['Copy the files'], waiting: ['Ask about the bucket'] })).toBe(
      '0 of 3 todos done · Waiting on you: Ask about the bucket · Now: Copy the files',
    )
  })
})

describe('sameTodoSummary', () => {
  const summary = { done: 3, total: 7, doing: ['Copy the files'], waiting: ['Ask about the bucket'] }

  it('compares the counts, what is waiting and what is being worked on', () => {
    expect(sameTodoSummary(summary, { ...summary, doing: ['Copy the files'] })).toBe(true)
    expect(sameTodoSummary(summary, { ...summary, done: 4 })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, total: 8 })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, doing: [] })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, doing: ['Update the paths'] })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, waiting: [] })).toBe(false)
    expect(sameTodoSummary(summary, { ...summary, waiting: ['Ask about something else'] })).toBe(false)
  })

  it('tells no summary from one', () => {
    expect(sameTodoSummary(null, null)).toBe(true)
    expect(sameTodoSummary(summary, null)).toBe(false)
    expect(sameTodoSummary(null, summary)).toBe(false)
  })
})
