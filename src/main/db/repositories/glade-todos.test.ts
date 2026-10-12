import { afterEach, describe, expect, it } from 'vitest'
import { TodoState } from '../../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import {
  allocateTodoId,
  createTodo,
  deleteTodo,
  getTodo,
  getTodoCounter,
  latestTodoChangeAt,
  listTodos,
  putTodos,
  seedTodoCounterAtLeast,
  updateTodo,
} from './glade-todos'

let test: TestDatabase

afterEach(() => {
  test.close()
})

function task() {
  test = openTestDatabase()
  return sampleTask(test.db, sampleWorkspace(test.db).id)
}

describe('putTodos and listTodos', () => {
  it('writes todos by their own id, lowest first, and leaves another task alone', () => {
    const a = task()
    const { db } = test
    const other = sampleTask(db, sampleWorkspace(db, '/code/other').id)
    putTodos(db, a.id, [
      { id: '2', text: 'Write the release notes', note: null, state: TodoState.Todo, completedAt: null },
      { id: '1', text: 'Review the date helpers', note: 'Reading the diff', state: TodoState.Doing, completedAt: null },
    ])
    putTodos(db, other.id, [
      { id: '1', text: "Another task's todo", note: null, state: TodoState.Todo, completedAt: null },
    ])

    expect(listTodos(db, a.id)).toEqual([
      { id: '1', text: 'Review the date helpers', note: 'Reading the diff', state: TodoState.Doing, completedAt: null },
      { id: '2', text: 'Write the release notes', note: null, state: TodoState.Todo, completedAt: null },
    ])
    expect(listTodos(db, other.id)).toEqual([
      { id: '1', text: "Another task's todo", note: null, state: TodoState.Todo, completedAt: null },
    ])
  })

  it('replaces a row of the same id whole, keeping a finish time it was given', () => {
    const a = task()
    const { db } = test
    putTodos(db, a.id, [{ id: '1', text: 'Review', note: null, state: TodoState.Done, completedAt: 5_000 }])
    putTodos(db, a.id, [
      { id: '1', text: 'Review the date helpers', note: null, state: TodoState.Done, completedAt: 5_000 },
    ])
    expect(getTodo(db, a.id, '1')).toEqual({
      id: '1',
      text: 'Review the date helpers',
      note: null,
      state: TodoState.Done,
      completedAt: 5_000,
    })
  })
})

describe('getTodo', () => {
  it('answers undefined for a todo the task has none of', () => {
    const a = task()
    const { db } = test
    expect(getTodo(db, a.id, '9')).toBeUndefined()
  })
})

describe('updateTodo', () => {
  it('answers undefined, and writes nothing, for a todo the task has none of', () => {
    const a = task()
    const { db } = test
    expect(updateTodo(db, a.id, '9', { text: 'New text' })).toBeUndefined()
    expect(listTodos(db, a.id)).toEqual([])
  })

  it('changes only what the patch gives, keeping the rest', () => {
    const a = task()
    const { db } = test
    putTodos(db, a.id, [{ id: '1', text: 'Review', note: 'Reading', state: TodoState.Doing, completedAt: null }])
    expect(updateTodo(db, a.id, '1', { text: 'Review the date helpers' })).toEqual({
      id: '1',
      text: 'Review the date helpers',
      note: 'Reading',
      state: TodoState.Doing,
      completedAt: null,
    })
  })

  it('sets the finish time once, when a todo first becomes done, and keeps it through later updates', () => {
    const a = task()
    const { db } = test
    putTodos(db, a.id, [{ id: '1', text: 'Review', note: null, state: TodoState.Doing, completedAt: null }])
    expect(updateTodo(db, a.id, '1', { state: TodoState.Done }, 9_000)?.completedAt).toBe(9_000)
    expect(updateTodo(db, a.id, '1', { note: 'still here' }, 9_500)?.completedAt).toBe(9_000)
  })

  it('clears the finish time once a done todo goes back', () => {
    const a = task()
    const { db } = test
    putTodos(db, a.id, [{ id: '1', text: 'Review', note: null, state: TodoState.Done, completedAt: 9_000 }])
    expect(updateTodo(db, a.id, '1', { state: TodoState.Doing }, 9_500)?.completedAt).toBeNull()
  })
})

describe('deleteTodo', () => {
  it('removes a todo and answers whether it had one', () => {
    const a = task()
    const { db } = test
    putTodos(db, a.id, [{ id: '1', text: 'Review', note: null, state: TodoState.Todo, completedAt: null }])
    expect(deleteTodo(db, a.id, '1')).toBe(true)
    expect(listTodos(db, a.id)).toEqual([])
    expect(deleteTodo(db, a.id, '1')).toBe(false)
  })
})

describe('getTodoCounter, seedTodoCounterAtLeast and allocateTodoId', () => {
  it('has no counter until one is seeded or allocated from', () => {
    const a = task()
    const { db } = test
    expect(getTodoCounter(db, a.id)).toBeNull()
  })

  it('never lowers a counter that already stands higher', () => {
    const a = task()
    const { db } = test
    seedTodoCounterAtLeast(db, a.id, 10)
    seedTodoCounterAtLeast(db, a.id, 3)
    expect(getTodoCounter(db, a.id)).toBe(10)
    seedTodoCounterAtLeast(db, a.id, 11)
    expect(getTodoCounter(db, a.id)).toBe(11)
  })

  it('gives ids from 1, going up, never reusing one even once seeded past it', () => {
    const a = task()
    const { db } = test
    expect(allocateTodoId(db, a.id)).toBe('1')
    expect(allocateTodoId(db, a.id)).toBe('2')
    seedTodoCounterAtLeast(db, a.id, 50)
    expect(allocateTodoId(db, a.id)).toBe('50')
  })

  it("keeps one task's counter apart from another's", () => {
    const a = task()
    const { db } = test
    const b = sampleTask(db, sampleWorkspace(db, '/code/other').id)
    expect(allocateTodoId(db, a.id)).toBe('1')
    expect(allocateTodoId(db, b.id)).toBe('1')
  })
})

describe('createTodo', () => {
  it('adds a not-started todo with the next id, and no finish time', () => {
    const a = task()
    const { db } = test
    expect(createTodo(db, a.id, { text: 'Review the date helpers', note: 'Reading the diff' })).toEqual({
      id: '1',
      text: 'Review the date helpers',
      note: 'Reading the diff',
      state: TodoState.Todo,
      completedAt: null,
    })
    expect(createTodo(db, a.id, { text: 'Write the release notes', note: null })).toEqual({
      id: '2',
      text: 'Write the release notes',
      note: null,
      state: TodoState.Todo,
      completedAt: null,
    })
    expect(listTodos(db, a.id)).toHaveLength(2)
  })
})

describe('latestTodoChangeAt', () => {
  it('answers null for a task with no todos', () => {
    const a = task()
    const { db } = test
    expect(latestTodoChangeAt(db, a.id)).toBeNull()
  })

  it('is the latest of a create, an update or a delete, across every todo of the task', () => {
    const a = task()
    const { db } = test
    createTodo(db, a.id, { text: 'Review', note: null }, 1_000)
    createTodo(db, a.id, { text: 'Write the notes', note: null }, 2_000)
    expect(latestTodoChangeAt(db, a.id)).toBe(2_000)
    updateTodo(db, a.id, '1', { state: TodoState.Doing }, 3_000)
    expect(latestTodoChangeAt(db, a.id)).toBe(3_000)
    deleteTodo(db, a.id, '2')
    // Deleting the most recently touched todo still leaves the other's own time.
    expect(latestTodoChangeAt(db, a.id)).toBe(3_000)
  })
})
