import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TodoState,
  ToolCallState,
  ToolEventKind,
  type TodoSummary,
  type ToolCallEvent,
  type ToolInput,
} from '../../shared/domain'
import { summarizeTodos, todoProgress } from '../../shared/todoSummary'
import { openAppDatabase } from '../db/database'
import { getTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { changesTodos, deriveTodoList, refreshStaleTodos, refreshTodos, todoListFor } from './todos'

let at = 1_000

/** A finished call, a millisecond after the one before. */
function call(
  name: string,
  input: ToolInput,
  options: { output?: string; state?: ToolCallState; parent?: string } = {},
): ToolCallEvent {
  at += 1
  return {
    kind: ToolEventKind.ToolCall,
    id: `event-${String(at)}`,
    taskId: 't1',
    turn: 1,
    createdAt: at,
    name,
    input,
    output: options.output ?? 'ok',
    state: options.state ?? ToolCallState.Done,
    toolUseId: `toolu_${String(at)}`,
    parentToolUseId: options.parent ?? null,
    progressSummary: null,
    finishedAt: at,
  }
}

const todoWrite = (todos: readonly { content: string; status: string; activeForm?: string }[]) =>
  call('TodoWrite', { todos })

const taskCreate = (id: string, subject: string, activeForm?: string) =>
  call(
    'TaskCreate',
    { subject, description: subject, ...(activeForm === undefined ? {} : { activeForm }) },
    {
      output: `Task #${id} created successfully: ${subject}`,
    },
  )

const taskUpdate = (input: ToolInput) => call('TaskUpdate', input, { output: 'Updated task' })

describe('changesTodos', () => {
  it("counts the main agent's finished, successful calls to a todo tool", () => {
    expect(changesTodos(todoWrite([]))).toBe(true)
    expect(changesTodos(taskCreate('1', 'Ship it'))).toBe(true)
    expect(changesTodos(taskUpdate({ taskId: '1' }))).toBe(true)
    expect(changesTodos(call('Bash', { command: 'ls' }))).toBe(false)
    expect(changesTodos(call('TodoWrite', { todos: [] }, { state: ToolCallState.Running }))).toBe(false)
    expect(changesTodos(call('TodoWrite', { todos: [] }, { state: ToolCallState.Error }))).toBe(false)
    expect(changesTodos(call('TodoWrite', { todos: [] }, { parent: 'toolu_agent' }))).toBe(false)
  })
})

describe('deriveTodoList', () => {
  it('is null until the agent keeps a list', () => {
    expect(deriveTodoList([])).toBeNull()
    expect(deriveTodoList([call('Bash', { command: 'ls' })])).toBeNull()
  })

  it("maps TodoWrite's statuses, with a doing item's active form as its note; each call replaces the list", () => {
    const first = todoWrite([
      { content: 'Find how uploads are stored', status: 'in_progress', activeForm: 'Finding how uploads are stored' },
      { content: 'Copy the files', status: 'pending', activeForm: 'Copying the files' },
    ])
    expect(deriveTodoList([first])).toEqual({
      items: [
        {
          text: 'Find how uploads are stored',
          state: TodoState.Doing,
          note: 'Finding how uploads are stored',
          completedAt: null,
        },
        { text: 'Copy the files', state: TodoState.Todo, note: null, completedAt: null },
      ],
      updatedAt: first.createdAt,
    })

    const second = todoWrite([
      { content: 'Find how uploads are stored', status: 'completed', activeForm: 'Finding how uploads are stored' },
      { content: 'Copy the files', status: 'in_progress', activeForm: 'Copying the files' },
      { content: 'Delete local copies', status: 'pending', activeForm: 'Deleting local copies' },
    ])
    expect(deriveTodoList([first, call('Bash', { command: 'ls' }), second])).toEqual({
      items: [
        { text: 'Find how uploads are stored', state: TodoState.Done, note: null, completedAt: second.createdAt },
        { text: 'Copy the files', state: TodoState.Doing, note: 'Copying the files', completedAt: null },
        { text: 'Delete local copies', state: TodoState.Todo, note: null, completedAt: null },
      ],
      updatedAt: second.createdAt,
    })
  })

  it('shows a doing item with no active form, or a blank one, without a note', () => {
    expect(
      deriveTodoList([
        todoWrite([
          { content: 'Copy', status: 'in_progress' },
          { content: 'Check', status: 'in_progress', activeForm: '  ' },
        ]),
      ])?.items,
    ).toEqual([
      { text: 'Copy', state: TodoState.Doing, note: null, completedAt: null },
      { text: 'Check', state: TodoState.Doing, note: null, completedAt: null },
    ])
  })

  it('keeps an empty list the agent cleared', () => {
    const cleared = todoWrite([])
    expect(deriveTodoList([todoWrite([{ content: 'Copy', status: 'completed' }]), cleared])).toEqual({
      items: [],
      updatedAt: cleared.createdAt,
    })
  })

  it('adds an item for each TaskCreate and changes it with each TaskUpdate, by the id its result gave it', () => {
    const calls = [
      taskCreate('1', 'Find how uploads are stored'),
      taskCreate('2', 'Copy the files', 'Copying the files'),
      taskCreate('3', 'Delete local copies'),
      taskUpdate({ taskId: '1', status: 'in_progress', activeForm: 'Finding the uploads' }),
      taskUpdate({ taskId: '1', status: 'completed' }),
      taskUpdate({ taskId: '2', status: 'in_progress' }),
      taskUpdate({ taskId: '3', subject: 'Delete the local copies' }),
    ]
    expect(deriveTodoList(calls)).toEqual({
      items: [
        { text: 'Find how uploads are stored', state: TodoState.Done, note: null, completedAt: calls[4]?.createdAt },
        { text: 'Copy the files', state: TodoState.Doing, note: 'Copying the files', completedAt: null },
        { text: 'Delete the local copies', state: TodoState.Todo, note: null, completedAt: null },
      ],
      updatedAt: calls.at(-1)?.createdAt,
    })
  })

  it('removes a deleted task, and ignores an update to one it does not know', () => {
    const calls = [
      taskCreate('1', 'Find the uploads'),
      taskCreate('2', 'Copy the files'),
      taskUpdate({ taskId: '1', status: 'deleted' }),
      taskUpdate({ taskId: '9', status: 'completed' }),
    ]
    expect(deriveTodoList(calls)?.items).toEqual([
      { text: 'Copy the files', state: TodoState.Todo, note: null, completedAt: null },
    ])
  })

  it('replaces an item created again with the same id, and keeps one whose result gives no id', () => {
    const calls = [
      taskCreate('1', 'Find the uploads'),
      taskCreate('1', 'Find the stored uploads'),
      call('TaskCreate', { subject: 'Copy the files' }, { output: 'Created' }),
      taskUpdate({ taskId: '1', status: 'completed' }),
    ]
    expect(deriveTodoList(calls)?.items).toEqual([
      { text: 'Find the stored uploads', state: TodoState.Done, note: null, completedAt: calls[3]?.createdAt },
      { text: 'Copy the files', state: TodoState.Todo, note: null, completedAt: null },
    ])
  })

  it("leaves the list alone for a call whose input doesn't parse, a failed call and a subagent's call", () => {
    const kept = todoWrite([{ content: 'Copy the files', status: 'pending' }])
    const calls = [
      kept,
      call('TodoWrite', { todos: 'Copy' }),
      call('TaskCreate', { title: 'No subject' }, { output: 'Task #1 created successfully: ?' }),
      call('TaskUpdate', { status: 'completed' }),
      call('TodoWrite', { todos: [] }, { state: ToolCallState.Error }),
      call('TodoWrite', { todos: [] }, { parent: 'toolu_agent' }),
    ]
    const list = deriveTodoList(calls)
    expect(list?.items).toEqual([{ text: 'Copy the files', state: TodoState.Todo, note: null, completedAt: null }])
    expect(list?.updatedAt).toBe(kept.createdAt)
    expect(deriveTodoList(calls.slice(1))).toBeNull()
  })
})

describe('when an item was finished', () => {
  /** Each item's text and when it was finished. */
  const finished = (calls: readonly ToolCallEvent[]) =>
    deriveTodoList(calls)?.items.map(({ text, completedAt }) => [text, completedAt])

  it('is the time of the TaskUpdate that completed it, kept through later updates, and lost when it reopens', () => {
    const created = [taskCreate('1', 'Find the uploads'), taskCreate('2', 'Copy the files')]
    const completed = taskUpdate({ taskId: '1', status: 'completed' })
    const again = taskUpdate({ taskId: '1', status: 'completed' })
    const renamed = taskUpdate({ taskId: '1', subject: 'Find the stored uploads', activeForm: 'Finding' })
    expect(finished([...created, completed, again, renamed])).toEqual([
      ['Find the stored uploads', completed.createdAt],
      ['Copy the files', null],
    ])

    const reopened = taskUpdate({ taskId: '1', status: 'in_progress' })
    expect(finished([...created, completed, reopened])).toEqual([
      ['Find the uploads', null],
      ['Copy the files', null],
    ])
    const pending = taskUpdate({ taskId: '1', status: 'pending' })
    expect(finished([...created, completed, pending])?.[0]).toEqual(['Find the uploads', null])

    // Finished again, it's the new time.
    const recompleted = taskUpdate({ taskId: '1', status: 'completed' })
    expect(finished([...created, completed, reopened, recompleted])?.[0]).toEqual([
      'Find the uploads',
      recompleted.createdAt,
    ])
  })

  it('gives each item its own TaskUpdate time, and none to an item created again with the same id', () => {
    const calls = [
      taskCreate('1', 'Find the uploads'),
      taskCreate('2', 'Copy the files'),
      taskUpdate({ taskId: '2', status: 'completed' }),
      taskUpdate({ taskId: '1', status: 'completed' }),
    ]
    expect(finished(calls)).toEqual([
      ['Find the uploads', calls[3]?.createdAt],
      ['Copy the files', calls[2]?.createdAt],
    ])
    expect(finished([...calls, taskCreate('2', 'Copy the files')])).toEqual([
      ['Find the uploads', calls[3]?.createdAt],
      ['Copy the files', null],
    ])
  })

  it('is the time of the first TodoWrite that marked it done, kept by the writes after it', () => {
    const first = todoWrite([
      { content: 'Reproduce the flake', status: 'completed' },
      { content: 'Fix the race', status: 'in_progress' },
      { content: 'Run the test 200 times', status: 'pending' },
    ])
    const second = todoWrite([
      { content: 'Reproduce the flake', status: 'completed' },
      { content: 'Fix the race', status: 'completed' },
      { content: 'Run the test 200 times', status: 'in_progress' },
    ])
    const third = todoWrite([
      { content: 'Reproduce the flake', status: 'completed' },
      { content: 'Fix the race', status: 'completed' },
      { content: 'Run the test 200 times', status: 'completed' },
    ])
    expect(finished([first, second, third])).toEqual([
      ['Reproduce the flake', first.createdAt],
      ['Fix the race', second.createdAt],
      ['Run the test 200 times', third.createdAt],
    ])
  })

  it('gives every item a TodoWrite completes at once the same time', () => {
    const start = todoWrite([
      { content: 'Reproduce the flake', status: 'in_progress' },
      { content: 'Fix the race', status: 'pending' },
      { content: 'Run the test 200 times', status: 'pending' },
    ])
    const all = todoWrite([
      { content: 'Reproduce the flake', status: 'completed' },
      { content: 'Fix the race', status: 'completed' },
      { content: 'Run the test 200 times', status: 'completed' },
    ])
    expect(finished([start, all])).toEqual([
      ['Reproduce the flake', all.createdAt],
      ['Fix the race', all.createdAt],
      ['Run the test 200 times', all.createdAt],
    ])
    // A single write that starts the list finished does the same.
    expect(new Set(finished([all])?.map(([, time]) => time))).toEqual(new Set([all.createdAt]))
  })

  it('loses its time when a TodoWrite reopens it, and takes the new one when it is done again', () => {
    const done = todoWrite([{ content: 'Fix the race', status: 'completed' }])
    const reopened = todoWrite([{ content: 'Fix the race', status: 'in_progress' }])
    const redone = todoWrite([{ content: 'Fix the race', status: 'completed' }])
    expect(finished([done, reopened])).toEqual([['Fix the race', null]])
    expect(finished([done, reopened, redone])).toEqual([['Fix the race', redone.createdAt]])
    // Dropped from the list and written back done, it's finished anew.
    const dropped = todoWrite([])
    expect(finished([done, dropped, redone])).toEqual([['Fix the race', redone.createdAt]])
  })

  it('matches TodoWrite items by their text, one to one, so repeated items keep their own times', () => {
    const one = todoWrite([
      { content: 'Run the tests', status: 'completed' },
      { content: 'Fix the race', status: 'pending' },
      { content: 'Run the tests', status: 'pending' },
    ])
    const two = todoWrite([
      { content: 'Run the tests', status: 'completed' },
      { content: 'Fix the race', status: 'completed' },
      { content: 'Run the tests', status: 'completed' },
    ])
    const renamed = todoWrite([
      { content: 'Run the unit tests', status: 'completed' },
      { content: 'Fix the race', status: 'completed' },
      { content: 'Run the tests', status: 'completed' },
    ])
    expect(finished([one, two])).toEqual([
      ['Run the tests', one.createdAt],
      ['Fix the race', two.createdAt],
      ['Run the tests', two.createdAt],
    ])
    // A renamed item is a new one, finished by the write that renamed it.
    expect(finished([one, two, renamed])).toEqual([
      ['Run the unit tests', renamed.createdAt],
      ['Fix the race', two.createdAt],
      ['Run the tests', one.createdAt],
    ])
  })

  it("keeps its time through calls that don't change the list", () => {
    const done = todoWrite([{ content: 'Fix the race', status: 'completed' }])
    const calls = [
      done,
      call('TodoWrite', { todos: 'Fix' }),
      call('TodoWrite', { todos: [] }, { state: ToolCallState.Error }),
      call('TodoWrite', { todos: [] }, { parent: 'toolu_agent' }),
      call('Bash', { command: 'ls' }),
    ]
    expect(finished(calls)).toEqual([['Fix the race', done.createdAt]])
  })
})

describe('todoListFor', () => {
  let test: TestDatabase | undefined

  afterEach(() => {
    test?.close()
  })

  it("works out a task's list from its stored tool log, so it survives a restart", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    expect(todoListFor(db, task.id)).toBeNull()

    const finish = (toolUseId: string, output: string) =>
      updateToolCall(db, { taskId: task.id, toolUseId, state: ToolCallState.Done, output })
    const base = { taskId: task.id, turn: 1, parentToolUseId: null }
    appendToolCall(db, { ...base, name: 'TaskCreate', input: { subject: 'Copy the files' }, toolUseId: 'a' }, 5_000)
    finish('a', 'Task #1 created successfully: Copy the files')
    appendToolCall(db, { ...base, name: 'Bash', input: { command: 'ls' }, toolUseId: 'b' }, 5_100)
    finish('b', 'uploads/')
    appendToolCall(
      db,
      { ...base, name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, toolUseId: 'c' },
      5_200,
    )
    // Still running: it hasn't changed the list yet.
    appendToolCall(
      db,
      { ...base, name: 'TaskUpdate', input: { taskId: '1', status: 'deleted' }, toolUseId: 'd' },
      5_300,
    )
    finish('c', 'Updated task #1 status')

    expect(todoListFor(db, task.id)).toEqual({
      items: [{ text: 'Copy the files', state: TodoState.Done, note: null, completedAt: 5_200 }],
      updatedAt: 5_200,
    })
  })
})

/** Logs a finished call of the main agent's to a task, as the runner does, a millisecond after the one before. */
function logCall(db: Database, taskId: string, name: string, input: ToolInput, output: string): void {
  at += 1
  const toolUseId = `toolu_${String(at)}`
  appendToolCall(db, { taskId, turn: 1, name, input, toolUseId, parentToolUseId: null }, at)
  updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Done, output }, at)
}

const logCreate = (db: Database, taskId: string, id: string, subject: string) => {
  logCall(db, taskId, 'TaskCreate', { subject, description: subject }, `Task #${id} created successfully: ${subject}`)
}

const logUpdate = (db: Database, taskId: string, input: ToolInput) => {
  logCall(db, taskId, 'TaskUpdate', input, 'Updated task')
}

const logWrite = (db: Database, taskId: string, todos: readonly { content: string; status: string }[]) => {
  logCall(db, taskId, 'TodoWrite', { todos }, 'Todos have been modified successfully.')
}

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

  it("keeps the TaskCreate and TaskUpdate list's progress on the task, as the Todos tab counts it", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)
    expect(refreshed(db, task.id)).toBeNull()

    logCreate(db, task.id, '1', 'Find the uploads')
    logCreate(db, task.id, '2', 'Copy the files')
    logCreate(db, task.id, '3', 'Delete local copies')
    expect(refreshed(db, task.id)).toEqual({ done: 0, total: 3, doing: [] })
    logUpdate(db, task.id, { taskId: '1', status: 'in_progress' })
    expect(refreshed(db, task.id)).toEqual({ done: 0, total: 3, doing: ['Find the uploads'] })
    logUpdate(db, task.id, { taskId: '1', status: 'completed' })
    logUpdate(db, task.id, { taskId: '2', status: 'in_progress', subject: 'Copy the 3,900 files' })
    expect(refreshed(db, task.id)).toEqual({ done: 1, total: 3, doing: ['Copy the 3,900 files'] })
    logUpdate(db, task.id, { taskId: '3', status: 'deleted' })
    expect(refreshed(db, task.id)).toEqual({ done: 1, total: 2, doing: ['Copy the 3,900 files'] })
    logUpdate(db, task.id, { taskId: '2', status: 'completed' })
    expect(refreshed(db, task.id)).toEqual({ done: 2, total: 2, doing: [] })
  })

  it("keeps the TodoWrite list's progress on the task, and forgets it once the list is cleared", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id)

    logWrite(db, task.id, [
      { content: 'Reproduce the failure', status: 'completed' },
      { content: 'Find the race', status: 'in_progress' },
      { content: 'Fix the wait', status: 'pending' },
    ])
    expect(refreshed(db, task.id)).toEqual({ done: 1, total: 3, doing: ['Find the race'] })
    logWrite(db, task.id, [
      { content: 'Reproduce the failure', status: 'completed' },
      { content: 'Find the race', status: 'completed' },
      { content: 'Fix the wait', status: 'completed' },
      { content: 'Run it 200 times', status: 'completed' },
    ])
    expect(refreshed(db, task.id)).toEqual({ done: 4, total: 4, doing: [] })
    logWrite(db, task.id, [])
    expect(refreshed(db, task.id)).toBeNull()
  })

  it("answers the task only when its summary changed, and leaves the task's place in the list alone", () => {
    test = openTestDatabase()
    const { db } = test
    const task = sampleTask(db, sampleWorkspace(db).id, 3_000)
    logCreate(db, task.id, '1', 'Find the uploads')

    const first = refreshTodos(db, task.id)
    expect(first.changed).toEqual({ ...task, todos: { done: 0, total: 1, doing: [] } })
    expect(first.changed).toEqual(getTask(db, task.id))
    expect(getTask(db, task.id)?.updatedAt).toBe(3_000)

    // A new active form changes the tab's note, not the row.
    logUpdate(db, task.id, { taskId: '1', activeForm: 'Finding the uploads' })
    expect(refreshTodos(db, task.id).changed).toBeNull()
    logUpdate(db, task.id, { taskId: '1', status: 'completed' })
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
    for (let id = 1; id <= 400; id += 1) logCreate(db, task.id, String(id), `Migrate table ${String(id)}`)
    for (let id = 1; id <= 250; id += 1) logUpdate(db, task.id, { taskId: String(id), status: 'completed' })
    logUpdate(db, task.id, { taskId: '251', status: 'in_progress' })

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

  it('is worked out from the stored tool log, so a relaunch shows the same times', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glade-todos-'))
    dirs.push(dir)
    const first = openAppDatabase(dir).db
    const task = sampleTask(first, sampleWorkspace(first).id)
    logCreate(first, task.id, '1', 'Find the uploads')
    logCreate(first, task.id, '2', 'Copy the files')
    logUpdate(first, task.id, { taskId: '1', status: 'completed' })
    const findDone = at
    logUpdate(first, task.id, { taskId: '2', status: 'completed' })
    logUpdate(first, task.id, { taskId: '2', status: 'in_progress' })
    const before = todoListFor(first, task.id)
    expect(before?.items.map(({ completedAt }) => completedAt)).toEqual([findDone, null])
    first.close()

    const relaunched = openAppDatabase(dir).db
    expect(todoListFor(relaunched, task.id)).toEqual(before)
    logUpdate(relaunched, task.id, { taskId: '2', status: 'completed' })
    expect(todoListFor(relaunched, task.id)?.items.map(({ completedAt }) => completedAt)).toEqual([findDone, at])
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
    logWrite(first, kept.id, [
      { content: 'Find the race', status: 'completed' },
      { content: 'Fix the wait', status: 'in_progress' },
    ])
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
