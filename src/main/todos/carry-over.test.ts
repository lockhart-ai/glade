import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Database } from 'better-sqlite3'
import type { Task } from '../../shared/domain'
import { TodoState, ToolCallState, ToolEventKind, type ToolCallEvent, type ToolInput } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { getTodoCounter, listTodos } from '../db/repositories/glade-todos'
import { carryOverTodos, replayLegacyTodos } from './carry-over'

let test: TestDatabase | undefined
let seq = 0

beforeEach(() => {
  seq = 0
})

afterEach(() => {
  test?.close()
})

/** A finished call, in memory: for `replayLegacyTodos`'s own tests, which don't touch the database. */
function call(
  name: string,
  input: ToolInput,
  options: { output?: string; parent?: string | null } = {},
): ToolCallEvent {
  seq += 1
  return {
    kind: ToolEventKind.ToolCall,
    id: `event-${String(seq)}`,
    taskId: 't1',
    turn: 1,
    createdAt: 1_000 + seq,
    name,
    input,
    output: options.output ?? 'ok',
    state: ToolCallState.Done,
    toolUseId: `toolu_${String(seq)}`,
    parentToolUseId: options.parent ?? null,
    progressSummary: null,
    finishedAt: 1_000 + seq,
  }
}

/** A fresh database with one task, both handed back so a test never has to narrow `test` itself. */
function task(): { db: Database; task: Task } {
  const opened = openTestDatabase()
  test = opened
  return { db: opened.db, task: sampleTask(opened.db, sampleWorkspace(opened.db).id) }
}

/** Logs a finished call of the main agent's, a tick after the one before, as the runner does. */
function logCall(db: Database, taskId: string, name: string, input: ToolInput, output: string): void {
  seq += 1
  const toolUseId = `toolu_${String(seq)}`
  const at = 1_000 + seq
  appendToolCall(db, { taskId, turn: 1, name, input, toolUseId, parentToolUseId: null }, at)
  updateToolCall(db, { taskId, toolUseId, state: ToolCallState.Done, output }, at)
}

const create = (db: Database, taskId: string, id: string, subject: string, activeForm?: string) => {
  logCall(
    db,
    taskId,
    'TaskCreate',
    { subject, ...(activeForm === undefined ? {} : { activeForm }) },
    `Task #${id} created successfully: ${subject}`,
  )
}

const update = (db: Database, taskId: string, input: ToolInput) => {
  logCall(db, taskId, 'TaskUpdate', input, 'Updated task')
}

const write = (
  db: Database,
  taskId: string,
  todos: readonly { content: string; status: string; activeForm?: string }[],
) => {
  logCall(db, taskId, 'TodoWrite', { todos }, 'Todos have been modified successfully.')
}

describe('replayLegacyTodos', () => {
  it('answers an empty list and no highest id for no calls', () => {
    expect(replayLegacyTodos([])).toEqual({ items: [], highestIdEverGiven: null })
  })

  it('tracks the highest id ever given, even once deleted or taken over by a later TaskCreate', () => {
    const calls = [
      call('TaskCreate', { subject: 'First' }, { output: 'Task #1 created successfully: First' }),
      call('TaskCreate', { subject: 'Second' }, { output: 'Task #2 created successfully: Second' }),
      call('TaskUpdate', { taskId: '2', status: 'deleted' }, { output: 'Updated task' }),
      call('TaskCreate', { subject: 'First again' }, { output: 'Task #1 created successfully: First again' }),
    ]
    expect(replayLegacyTodos(calls)).toEqual({
      items: [{ id: '1', text: 'First again', note: null, state: TodoState.Todo, completedAt: null }],
      highestIdEverGiven: 2,
    })
  })

  it('ignores a subagent call, and one that failed or is still running', () => {
    const calls = [
      call(
        'TaskCreate',
        { subject: 'A subagent made this' },
        { output: 'Task #1 created successfully: A subagent made this', parent: 'toolu_parent' },
      ),
      {
        ...call('TaskCreate', { subject: 'Still running' }, { output: 'Task #1 created successfully: Still running' }),
        state: ToolCallState.Running,
      },
      {
        ...call('TaskCreate', { subject: 'Failed' }, { output: 'Task #1 created successfully: Failed' }),
        state: ToolCallState.Error,
      },
    ]
    expect(replayLegacyTodos(calls)).toEqual({ items: [], highestIdEverGiven: null })
  })
})

describe('carryOverTodos', () => {
  it('carries ids, text, note, state and finish time over unchanged', () => {
    const { db, task: a } = task()
    create(db, a.id, '1', 'Review the date helpers', 'Reading the diff')
    update(db, a.id, { taskId: '1', status: 'in_progress' })
    create(db, a.id, '2', 'Write the release notes', 'Drafting the changelog')
    update(db, a.id, { taskId: '2', status: 'completed' })

    carryOverTodos(db, a.id)

    expect(listTodos(db, a.id)).toEqual([
      { id: '1', text: 'Review the date helpers', note: 'Reading the diff', state: TodoState.Doing, completedAt: null },
      // Done drops the note even though the call still carried an activeForm: an old spinner line would read
      // wrongly once the todo is finished.
      { id: '2', text: 'Write the release notes', note: null, state: TodoState.Done, completedAt: 1_000 + 4 },
    ])
  })

  it('carries a note for a not-started todo too, not only a doing one, since Glade owns the list now', () => {
    const { db, task: a } = task()
    create(db, a.id, '1', 'Review the date helpers', 'Waiting on the PR to open')

    carryOverTodos(db, a.id)

    expect(listTodos(db, a.id)).toEqual([
      {
        id: '1',
        text: 'Review the date helpers',
        note: 'Waiting on the PR to open',
        state: TodoState.Todo,
        completedAt: null,
      },
    ])
  })

  it('leaves a retired id out, and never gives it again', () => {
    const { db, task: a } = task()
    create(db, a.id, '1', 'Old, closed todo')
    create(db, a.id, '2', 'Still live')

    carryOverTodos(db, a.id, new Set(['1']))

    expect(listTodos(db, a.id).map(({ id }) => id)).toEqual(['2'])
    // The counter started past the highest id ever given (1), not just past what's left (2), so a fresh todo still
    // never reuses the retired number.
    expect(getTodoCounter(db, a.id)).toBeGreaterThanOrEqual(3)
  })

  it('carries a stranded-looking todo over as an ordinary one: nothing here reads any shared list folder', () => {
    const { db, task: a } = task()
    create(db, a.id, '1', 'Made before any shared list folder existed for this task')

    carryOverTodos(db, a.id)

    expect(listTodos(db, a.id)).toEqual([
      {
        id: '1',
        text: 'Made before any shared list folder existed for this task',
        note: null,
        state: TodoState.Todo,
        completedAt: null,
      },
    ])
  })

  it('carries what the tab shows today when a later TaskCreate took an earlier id over', () => {
    const { db, task: a } = task()
    create(db, a.id, '1', 'Review the date helpers')
    update(db, a.id, { taskId: '1', status: 'completed' })
    // A restart's TaskCreate reused #1 for something else entirely (#593's bug): the old one is gone, not merged.
    create(db, a.id, '1', 'Recreated after a restart')

    carryOverTodos(db, a.id)

    expect(listTodos(db, a.id)).toEqual([
      { id: '1', text: 'Recreated after a restart', note: null, state: TodoState.Todo, completedAt: null },
    ])
  })

  it('gives a no-id legacy item (a TodoWrite one) the next free id, so nothing the tab shows is dropped', () => {
    const { db, task: a } = task()
    create(db, a.id, '5', 'Has a real id')
    write(db, a.id, [
      { content: 'From TodoWrite, no id', status: 'pending' },
      { content: 'Has a real id', status: 'pending' },
    ])

    carryOverTodos(db, a.id)

    const items = listTodos(db, a.id)
    expect(items).toHaveLength(2)
    // TodoWrite replaces the whole list, so the id-bearing item is gone too, but both still show, the new one with a
    // freshly given id above the highest ever given (5).
    expect(items.map(({ text }) => text).sort()).toEqual(['From TodoWrite, no id', 'Has a real id'])
    for (const { id } of items) expect(Number(id)).toBeGreaterThanOrEqual(6)
    expect(new Set(items.map(({ id }) => id)).size).toBe(2)
  })

  it('changes nothing the second time it runs for the same task', () => {
    const { db, task: a } = task()
    create(db, a.id, '1', 'Review the date helpers')

    carryOverTodos(db, a.id)
    const after = listTodos(db, a.id)
    const counter = getTodoCounter(db, a.id)

    // Even given a retired id it didn't see the first time, a second run is a no-op: the counter already exists.
    carryOverTodos(db, a.id, new Set(['1']))

    expect(listTodos(db, a.id)).toEqual(after)
    expect(getTodoCounter(db, a.id)).toBe(counter)
  })

  it('leaves another task alone', () => {
    const { db, task: a } = task()
    const b = sampleTask(db, sampleWorkspace(db, '/code/other').id)
    create(db, a.id, '1', "A's todo")
    create(db, b.id, '1', "B's todo")

    carryOverTodos(db, a.id)

    expect(listTodos(db, a.id).map(({ text }) => text)).toEqual(["A's todo"])
    expect(listTodos(db, b.id)).toEqual([])
    expect(getTodoCounter(db, b.id)).toBeNull()
  })
})
