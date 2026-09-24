import { afterEach, describe, expect, it } from 'vitest'
import { TodoState, ToolCallState, ToolEventKind, type ToolCallEvent, type ToolInput } from '../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { changesTodos, deriveTodoList, todoListFor } from './todos'

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
        { text: 'Find how uploads are stored', state: TodoState.Doing, note: 'Finding how uploads are stored' },
        { text: 'Copy the files', state: TodoState.Todo, note: null },
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
        { text: 'Find how uploads are stored', state: TodoState.Done, note: null },
        { text: 'Copy the files', state: TodoState.Doing, note: 'Copying the files' },
        { text: 'Delete local copies', state: TodoState.Todo, note: null },
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
      { text: 'Copy', state: TodoState.Doing, note: null },
      { text: 'Check', state: TodoState.Doing, note: null },
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
        { text: 'Find how uploads are stored', state: TodoState.Done, note: null },
        { text: 'Copy the files', state: TodoState.Doing, note: 'Copying the files' },
        { text: 'Delete the local copies', state: TodoState.Todo, note: null },
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
    expect(deriveTodoList(calls)?.items).toEqual([{ text: 'Copy the files', state: TodoState.Todo, note: null }])
  })

  it('replaces an item created again with the same id, and keeps one whose result gives no id', () => {
    const calls = [
      taskCreate('1', 'Find the uploads'),
      taskCreate('1', 'Find the stored uploads'),
      call('TaskCreate', { subject: 'Copy the files' }, { output: 'Created' }),
      taskUpdate({ taskId: '1', status: 'completed' }),
    ]
    expect(deriveTodoList(calls)?.items).toEqual([
      { text: 'Find the stored uploads', state: TodoState.Done, note: null },
      { text: 'Copy the files', state: TodoState.Todo, note: null },
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
    expect(list?.items).toEqual([{ text: 'Copy the files', state: TodoState.Todo, note: null }])
    expect(list?.updatedAt).toBe(kept.createdAt)
    expect(deriveTodoList(calls.slice(1))).toBeNull()
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
      items: [{ text: 'Copy the files', state: TodoState.Done, note: null }],
      updatedAt: 5_200,
    })
  })
})
