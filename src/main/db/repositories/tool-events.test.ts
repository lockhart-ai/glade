import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CompactionTrigger,
  DividerKind,
  RefusalScope,
  ToolCallState,
  ToolEventKind,
  WatcherKind,
  WatcherState,
  type Task,
  type ToolCallEvent,
} from '../../../shared/domain'
import { openAppDatabase } from '../database'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from './test-database'
import {
  appendCompaction,
  appendDivider,
  appendNarration,
  appendRefusalFallback,
  appendToolCall,
  deleteToolEvent,
  failRunningCompactions,
  getToolCall,
  interruptPausedToolCalls,
  interruptRunningToolCall,
  interruptRunningToolCalls,
  listSubagentCallsToPreload,
  listToolCallsNamed,
  listToolEvents,
  reopenSubagentCall,
  setAgentCallContextTokens,
  setAgentCallTokenTotals,
  setSubagentProgress,
  updateCompaction,
  updateToolCall,
  previousToolCall,
} from './tool-events'
import { addWatcher } from './watchers'

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
      parentToolUseId: null,
      seq: expect.any(Number) as unknown,
    })
    expect(listToolEvents(test.db, task.id)).toEqual([event])
  })

  it("round-trips a subagent's note with its parent", () => {
    const event = appendNarration(test.db, {
      taskId: task.id,
      turn: 1,
      text: 'Reading the API PRs.',
      parentToolUseId: 'toolu_agent',
    })
    expect(event.parentToolUseId).toBe('toolu_agent')
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
      finishedAt: null,
      toolUseId: 'toolu_bash',
      parentToolUseId: null,
      progressSummary: null,
      seq: expect.any(Number) as unknown,
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
      seq: expect.any(Number) as unknown,
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

    const done = updateToolCall(
      test.db,
      { taskId: task.id, toolUseId: 'toolu_bash', state: ToolCallState.Done, output: '12 passed' },
      5_000,
    )

    expect(done).toEqual({ ...call, state: ToolCallState.Done, output: '12 passed', finishedAt: 5_000 })
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

describe('interruptRunningToolCalls', () => {
  it("records only this task's running calls as interrupted, in log order", () => {
    const first = appendToolCall(test.db, bashCall('toolu_1'))
    appendToolCall(test.db, bashCall('toolu_done'))
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_done', state: ToolCallState.Done, output: 'ok' })
    const second = appendToolCall(test.db, bashCall('toolu_2', 'toolu_1'))
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_other'), taskId: other.id })

    const interrupted = interruptRunningToolCalls(test.db, task.id, 'Glade quit.', 9_000)

    const note = { state: ToolCallState.Interrupted, output: 'Glade quit.', finishedAt: 9_000 }
    expect(interrupted).toEqual([
      { ...first, ...note },
      { ...second, ...note },
    ])
    expect(listToolEvents(test.db, task.id).map((event) => 'state' in event && event.state)).toEqual([
      ToolCallState.Interrupted,
      ToolCallState.Done,
      ToolCallState.Interrupted,
    ])
    expect(listToolEvents(test.db, other.id)).toMatchObject([{ state: ToolCallState.Running }])
    expect(interruptRunningToolCalls(test.db, task.id, 'Glade quit.')).toEqual([])
  })
})

describe('interruptRunningToolCall', () => {
  it('records the one call as interrupted while it runs, and leaves any other alone', () => {
    const call = appendToolCall(test.db, bashCall('toolu_1'))
    appendToolCall(test.db, bashCall('toolu_2'))

    const interrupted = interruptRunningToolCall(test.db, task.id, 'toolu_1', 'Glade quit.', 9_000)

    expect(interrupted).toEqual({ ...call, state: ToolCallState.Interrupted, output: 'Glade quit.', finishedAt: 9_000 })
    expect(interruptRunningToolCall(test.db, task.id, 'toolu_1', 'Again.')).toBeUndefined()
    expect(interruptRunningToolCall(test.db, task.id, 'toolu_missing', 'Glade quit.')).toBeUndefined()
    expect(listToolEvents(test.db, task.id).map((event) => 'state' in event && event.state)).toEqual([
      ToolCallState.Interrupted,
      ToolCallState.Running,
    ])
  })
})

describe('interruptPausedToolCalls', () => {
  it("records only this task's paused calls as interrupted, keeping their output, in log order", () => {
    const paused = { state: ToolCallState.Paused, output: 'The task paused.' }
    const first = appendToolCall(test.db, bashCall('toolu_1'))
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_1', ...paused }, 4_000)
    appendToolCall(test.db, bashCall('toolu_error'))
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_error', state: ToolCallState.Error, output: 'no' })
    const second = appendToolCall(test.db, bashCall('toolu_2'))
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_2', state: ToolCallState.Paused, output: null }, 5_000)
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_other'), taskId: other.id })
    updateToolCall(test.db, { taskId: other.id, toolUseId: 'toolu_other', ...paused })

    // Each keeps the time it paused at, which is when it stopped.
    expect(interruptPausedToolCalls(test.db, task.id)).toEqual([
      { ...first, state: ToolCallState.Interrupted, output: 'The task paused.', finishedAt: 4_000 },
      { ...second, state: ToolCallState.Interrupted, output: null, finishedAt: 5_000 },
    ])
    expect(listToolEvents(test.db, task.id).map((event) => 'state' in event && event.state)).toEqual([
      ToolCallState.Interrupted,
      ToolCallState.Error,
      ToolCallState.Interrupted,
    ])
    expect(listToolEvents(test.db, other.id)).toMatchObject([{ state: ToolCallState.Paused }])
    expect(interruptPausedToolCalls(test.db, task.id)).toEqual([])
  })
})

describe('setSubagentProgress', () => {
  function agentCall(toolUseId = 'toolu_agent', name = 'Agent') {
    return appendToolCall(test.db, { ...bashCall(toolUseId), name, input: { description: 'API changes' } })
  }

  const progress = (summary: string, toolUseId = 'toolu_agent') => ({ taskId: task.id, toolUseId, summary })

  it("keeps a running subagent's latest summary on its call, and says so", () => {
    const call = agentCall()

    const first = setSubagentProgress(test.db, progress('Reading the API PRs'))
    expect(first).toEqual({ ...call, progressSummary: 'Reading the API PRs' })
    const second = setSubagentProgress(test.db, progress('Sorting 14 PRs into features and fixes'))
    expect(second).toEqual({ ...call, progressSummary: 'Sorting 14 PRs into features and fixes' })
    expect(listToolEvents(test.db, task.id)).toEqual([second])
  })

  it('takes a `Task` call too, the name the init tools list gives the tool', () => {
    agentCall('toolu_task', 'Task')
    expect(setSubagentProgress(test.db, progress('Reading', 'toolu_task'))?.progressSummary).toBe('Reading')
  })

  it('changes nothing for the summary it already has', () => {
    agentCall()
    setSubagentProgress(test.db, progress('Reading the API PRs'))
    expect(setSubagentProgress(test.db, progress('Reading the API PRs'))).toBeUndefined()
  })

  it('ignores a summary for a subagent that has finished, one that never started, and a call that is no subagent', () => {
    agentCall()
    setSubagentProgress(test.db, progress('Reading the API PRs'))
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_agent', state: ToolCallState.Done, output: 'Done.' })
    appendToolCall(test.db, bashCall('toolu_bash'))

    expect(setSubagentProgress(test.db, progress('Late news'))).toBeUndefined()
    expect(setSubagentProgress(test.db, progress('Reading', 'toolu_missing'))).toBeUndefined()
    expect(setSubagentProgress(test.db, progress('Running npm test', 'toolu_bash'))).toBeUndefined()
    expect(listToolEvents(test.db, task.id)).toMatchObject([
      { state: ToolCallState.Done, progressSummary: null },
      { name: 'Bash', progressSummary: null },
    ])
  })

  it("only touches this task's call", () => {
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_agent'), taskId: other.id, name: 'Agent' })
    agentCall()

    setSubagentProgress(test.db, progress('Reading the API PRs'))

    expect(listToolEvents(test.db, other.id)).toMatchObject([{ progressSummary: null }])
    expect(listToolEvents(test.db, task.id)).toMatchObject([{ progressSummary: 'Reading the API PRs' }])
  })

  it.each([ToolCallState.Done, ToolCallState.Error, ToolCallState.Paused, ToolCallState.Interrupted])(
    'drops the summary once its call is %s',
    (state) => {
      agentCall()
      setSubagentProgress(test.db, progress('Reading the API PRs'))

      expect(updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_agent', state, output: 'x' })).toMatchObject({
        state,
        progressSummary: null,
      })
    },
  )

  it('drops the summary of a subagent the app quit on, when its call is interrupted', () => {
    agentCall()
    setSubagentProgress(test.db, progress('Reading the API PRs'))

    expect(interruptRunningToolCalls(test.db, task.id, 'Glade quit.')).toMatchObject([{ progressSummary: null }])
  })

  it('survives a relaunch: the database reopened still has it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glade-repo-'))
    try {
      const first = openAppDatabase(dir).db
      const running = sampleTask(first, sampleWorkspace(first).id)
      appendToolCall(first, { ...bashCall(), taskId: running.id, name: 'Agent' })
      setSubagentProgress(first, { taskId: running.id, toolUseId: 'toolu_bash', summary: 'Reading the API PRs' })
      first.close()

      const second = openAppDatabase(dir).db
      expect(listToolEvents(second, running.id)).toMatchObject([{ progressSummary: 'Reading the API PRs' }])
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the context size beside the summary (#592)', () => {
    agentCall()

    const first = setSubagentProgress(test.db, { ...progress('Reading the API PRs'), contextTokens: 13_530 })
    expect(first).toMatchObject({ progressSummary: 'Reading the API PRs', contextTokens: 13_530 })
  })

  it('takes a figure alone, and keeps the summary it already has', () => {
    const call = agentCall()
    setSubagentProgress(test.db, progress('Reading the API PRs'))

    const figure = setSubagentProgress(test.db, { taskId: task.id, toolUseId: 'toolu_agent', contextTokens: 478_200 })
    expect(figure).toEqual({ ...call, progressSummary: 'Reading the API PRs', contextTokens: 478_200 })
  })

  it('changes nothing when neither the summary nor the figure is news', () => {
    agentCall()
    setSubagentProgress(test.db, { ...progress('Reading the API PRs'), contextTokens: 13_530 })

    expect(setSubagentProgress(test.db, { ...progress('Reading the API PRs'), contextTokens: 13_530 })).toBeUndefined()
    expect(
      setSubagentProgress(test.db, { taskId: task.id, toolUseId: 'toolu_agent', contextTokens: 13_530 }),
    ).toBeUndefined()
  })

  it('ignores a figure for a subagent that has finished, one that never started, and a call that is no subagent', () => {
    agentCall()
    setSubagentProgress(test.db, { ...progress('Reading the API PRs'), contextTokens: 13_530 })
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_agent', state: ToolCallState.Done, output: 'Done.' })
    appendToolCall(test.db, bashCall('toolu_bash'))

    expect(
      setSubagentProgress(test.db, { taskId: task.id, toolUseId: 'toolu_agent', contextTokens: 13_531 }),
    ).toBeUndefined()
    expect(
      setSubagentProgress(test.db, { taskId: task.id, toolUseId: 'toolu_missing', contextTokens: 13_531 }),
    ).toBeUndefined()
    expect(
      setSubagentProgress(test.db, { taskId: task.id, toolUseId: 'toolu_bash', contextTokens: 13_531 }),
    ).toBeUndefined()
    expect(getToolCall(test.db, task.id, 'toolu_bash')).not.toHaveProperty('contextTokens')
    expect(getToolCall(test.db, task.id, 'toolu_agent')).toMatchObject({ contextTokens: 13_530 })
  })

  it('takes a dispatched child’s `dispatch` call too, the filter being the tool’s name', () => {
    const call = appendToolCall(test.db, { ...bashCall('toolu_dispatch'), name: 'mcp__glade-agents__dispatch' })

    const figure = setSubagentProgress(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_dispatch',
      contextTokens: 478_200,
    })
    expect(figure).toEqual({ ...call, contextTokens: 478_200 })
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
    // Only a compaction has a summary.
    expect(insert('kind, text, compact_summary', "'narration', 'x', 'Kept.'")).toThrow('CHECK constraint failed')
    // Only a tool call has a progress summary.
    expect(insert('kind, text, progress_summary', "'narration', 'x', 'Reading'")).toThrow('CHECK constraint failed')
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
      summary: null,
      seq: expect.any(Number) as unknown,
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

  it('keeps what a compaction carried over, given when it finishes or as it is logged, and none for an empty one', () => {
    const event = appendCompaction(test.db, running(), 3_000)
    const outcome = { id: event.id, state: ToolCallState.Done, preTokens: 198_000, postTokens: 41_000 }

    const done = updateCompaction(test.db, { ...outcome, summary: '1. Primary Request and Intent: move uploads.' })
    expect(done.summary).toBe('1. Primary Request and Intent: move uploads.')
    expect(listToolEvents(test.db, task.id)).toEqual([done])
    const logged = appendCompaction(test.db, { ...running(), state: ToolCallState.Done, summary: 'Carried on.' })
    expect(logged.summary).toBe('Carried on.')
    expect(listToolEvents(test.db, task.id)).toEqual([done, logged])

    expect(updateCompaction(test.db, { ...outcome, summary: '  \n ' }).summary).toBeNull()
    expect(updateCompaction(test.db, { ...outcome, summary: null }).summary).toBeNull()
    expect(appendCompaction(test.db, { ...running(), summary: '' }).summary).toBeNull()
    // Failing one leaves it none.
    expect(failRunningCompactions(test.db, task.id)).toMatchObject([{ summary: null }])
  })

  it('survives a relaunch with its summary', () => {
    const dir = mkdtempSync(join(tmpdir(), 'glade-repo-'))
    try {
      const first = openAppDatabase(dir).db
      const compacted = sampleTask(first, sampleWorkspace(first).id)
      const event = appendCompaction(first, { ...running(), taskId: compacted.id })
      updateCompaction(first, {
        id: event.id,
        state: ToolCallState.Done,
        preTokens: 1,
        postTokens: 1,
        summary: 'Kept.',
      })
      first.close()

      const second = openAppDatabase(dir).db
      expect(listToolEvents(second, compacted.id)).toMatchObject([{ summary: 'Kept.' }])
      second.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

describe('appendRefusalFallback and deleteToolEvent', () => {
  it('round-trips a refusal-fallback notice, with an open, nullable category', () => {
    const event = appendRefusalFallback(
      test.db,
      {
        taskId: task.id,
        turn: 2,
        originalModel: 'claude-opus-5-5',
        fallbackModel: 'claude-sonnet-5',
        category: 'cyber',
        scope: RefusalScope.Session,
      },
      3_000,
    )
    expect(event).toEqual({
      kind: ToolEventKind.RefusalFallback,
      id: UUID,
      taskId: task.id,
      turn: 2,
      createdAt: 3_000,
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5',
      category: 'cyber',
      scope: RefusalScope.Session,
      seq: expect.any(Number) as unknown,
    })
    expect(listToolEvents(test.db, task.id)).toEqual([event])

    const local = appendRefusalFallback(test.db, {
      taskId: task.id,
      turn: 2,
      originalModel: 'claude-opus-5-5',
      fallbackModel: 'claude-sonnet-5',
      category: null,
      scope: RefusalScope.Local,
    })
    expect(local).toMatchObject({ category: null, scope: RefusalScope.Local })
  })

  it('evicts a logged tool event, and is a no-op for one already gone or never logged', () => {
    const narration = appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Looking.' })
    const other = sampleTask(test.db, sampleWorkspace(test.db, '/code/other-repo').id)
    const elsewhere = appendNarration(test.db, { taskId: other.id, turn: 1, text: 'Elsewhere.' })

    expect(deleteToolEvent(test.db, task.id, narration.id)).toBe(true)
    expect(listToolEvents(test.db, task.id)).toEqual([])
    // Idempotent: evicting it again is a no-op.
    expect(deleteToolEvent(test.db, task.id, narration.id)).toBe(false)
    // Never logged.
    expect(deleteToolEvent(test.db, task.id, 'nope')).toBe(false)
    // Another task's row isn't touched by this task's eviction.
    expect(deleteToolEvent(test.db, task.id, elsewhere.id)).toBe(false)
    expect(listToolEvents(test.db, other.id)).toEqual([elsewhere])
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

describe('previousToolCall', () => {
  it('is the call the same agent made just before, whatever the others did in between', () => {
    appendToolCall(test.db, bashCall('toolu_1'), 3_000)
    const agent = appendToolCall(test.db, { ...bashCall('toolu_agent'), name: 'Agent', input: {} }, 3_100)
    const inside = appendToolCall(test.db, bashCall('toolu_sub_1', 'toolu_agent'), 3_200)
    appendNarration(test.db, { taskId: task.id, turn: 1, text: 'Next.' }, 3_250)
    appendToolCall(test.db, bashCall('toolu_2'), 3_300)
    appendToolCall(test.db, bashCall('toolu_sub_2', 'toolu_agent'), 3_400)
    appendToolCall(test.db, bashCall('toolu_other_sub', 'toolu_agent_2'), 3_500)

    // The agent's own call before `toolu_2` is the `Agent` call, not the subagent's command logged after it.
    expect(previousToolCall(test.db, task.id, 'toolu_2')).toEqual(agent)
    // And the subagent's before its second is its first, not the agent's call in between.
    expect(previousToolCall(test.db, task.id, 'toolu_sub_2')).toEqual(inside)
  })

  it('is undefined for an agent’s first call, a call that isn’t logged, and another task’s', () => {
    appendToolCall(test.db, bashCall('toolu_1'), 3_000)
    appendToolCall(test.db, bashCall('toolu_sub_1', 'toolu_agent'), 3_100)
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_theirs'), taskId: other.id }, 3_200)

    expect(previousToolCall(test.db, task.id, 'toolu_1')).toBeUndefined()
    expect(previousToolCall(test.db, task.id, 'toolu_sub_1')).toBeUndefined()
    expect(previousToolCall(test.db, task.id, 'toolu_missing')).toBeUndefined()
    expect(previousToolCall(test.db, other.id, 'toolu_theirs')).toBeUndefined()
    expect(previousToolCall(test.db, other.id, 'toolu_1')).toBeUndefined()
  })
})

describe('listSubagentCallsToPreload (#579)', () => {
  const agent = (toolUseId: string, taskId = task.id, parentToolUseId: string | null = null) => ({
    ...bashCall(toolUseId, parentToolUseId),
    taskId,
    name: 'Agent',
    input: { description: toolUseId },
  })
  /** Appends an `Agent` call and marks it Done at once, as a finished subagent left behind by a relaunch is. */
  const doneAgent = (toolUseId: string, at: number, parentToolUseId: string | null = null): ToolCallEvent => {
    appendToolCall(test.db, agent(toolUseId, task.id, parentToolUseId), at)
    return updateToolCall(test.db, { taskId: task.id, toolUseId, state: ToolCallState.Done, output: 'Done.' })
  }

  it("lists every task's running calls to the named tools, by task and in order, and nothing else", () => {
    const other = sampleTask(test.db, task.workspaceId)
    const first = appendToolCall(test.db, agent('toolu_1'), 3_000)
    appendToolCall(test.db, bashCall('toolu_2'), 3_100)
    appendToolCall(test.db, agent('toolu_3'), 3_200)
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_3', state: ToolCallState.Done, output: 'Done.' })
    const nested = appendToolCall(test.db, { ...agent('toolu_4'), parentToolUseId: 'toolu_1' }, 3_300)
    const elsewhere = appendToolCall(test.db, { ...agent('toolu_5', other.id), name: 'Task' }, 3_400)
    const own = [first, nested]
    const everyTask = task.id < other.id ? [...own, elsewhere] : [elsewhere, ...own]

    expect(listSubagentCallsToPreload(test.db, ['Agent', 'Task'])).toEqual(everyTask)
    expect(listSubagentCallsToPreload(test.db, ['Agent'])).toEqual(own)
    expect(listSubagentCallsToPreload(test.db, ['Grep'])).toEqual([])
    expect(listSubagentCallsToPreload(test.db, [])).toEqual([])
  })

  it('also lists a call whose own turn ended but that started a watcher still live, nested ones included', () => {
    const done = doneAgent('toolu_done', 3_000)
    const nested = doneAgent('toolu_nested', 3_100, 'toolu_done')
    // Ended with nothing left under it: not preloaded.
    doneAgent('toolu_quiet', 3_200)

    // A watcher on the nested call, two levels under the task's own agent.
    addWatcher(
      test.db,
      {
        taskId: task.id,
        kind: WatcherKind.Monitor,
        toolUseId: 'toolu_watch',
        parentToolUseId: 'toolu_nested',
        sdkId: 'b-toolu_watch',
        label: 'CI checks',
        detail: 'gh pr checks 42 --watch',
        cron: null,
        schedule: null,
        recurring: true,
        state: WatcherState.Running,
        nextDueAt: null,
        expiresAt: null,
      },
      3_300,
    )

    expect(listSubagentCallsToPreload(test.db, ['Agent'])).toEqual([nested])

    addWatcher(
      test.db,
      {
        taskId: task.id,
        kind: WatcherKind.Wakeup,
        toolUseId: 'toolu_wake',
        parentToolUseId: 'toolu_done',
        sdkId: 'b-toolu_wake',
        label: 'Check back',
        detail: 'Check back later.',
        cron: null,
        schedule: null,
        recurring: false,
        state: WatcherState.Scheduled,
        nextDueAt: 9_000,
        expiresAt: null,
      },
      3_400,
    )
    // A scheduled wakeup counts too, and the outer call joins once it has one of its own.
    expect(listSubagentCallsToPreload(test.db, ['Agent'])).toEqual([done, nested])
  })
})

describe('setAgentCallTokenTotals', () => {
  const totals = (toolUseId = 'toolu_agent') => ({
    taskId: task.id,
    toolUseId,
    totalInputTokens: 620,
    totalOutputTokens: 900,
  })

  it("writes an agent's totals onto the call that started it, and the row round-trips them", () => {
    const call = appendToolCall(test.db, { ...bashCall('toolu_agent'), name: 'mcp__glade-agents__dispatch' })

    expect(setAgentCallTokenTotals(test.db, totals())).toBe(true)
    expect(getToolCall(test.db, task.id, 'toolu_agent')).toEqual({
      ...call,
      totalInputTokens: 620,
      totalOutputTokens: 900,
    })
    expect(listToolEvents(test.db, task.id)).toEqual([{ ...call, totalInputTokens: 620, totalOutputTokens: 900 }])
  })

  it('writes on any tool call, by its id alone', () => {
    appendToolCall(test.db, bashCall('toolu_bash'))

    expect(setAgentCallTokenTotals(test.db, totals('toolu_bash'))).toBe(true)
    expect(getToolCall(test.db, task.id, 'toolu_bash')).toMatchObject({
      totalInputTokens: 620,
      totalOutputTokens: 900,
    })
  })

  it('keeps the totals of a call whose result later arrives, and leaves unwritten calls without them', () => {
    appendToolCall(test.db, { ...bashCall('toolu_agent'), name: 'mcp__glade-agents__dispatch' })
    setAgentCallTokenTotals(test.db, totals())
    const finished = updateToolCall(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_agent',
      state: ToolCallState.Done,
      output: 'Child done.',
    })
    expect(finished).toMatchObject({ totalInputTokens: 620, totalOutputTokens: 900 })

    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_other'), taskId: other.id })
    expect(setAgentCallTokenTotals(test.db, totals('toolu_other'))).toBe(false)
    expect(setAgentCallTokenTotals(test.db, totals('toolu_missing'))).toBe(false)
    expect(getToolCall(test.db, other.id, 'toolu_other')).not.toHaveProperty('totalInputTokens')
  })
})

describe('setAgentCallContextTokens', () => {
  const context = (toolUseId = 'toolu_agent') => ({ taskId: task.id, toolUseId, contextTokens: 478_200 })

  it("writes a subagent's context size onto its call whatever state it is in, and the row round-trips it", () => {
    const call = appendToolCall(test.db, { ...bashCall('toolu_agent'), name: 'Agent' })
    const finished = updateToolCall(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_agent',
      state: ToolCallState.Error,
      output: 'Stopped.',
    })

    expect(setAgentCallContextTokens(test.db, context())).toBe(true)
    expect(getToolCall(test.db, task.id, 'toolu_agent')).toEqual({ ...finished, contextTokens: 478_200 })
    expect(listToolEvents(test.db, task.id)).toEqual([{ ...finished, contextTokens: 478_200 }])
    expect(call).toBeDefined()
  })

  it('leaves the split a call already carries alone, and reads beside it', () => {
    appendToolCall(test.db, { ...bashCall('toolu_agent'), name: 'Agent' })
    setAgentCallTokenTotals(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_agent',
      totalInputTokens: 620,
      totalOutputTokens: 900,
    })

    expect(setAgentCallContextTokens(test.db, context())).toBe(true)
    expect(getToolCall(test.db, task.id, 'toolu_agent')).toMatchObject({
      totalInputTokens: 620,
      totalOutputTokens: 900,
      contextTokens: 478_200,
    })
  })

  it('only touches a subagent call, and only this task’s', () => {
    appendToolCall(test.db, bashCall('toolu_bash'))
    const other = sampleTask(test.db, task.workspaceId)
    appendToolCall(test.db, { ...bashCall('toolu_other'), taskId: other.id, name: 'Agent' })

    expect(setAgentCallContextTokens(test.db, context('toolu_bash'))).toBe(false)
    expect(setAgentCallContextTokens(test.db, context('toolu_other'))).toBe(false)
    expect(setAgentCallContextTokens(test.db, context('toolu_missing'))).toBe(false)
    expect(getToolCall(test.db, task.id, 'toolu_bash')).not.toHaveProperty('contextTokens')
    expect(getToolCall(test.db, other.id, 'toolu_other')).not.toHaveProperty('contextTokens')
  })
})

describe('reopenSubagentCall', () => {
  it('clears a finished run’s context size and split along with its outcome, for the new run (#592)', () => {
    const call = appendToolCall(test.db, { ...bashCall('toolu_agent'), name: 'Agent' })
    setSubagentProgress(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_agent',
      summary: 'Reading the API PRs',
      contextTokens: 13_530,
    })
    setAgentCallTokenTotals(test.db, {
      taskId: task.id,
      toolUseId: 'toolu_agent',
      totalInputTokens: 620,
      totalOutputTokens: 900,
    })
    updateToolCall(test.db, { taskId: task.id, toolUseId: 'toolu_agent', state: ToolCallState.Done, output: 'Done.' })

    expect(reopenSubagentCall(test.db, task.id, 'toolu_agent')).toEqual(call)
    expect(getToolCall(test.db, task.id, 'toolu_agent')).not.toHaveProperty('contextTokens')
    expect(getToolCall(test.db, task.id, 'toolu_agent')).not.toHaveProperty('totalInputTokens')
    expect(getToolCall(test.db, task.id, 'toolu_agent')).not.toHaveProperty('totalOutputTokens')
  })
})
