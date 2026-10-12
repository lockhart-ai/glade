// `create_todo`, `update_todo` and `list_todos` (#609), on a real database: what each tells the model, what it
// writes, and what it tells the windows.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import { TodoState, type Task } from '../../shared/domain'
import { ChildKind, FilingSource } from '../../shared/todoHub'
import { addArtifact } from '../db/repositories/artifacts'
import { putFilings } from '../db/repositories/child-filings'
import { listTodos } from '../db/repositories/glade-todos'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { getTask } from '../db/repositories/tasks'
import { NO_TODOS } from '../todo-hub/agent-children'
import type { FilingContext } from '../todo-hub/todo-hub'
import { createTodoForAgent, listTodosForAgent, updateTodoForAgent, UPDATE_TODO_CHANGES_NOTHING } from './agent-todos'

let database: TestDatabase
let db: Database
let task: Task
let events: GladeEvent[]
let context: FilingContext

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
  task = sampleTask(db, sampleWorkspace(db).id)
  events = []
  context = { db, emit: (event) => events.push(event) }
})

afterEach(() => {
  database.close()
})

describe('createTodoForAgent', () => {
  it('creates a not-started todo, with or without a note, and tells the windows', () => {
    expect(createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })).toBe(
      'Todo #1 created: Review the date helpers.',
    )
    expect(createTodoForAgent(context, task.id, { subject: 'Watch CI', note: 'Watching CI' })).toBe(
      'Todo #2 created: Watch CI.',
    )
    expect(listTodos(db, task.id)).toEqual([
      { id: '1', text: 'Review the date helpers', note: null, state: TodoState.Todo, completedAt: null },
      { id: '2', text: 'Watch CI', note: 'Watching CI', state: TodoState.Todo, completedAt: null },
    ])
    expect(events.map(({ type }) => type)).toEqual([
      EventType.TodosChanged,
      EventType.TaskUpdated,
      EventType.TodosChanged,
      EventType.TaskUpdated,
    ])
    expect(getTask(db, task.id)?.todos).toEqual({ done: 0, total: 2, doing: [] })
  })
})

describe('updateTodoForAgent', () => {
  it('refuses an id the task has no todo for, naming the ones it has', () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    expect(() => updateTodoForAgent(context, task.id, { id: '9', note: 'x' })).toThrow(
      /There's no todo #9 in this task's list\. Your todos: #1 Review the date helpers \(pending\)/,
    )
  })

  it("changes a todo's subject, note and status together", () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    expect(
      updateTodoForAgent(context, task.id, {
        id: '1',
        subject: 'Review the date helpers carefully',
        note: 'Reading the diff',
        status: 'in_progress',
      }),
    ).toBe('Todo #1 updated.')
    expect(listTodos(db, task.id)).toEqual([
      {
        id: '1',
        text: 'Review the date helpers carefully',
        note: 'Reading the diff',
        state: TodoState.Doing,
        completedAt: null,
      },
    ])
  })

  it('drops the old note once completed, when the call gives none of its own', () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    updateTodoForAgent(context, task.id, { id: '1', status: 'in_progress', note: 'Reading the diff' })

    updateTodoForAgent(context, task.id, { id: '1', status: 'completed' })

    expect(listTodos(db, task.id)).toEqual([
      {
        id: '1',
        text: 'Review the date helpers',
        note: null,
        state: TodoState.Done,
        completedAt: expect.any(Number) as number,
      },
    ])
  })

  it('keeps a note the same call gives when it completes the todo', () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    updateTodoForAgent(context, task.id, { id: '1', status: 'in_progress', note: 'Reading the diff' })

    updateTodoForAgent(context, task.id, { id: '1', status: 'completed', note: 'Merged Oct 12' })

    expect(listTodos(db, task.id)).toEqual([
      {
        id: '1',
        text: 'Review the date helpers',
        note: 'Merged Oct 12',
        state: TodoState.Done,
        completedAt: expect.any(Number) as number,
      },
    ])
  })

  it('refuses an update that changes none of subject, note or status', () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    expect(() => updateTodoForAgent(context, task.id, { id: '1' })).toThrow(UPDATE_TODO_CHANGES_NOTHING)
    expect(listTodos(db, task.id)).toEqual([
      { id: '1', text: 'Review the date helpers', note: null, state: TodoState.Todo, completedAt: null },
    ])
  })

  it('deletes a todo with status "deleted", telling the windows', () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    events.length = 0

    expect(updateTodoForAgent(context, task.id, { id: '1', status: 'deleted' })).toBe(
      'Deleted todo #1 Review the date helpers (pending).',
    )

    expect(listTodos(db, task.id)).toEqual([])
    expect(events.map(({ type }) => type)).toEqual([EventType.TodosChanged, EventType.TaskUpdated])
  })

  it('refuses to delete a todo with children still filed under it, naming each by its short id', () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    addArtifact(db, { taskId: task.id, path: 'docs/plan.md', title: 'The plan' })
    putFilings(db, task.id, [{ kind: ChildKind.File, key: 'docs/plan.md', todoId: '1', source: FilingSource.Named }])

    expect(() => updateTodoForAgent(context, task.id, { id: '1', status: 'deleted' })).toThrow(
      'Todo #1 Review the date helpers (pending) still has children filed under it: c1: file "The plan". ' +
        'Move each to the todo it belongs under with file_children, then delete it.',
    )
    expect(listTodos(db, task.id)).toHaveLength(1)
  })
})

describe('listTodosForAgent', () => {
  it('says there are none yet', () => {
    expect(listTodosForAgent(db, task.id)).toBe(NO_TODOS)
  })

  it("lists each todo, one line, with its note after a dash when it has one, and none when it's done", () => {
    createTodoForAgent(context, task.id, { subject: 'Review the date helpers' })
    createTodoForAgent(context, task.id, { subject: 'Watch CI on PR #42' })
    updateTodoForAgent(context, task.id, { id: '2', status: 'in_progress', note: 'Watching CI' })
    updateTodoForAgent(context, task.id, { id: '1', status: 'completed' })

    expect(listTodosForAgent(db, task.id)).toBe(
      '#1 [completed] Review the date helpers\n#2 [in_progress] Watch CI on PR #42 — Watching CI',
    )
  })
})
