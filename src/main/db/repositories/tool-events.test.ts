import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DividerKind, ToolCallState, ToolEventKind, type Task } from '../../../shared/domain'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import { appendDivider, appendNarration, appendToolCall, listToolEvents, updateToolCall } from './tool-events'

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
