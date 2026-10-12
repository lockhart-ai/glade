import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { TodoState, type TodoSummary } from '../../shared/domain'
import { summarizeTodos, todoProgress } from '../../shared/todoSummary'
import { openAppDatabase } from '../db/database'
import { createTodo, deleteTodo, putTodos, seedTodoCounterAtLeast, updateTodo } from '../db/repositories/glade-todos'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { sharedTaskListDir } from '../openrouter/task-list'
import { highestTodoId, liveTodos, refreshStaleTodos, refreshTodos, strandedIds, todoListFor } from './todos'

describe('todoListFor', () => {
  let test: TestDatabase | undefined

  afterEach(() => {
    test?.close()
  })

  it('is null until a todo is made, reflects creates and updates, and is null again once every one is deleted', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    expect(todoListFor(db, task.id)).toBeNull()

    createTodo(db, task.id, { text: 'Review the date helpers', note: null }, 5_000)
    expect(todoListFor(db, task.id)).toEqual({
      items: [{ id: '1', text: 'Review the date helpers', note: null, state: TodoState.Todo, completedAt: null }],
      updatedAt: 5_000,
    })

    updateTodo(db, task.id, '1', { state: TodoState.Doing, note: 'Reading the diff' }, 5_100)
    expect(todoListFor(db, task.id)).toEqual({
      items: [{ id: '1', text: 'Review the date helpers', note: 'Reading the diff', state: TodoState.Doing, completedAt: null }],
      updatedAt: 5_100,
    })

    expect(deleteTodo(db, task.id, '1')).toBe(true)
    // The same empty state either way: the Todos tab doesn't tell "never made one" from "made and deleted them all".
    expect(todoListFor(db, task.id)).toBeNull()
  })

  it("reads the latest change across every one of a task's todos, not only its most recently made", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    createTodo(db, task.id, { text: 'First', note: null }, 1_000)
    createTodo(db, task.id, { text: 'Second', note: null }, 2_000)
    updateTodo(db, task.id, '1', { state: TodoState.Done }, 3_000)
    expect(todoListFor(db, task.id)?.updatedAt).toBe(3_000)
  })
})

describe('highestTodoId', () => {
  let test: TestDatabase | undefined

  afterEach(() => {
    test?.close()
  })

  it('answers null for a task that has never made a todo', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    expect(highestTodoId(db, task.id)).toBeNull()
  })

  it('answers the highest id ever given, which never goes back once a todo of it is deleted', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    createTodo(db, task.id, { text: 'First', note: null })
    createTodo(db, task.id, { text: 'Second', note: null })
    expect(highestTodoId(db, task.id)).toBe(2)
    deleteTodo(db, task.id, '2')
    expect(highestTodoId(db, task.id)).toBe(2)
    expect(createTodo(db, task.id, { text: 'Third', note: null }).id).toBe('3')
  })
})

describe('refreshTodos', () => {
  let test: TestDatabase | undefined

  afterEach(() => {
    test?.close()
  })

  /** Refreshes the task's summary, and checks it's what the Todos tab counts from the same list. */
  function refreshed(db: Database, taskId: string): TodoSummary | null {
    const { list } = refreshTodos(db, taskId)
    const todos = getTask(db, taskId)?.todos ?? null
    expect(list).toEqual(todoListFor(db, taskId))
    expect(todos).toEqual(summarizeTodos(list))
    const tab = todoProgress(list)
    expect({ done: todos?.done ?? 0, total: todos?.total ?? 0, doing: todos?.doing.length ?? 0 }).toEqual(tab)
    return todos
  }

  it("keeps create_todo and update_todo's progress on the task, as the Todos tab counts it", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    expect(refreshed(db, task.id)).toBeNull()

    createTodo(db, task.id, { text: 'Find the uploads', note: null })
    createTodo(db, task.id, { text: 'Copy the files', note: null })
    createTodo(db, task.id, { text: 'Delete local copies', note: null })
    expect(refreshed(db, task.id)).toEqual({ done: 0, total: 3, doing: [] })
    updateTodo(db, task.id, '1', { state: TodoState.Doing })
    expect(refreshed(db, task.id)).toEqual({ done: 0, total: 3, doing: ['Find the uploads'] })
    updateTodo(db, task.id, '1', { state: TodoState.Done })
    updateTodo(db, task.id, '2', { state: TodoState.Doing, text: 'Copy the 3,900 files' })
    expect(refreshed(db, task.id)).toEqual({ done: 1, total: 3, doing: ['Copy the 3,900 files'] })
    deleteTodo(db, task.id, '3')
    expect(refreshed(db, task.id)).toEqual({ done: 1, total: 2, doing: ['Copy the 3,900 files'] })
    updateTodo(db, task.id, '2', { state: TodoState.Done })
    expect(refreshed(db, task.id)).toEqual({ done: 2, total: 2, doing: [] })
  })

  it('forgets the summary once every todo is deleted', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    createTodo(db, task.id, { text: 'Reproduce the failure', note: null })
    createTodo(db, task.id, { text: 'Find the race', note: null })
    updateTodo(db, task.id, '1', { state: TodoState.Done })
    expect(refreshed(db, task.id)).toEqual({ done: 1, total: 2, doing: [] })
    deleteTodo(db, task.id, '1')
    deleteTodo(db, task.id, '2')
    expect(refreshed(db, task.id)).toBeNull()
  })

  it("answers the task only when its summary changed, and leaves the task's place in the list alone", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id, 3_000)
    createTodo(db, task.id, { text: 'Find the uploads', note: null })

    const first = refreshTodos(db, task.id)
    expect(first.changed).toEqual({ ...task, todos: { done: 0, total: 1, doing: [] } })
    expect(first.changed).toEqual(getTask(db, task.id))
    expect(getTask(db, task.id)?.updatedAt).toBe(3_000)

    // A new note changes the tab's line, not the row.
    updateTodo(db, task.id, '1', { note: 'Finding the uploads' })
    expect(refreshTodos(db, task.id).changed).toBeNull()
    updateTodo(db, task.id, '1', { state: TodoState.Done })
    expect(refreshTodos(db, task.id).changed?.todos).toEqual({ done: 1, total: 1, doing: [] })
  })

  it("answers the list but no task for a task that's gone", () => {
    test = openTestDatabase()
    expect(refreshTodos(test.db, 'gone')).toEqual({ list: null, changed: null })
  })

  it('keeps up with a list of hundreds of items', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    putTodos(
      db,
      task.id,
      Array.from({ length: 400 }, (_, index) => {
        const id = index + 1
        const done = id <= 250
        return {
          id: String(id),
          text: `Migrate table ${String(id)}`,
          note: id === 251 ? 'Migrating table 251' : null,
          state: done ? TodoState.Done : id === 251 ? TodoState.Doing : TodoState.Todo,
          completedAt: done ? 1 : null,
        }
      }),
    )
    seedTodoCounterAtLeast(db, task.id, 401)

    const started = performance.now()
    expect(refreshed(db, task.id)).toEqual({ done: 250, total: 400, doing: ['Migrate table 251'] })
    // One refresh per todo call: it must stay quick however long the list grows.
    expect(performance.now() - started).toBeLessThan(500)
  })
})

describe('a finished time across a relaunch', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('is worked out from the stored table, so a relaunch shows the same times', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glade-todos-'))
    dirs.push(dir)
    const first = openAppDatabase(dir).db
    const task = sampleTask(first, sampleWorkspace(first).id)
    createTodo(first, task.id, { text: 'Find the uploads', note: null })
    createTodo(first, task.id, { text: 'Copy the files', note: null })
    updateTodo(first, task.id, '1', { state: TodoState.Done }, 9_000)
    const findDone = 9_000
    updateTodo(first, task.id, '2', { state: TodoState.Done }, 9_100)
    updateTodo(first, task.id, '2', { state: TodoState.Doing }, 9_200)
    const before = todoListFor(first, task.id)
    expect(before?.items.map(({ completedAt }) => completedAt)).toEqual([findDone, null])
    first.close()

    const relaunched = openAppDatabase(dir).db
    expect(todoListFor(relaunched, task.id)).toEqual(before)
    updateTodo(relaunched, task.id, '2', { state: TodoState.Done }, 9_300)
    expect(todoListFor(relaunched, task.id)?.items.map(({ completedAt }) => completedAt)).toEqual([findDone, 9_300])
    relaunched.close()
  })
})

describe('refreshStaleTodos', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it("works out the summaries marked stale, once, and they're there after a relaunch", () => {
    const dir = mkdtempSync(join(tmpdir(), 'glade-todos-'))
    dirs.push(dir)
    const first = openAppDatabase(dir).db
    const workspace = sampleWorkspace(first)
    const kept = sampleTask(first, workspace.id)
    const none = sampleTask(first, workspace.id)
    createTodo(first, kept.id, { text: 'Find the race', note: null })
    createTodo(first, kept.id, { text: 'Fix the wait', note: null })
    updateTodo(first, kept.id, '1', { state: TodoState.Done })
    updateTodo(first, kept.id, '2', { state: TodoState.Doing })
    // As migration 29 leaves a task that kept a list before there were summaries.
    first.prepare('UPDATE tasks SET todos_stale = 1 WHERE id = ?').run(kept.id)
    expect(getTask(first, kept.id)?.todos).toBeNull()

    expect(refreshStaleTodos(first)).toBe(1)
    expect(getTask(first, kept.id)?.todos).toEqual({ done: 1, total: 2, doing: ['Fix the wait'] })
    expect(refreshStaleTodos(first)).toBe(0)
    first.close()

    const relaunched = openAppDatabase(dir).db
    expect(refreshStaleTodos(relaunched)).toBe(0)
    expect(getTask(relaunched, kept.id)?.todos).toEqual({ done: 1, total: 2, doing: ['Fix the wait'] })
    expect(getTask(relaunched, none.id)?.todos).toBeNull()
    relaunched.close()
  })
})

describe('liveTodos (#593, unused by todoListFor any more, kept for the stranded code that still calls it)', () => {
  let test: TestDatabase | undefined
  const dirs: string[] = []

  afterEach(() => {
    test?.close()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  /** A shared list folder holding a todo file per id given, and a high-water mark. */
  function sharedList(taskId: string, ...ids: readonly string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'glade-live-todos-'))
    dirs.push(dir)
    const folder = sharedTaskListDir(dir, taskId)
    mkdirSync(folder, { recursive: true })
    for (const id of ids) writeFileSync(join(folder, `${id}.json`), `{"id":"${id}","status":"pending"}`)
    writeFileSync(join(folder, '.highwatermark'), '90')
    return dir
  }

  it('marks a todo the shared list folder no longer holds, and leaves one it holds alone', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    createTodo(db, task.id, { text: 'Review the date helpers', note: null })
    createTodo(db, task.id, { text: 'Watch CI on PR #42', note: null })
    createTodo(db, task.id, { text: 'Fix the UTC date test', note: null })

    expect(liveTodos(db, task.id, sharedList(task.id, '1', '3'))?.items).toEqual([
      { id: '1', text: 'Review the date helpers', state: TodoState.Todo, note: null, completedAt: null },
      { id: '2', text: 'Watch CI on PR #42', state: TodoState.Todo, note: null, completedAt: null, stranded: true },
      { id: '3', text: 'Fix the UTC date test', state: TodoState.Todo, note: null, completedAt: null },
    ])
  })

  it('changes nothing for a task with no shared folder, or with none of Glade to read it with', () => {
    test = openTestDatabase()
    const { db } = test
    const workspace = sampleWorkspace(db).id
    const task = sampleTask(db, workspace)
    createTodo(db, task.id, { text: 'Review the date helpers', note: null })
    const plain = todoListFor(db, task.id)

    expect(liveTodos(db, task.id, undefined)).toEqual(plain)
    const empty = mkdtempSync(join(tmpdir(), 'glade-live-todos-'))
    expect(liveTodos(db, task.id, empty)).toEqual(plain)
    rmSync(empty, { recursive: true, force: true })

    // A shared folder that holds every todo the task derives marks none of them.
    expect(liveTodos(db, task.id, sharedList(task.id, '1'))).toEqual(plain)

    // A task that keeps no list at all has none to mark.
    const other = sampleTask(db, workspace)
    expect(liveTodos(db, other.id, sharedList(other.id))).toBeNull()
  })

  it('answers the ids stranded, and none when there is no live list to compare with', () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    createTodo(db, task.id, { text: 'Review the date helpers', note: null })
    createTodo(db, task.id, { text: 'Watch CI on PR #42', note: null })
    const todos = todoListFor(db, task.id)?.items ?? []

    expect(strandedIds(todos, new Set(['1']))).toEqual(new Set(['2']))
    expect(strandedIds(todos, null)).toEqual(new Set())
  })
})
