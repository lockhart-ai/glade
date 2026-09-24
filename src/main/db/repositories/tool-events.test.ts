import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CompactionTrigger, DividerKind, ToolCallState, ToolEventKind, type Task } from '../../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendToolCall,
  failRunningCompactions,
  failRunningToolCalls,
  listToolCallsNamed,
  listToolEvents,
  updateCompaction,
  updateToolCall,
} from './tool-events'

let test: TestDatabase
let task: Task

beforeEach(() => {
  test = openTestDatabase()
  task = sampleTask(test.db, sampleWorkspace(test.db).id)
})

afterEach(() => {
  test.close()
})

const UUID = expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown

function bashCall(toolUseId = 'toolu_bash', parentToolUseId: string | null = null) {
  return {
    taskId: task.id,
    turn: 1,
    name: 'Bash',
    input: { command: 'npm test', description: 'Run the test suite', options: { watch: false } },
    toolUseId,
    parentToolUseId,
  }
}

describe('appendNarration', () => {
  it('round-trips a narration', () => {
    const event = appendNarration(test.db, { taskId: task.id, turn: 1, text: "I'll check the test config." }, 3_000)

    expect(event).toEqual({
      kind: ToolEventKind.Narration,
      id: UUID,
      taskId: task.id,
      turn: 1,
      createdAt: 3_000,
      text: "I'll check the test config.",
    })
    expect(listToolEvents(test.db, task.id)).toEqual([event])
  })
})

describe('appendToolCall', () => {
  it('round-trips a running tool call, with its input as an object', () => {
    const event = appendToolCall(test.db, bashCall(), 3_000)

    expect(event).toEqual({
      kind: ToolEventKind.ToolCall,
      id: UUID,
      taskId: task.id,
      turn: 1,
      createdAt: 3_000,
      name: 'Bash',
      input: { command: 'npm test', description: 'Run the test suite', options: { watch: false } },
      output: null,
      state: ToolCallState.Running,
      toolUseId: 'toolu_bash',
      parentToolUseId: null,
    })
    expect(listToolEvents(test.db, task.id)).toEqual([event])
  })

  it("round-trips a subagent's tool call with its parent", () => {
    const event = appendToolCall(test.db, bashCall('toolu_inner', 'toolu_agent'))
    expect(listToolEvents(test.db, task.id)).toEqual([event])
    expect(event.parentToolUseId).toBe('toolu_agent')
  })

  it('refuses a second call with the same tool_use id in a task', () => {
    appendToolCall(test.db, bashCall())
    expect(() => appendToolCall(test.db, bashCall())).toThrow('UNIQUE constraint failed')
  })
})

describe('appendDivider', () => {
  it('round-trips every divider kind', () => {
    const dividers = Object.values(DividerKind).map((dividerKind) =>
      appendDivider(test.db, { taskId: task.id, turn: 2, dividerKind }, 3_000),
    )

    expect(dividers[0]).toEqual({
      kind: ToolEventKind.Divider,
      id: UUID,
      taskId: task.id,
      turn: 2,
      createdAt: 3_000,
      dividerKind: DividerKind.Turn,
    })
    expect(listToolEvents(test.db, task.id)).toEqual(dividers)
  })
})

describe('listToolEvents', () => {
  it("lists only this task's events, in the order they were appended, even when times tie", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const divider = appendDivider(test.db, { taskId: task.id, turn: 1, dividerKind: DividerKind.Turn }, 3_000)
    const note = appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Running the tests.' }, 3_000)
    appendNarration(test.db, { taskId: other.id, turn: 1, text: 'Elsewhere.' }, 3_000)
    const call = appendToolCall(test.db, bashCall(), 3_000)

    expect(listToolEvents(test.db, task.id)).toEqual([divider, note, call])
  })

  it('rejects a row with an unknown kind or variant value', () => {
    const note = appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Checking.' })
    test.db.pragma('ignore_check_constraints = ON')
    test.db.prepare("UPDATE tool_events SET kind = 'thinking' WHERE id = ?").run(note.id)
    expect(() => listToolEvents(test.db, task.id)).toThrow('tool_events.kind: expected one of')

    test.db
      .prepare("UPDATE tool_events SET kind = 'divider', text = NULL, divider_kind = 'paused' WHERE id = ?")
      .run(note.id)
    expect(() => listToolEvents(test.db, task.id)).toThrow('tool_events.divider_kind: expected one of')
  })

  it('rejects a row missing a field its kind needs', () => {
    const note = appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Checking.' })
    test.db.pragma('ignore_check_constraints = ON')
    test.db.prepare("UPDATE tool_events SET kind = 'tool_call' WHERE id = ?").run(note.id)

    expect(() => listToolEvents(test.db, task.id)).toThrow('tool_events.tool_name: expected text, got null')
  })
})

describe('updateToolCall', () => {
  it("fills in a call's result", () => {
    const call = appendToolCall(test.db, bashCall())

    const done = updateToolCall(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_bash',
      state: ToolCallState.Done,
      output: '12 passed',
    })

    expect(done).toEqual({ ...call, state: ToolCallState.Done, output: '12 passed' })
    expect(listToolEvents(test.db, task.id)).toEqual([done])
  })

  it('records an error result', () => {
    appendToolCall(test.db, bashCall())
    const failed = updateToolCall(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_bash',
      state: ToolCallState.Error,
      output: 'command not found',
    })
    expect(failed).toMatchObject({ state: ToolCallState.Error, output: 'command not found' })
  })

  it('throws when the task has no call with that id', () => {
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall(), taskId: other.id })

    expect(() =>
      updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_bash', state: ToolCallState.Done, output: '' }),
    ).toThrow(`No tool call toolu_bash in task ${task.id}`)
  })
})

describe('failRunningToolCalls', () => {
  it("records only this task's running calls as errors, in log order", () => {
    const first = appendToolCall(test.db, bashCall('toolu_1'))
    appendToolCall(test.db, bashCall('toolu_done'))
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_done', state: ToolCallState.Done, output: 'ok' })
    const second = appendToolCall(test.db, bashCall('toolu_2', 'toolu_1'))
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_other'), taskId: other.id })

    const failed = failRunningToolCalls(test.db, task.id, 'Glade quit.')

    const error = { state: ToolCallState.Error, output: 'Glade quit.' }
    expect(failed).toEqual([
      { ...first, ...error },
      { ...second, ...error },
    ])
    expect(listToolEvents(test.db, task.id).map((event) => 'state' in event && event.state)).toEqual([
      ToolCallState.Error,
      ToolCallState.Done,
      ToolCallState.Error,
    ])
    expect(listToolEvents(test.db, other.id)).toMatchObject([{ state: ToolCallState.Running }])
    expect(failRunningToolCalls(test.db, task.id, 'Glade quit.')).toEqual([])
  })
})

describe('the tool_events table', () => {
  function insert(columns: string, values: string): () => void {
    return () =>
      test.db
        .prepare(
          `INSERT INTO tool_events (id, task_id, seq, turn, created_at, ${columns}) VALUES ('e', ?, 1, 1, 0, ${values})`,
        )
        .run(task.id)
  }

  it('checks that each kind has exactly its own fields', () => {
    expect(insert('kind', "'narration'")).toThrow('CHECK constraint failed')
    expect(insert('kind, text, divider_kind', "'narration', 'x', 'turn'")).toThrow('CHECK constraint failed')
    expect(insert('kind, tool_name, tool_input, tool_state', "'tool_call', 'Bash', '{}', 'running'")).toThrow(
      'CHECK constraint failed',
    )
    expect(insert('kind, text', "'divider', 'x'")).toThrow('CHECK constraint failed')
  })

  it('checks enum values and that the input is a JSON object', () => {
    expect(insert('kind, text', "'thinking', 'x'")).toThrow('CHECK constraint failed')
    expect(insert('kind, divider_kind', "'divider', 'paused'")).toThrow('CHECK constraint failed')
    const call = "'tool_call', 'Bash', 'toolu_1'"
    expect(insert('kind, tool_name, tool_use_id, tool_input, tool_state', `${call}, '{}', 'queued'`)).toThrow(
      'CHECK constraint failed',
    )
    expect(insert('kind, tool_name, tool_use_id, tool_input, tool_state', `${call}, '[1]', 'running'`)).toThrow(
      'CHECK constraint failed',
    )
    expect(insert('kind, tool_name, tool_use_id, tool_input, tool_state', `${call}, '{', 'running'`)).toThrow(
      'CHECK constraint failed',
    )
  })
})

describe('compactions', () => {
  const running = () => ({
    taskId: task.id,
    turn: 2,
    trigger: CompactionTrigger.Manual,
    state: ToolCallState.Running,
    preTokens: null,
    postTokens: null,
    windowTokens: 200_000,
  })

  it('round-trips a running compaction, then fills in how it finished', () => {
    const event = appendCompaction(test.db, running(), 3_000)
    expect(event).toEqual({
      kind: ToolEventKind.Compaction,
      id: UUID,
      ...running(),
      createdAt: 3_000,
    })
    expect(listToolEvents(test.db, task.id)).toEqual([event])

    const done = updateCompaction(test.db, {
      id: event.id,
      state: ToolCallState.Done,
      preTokens: 198_000,
      postTokens: 41_000,
    })

    expect(done).toEqual({ ...event, state: ToolCallState.Done, preTokens: 198_000, postTokens: 41_000 })
    expect(listToolEvents(test.db, task.id)).toEqual([done])
  })

  it('throws when there is no such compaction', () => {
    const narration = appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Looking.' })
    const outcome = { state: ToolCallState.Done, preTokens: 1, postTokens: 1 }
    expect(() => updateCompaction(test.db, { id: 'nope', ...outcome })).toThrow('No compaction nope')
    expect(() => updateCompaction(test.db, { id: narration.id, ...outcome })).toThrow(/No compaction/)
  })

  it('fails the compactions still running, and only those', () => {
    const cut = appendCompaction(test.db, running())
    const finished = appendCompaction(test.db, {
      ...running(),
      trigger: CompactionTrigger.Auto,
      state: ToolCallState.Done,
      preTokens: 190_000,
      postTokens: 30_000,
    })

    expect(failRunningCompactions(test.db, task.id)).toEqual([{ ...cut, state: ToolCallState.Error }])
    expect(listToolEvents(test.db, task.id)).toEqual([{ ...cut, state: ToolCallState.Error }, finished])
    expect(failRunningCompactions(test.db, task.id)).toEqual([])
  })
})

describe('listToolCallsNamed', () => {
  it("lists a task's calls to the named tools, in order, and nothing else", () => {
    const write = (toolUseId: string) => ({ ...bashCall(toolUseId), name: 'TodoWrite', input: { todos: [] } })
    const first = appendToolCall(test.db, write('toolu_1'), 3_000)
    appendToolCall(test.db, bashCall('toolu_2'), 3_100)
    appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Next.' }, 3_200)
    const create = appendToolCall(
      test.db,
      { ...bashCall('toolu_3'), name: 'TaskCreate', input: { subject: 'Ship it' } },
      3_300,
    )
    const done = updateToolCall(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_3',
      state: ToolCallState.Done,
      output: 'Task #1 created successfully: Ship it',
    })
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...write('toolu_4'), taskId: other.id }, 3_400)

    expect(listToolCallsNamed(test.db, task.id, ['TodoWrite', 'TaskCreate'])).toEqual([first, done])
    expect(done.id).toBe(create.id)
    expect(listToolCallsNamed(test.db, task.id, ['Grep'])).toEqual([])
    expect(listToolCallsNamed(test.db, task.id, [])).toEqual([])
  })
})
