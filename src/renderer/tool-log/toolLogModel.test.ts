import { describe, expect, it } from 'vitest'
import {
  CompactionTrigger,
  DividerKind,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
  type DividerEvent,
  type NarrationEvent,
  type ToolCallEvent,
} from '../../shared/domain'
import { TaskIndicator } from '../../shared/taskIndicator'
import {
  argumentSummary,
  callIndicator,
  callStateLabel,
  compactionArgument,
  compactionResult,
  dividerLabel,
  dividerTime,
  lineCount,
  relativePath,
  resultSummary,
  toolCallCount,
  toolLogRows,
} from './toolLogModel'

const AT = new Date(2026, 8, 23, 11, 20).getTime()

function call(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: 'c1',
    taskId: 't1',
    turn: 1,
    createdAt: AT,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: {},
    output: null,
    state: ToolCallState.Done,
    toolUseId: 'use-1',
    parentToolUseId: null,
    ...overrides,
  }
}

function narration(id: string, turn: number, createdAt = AT): NarrationEvent {
  return { id, taskId: 't1', turn, createdAt, kind: ToolEventKind.Narration, text: `note ${id}` }
}

function divider(id: string, turn: number, dividerKind = DividerKind.Turn, createdAt = AT): DividerEvent {
  return { id, taskId: 't1', turn, createdAt, kind: ToolEventKind.Divider, dividerKind }
}

describe('argumentSummary', () => {
  it('shows the file for file tools, relative to the workspace root', () => {
    const root = '/Users/sample/code/api'
    expect(argumentSummary(call({ name: 'Read', input: { file_path: `${root}/api/views.py` } }), root)).toBe(
      'api/views.py',
    )
    expect(argumentSummary(call({ name: 'Write', input: { file_path: '/elsewhere/a.py' } }), root)).toBe(
      '/elsewhere/a.py',
    )
    expect(argumentSummary(call({ name: 'Edit', input: { file_path: 'api/views.py' } }))).toBe('api/views.py')
    expect(argumentSummary(call({ name: 'NotebookEdit', input: { notebook_path: 'a.ipynb' } }))).toBe('a.ipynb')
  })

  it('shows the pattern for Grep, the first line of the command for Bash, and so on', () => {
    expect(argumentSummary(call({ name: 'Grep', input: { pattern: 'throttle', path: 'api' } }))).toBe('throttle')
    expect(argumentSummary(call({ name: 'Bash', input: { command: '\npytest api/tests -q\necho done' } }))).toBe(
      'pytest api/tests -q',
    )
    expect(argumentSummary(call({ name: 'Agent', input: { prompt: 'Long…', description: 'Find it' } }))).toBe('Find it')
  })

  it('shows an MCP tool’s input as short JSON', () => {
    expect(argumentSummary(call({ name: 'mcp__glade__set_status', input: { status: 'Testing' } }))).toBe(
      '{"status":"Testing"}',
    )
    expect(argumentSummary(call({ name: 'mcp__github__list', input: {} }))).toBe('')
    const long = argumentSummary(call({ name: 'mcp__x__y', input: { text: 'a'.repeat(300) } }))
    expect(long).toHaveLength(201)
    expect(long.endsWith('…')).toBe(true)
  })

  it('falls back to the first string input, then to short JSON', () => {
    expect(argumentSummary(call({ name: 'WebFetch', input: { prompt: 'Summarise' } }))).toBe('Summarise')
    expect(argumentSummary(call({ name: 'Read', input: { offset: 3 } }))).toBe('{"offset":3}')
    expect(argumentSummary(call({ name: 'TodoWrite', input: { todos: [] } }))).toBe('{"todos":[]}')
    expect(argumentSummary(call({ name: 'ExitPlanMode', input: {} }))).toBe('')
  })
})

describe('relativePath', () => {
  it('strips the workspace root, with or without its trailing slash', () => {
    expect(relativePath('/code/api/a.py', '/code/api/')).toBe('a.py')
    expect(relativePath('/code/api-v2/a.py', '/code/api')).toBe('/code/api-v2/a.py')
    expect(relativePath('/code/api/a.py', undefined)).toBe('/code/api/a.py')
  })
})

describe('lineCount', () => {
  it('counts lines, not a trailing newline', () => {
    expect(lineCount('')).toBe(0)
    expect(lineCount('a')).toBe(1)
    expect(lineCount('a\nb\n')).toBe(2)
  })
})

describe('resultSummary', () => {
  it('says a running call is running', () => {
    expect(resultSummary(call({ state: ToolCallState.Running }))).toBe('Running…')
  })

  it('says a call a pause or a quit cut off was paused or interrupted, whatever its output', () => {
    const note = 'Glade quit before this tool call finished.'
    expect(resultSummary(call({ name: 'Bash', state: ToolCallState.Paused, output: note }))).toBe('Paused')
    expect(resultSummary(call({ name: 'Bash', state: ToolCallState.Interrupted, output: note }))).toBe('Interrupted')
  })

  it('shows the first line of a failed call’s error', () => {
    expect(resultSummary(call({ state: ToolCallState.Error, output: '\nFile not found\nat …' }))).toBe('File not found')
    expect(resultSummary(call({ state: ToolCallState.Error, output: null }))).toBe('Failed')
  })

  it('counts the lines Read returned and Write wrote', () => {
    expect(resultSummary(call({ name: 'Read', output: '1\ta\n2\tb\n3\tc' }))).toBe('3 lines')
    expect(resultSummary(call({ name: 'Read', output: '1\ta' }))).toBe('1 line')
    expect(resultSummary(call({ name: 'Write', input: { content: 'a\nb\n' }, output: 'File created' }))).toBe('2 lines')
    expect(resultSummary(call({ name: 'Write', input: {}, output: 'File created' }))).toBe('File created')
  })

  it('shows the lines an Edit added and removed', () => {
    const edit = call({ name: 'Edit', input: { old_string: 'a', new_string: 'a\nb\nc' }, output: 'Updated.' })
    expect(resultSummary(edit)).toBe('+3 −1')
    expect(resultSummary(call({ name: 'Edit', input: {}, output: 'Updated.' }))).toBe('Updated.')
  })

  it('shows the last line of Bash’s output, where a test run puts its summary', () => {
    expect(resultSummary(call({ name: 'Bash', output: '....  [100%]\n14 passed in 3.2s\n' }))).toBe('14 passed in 3.2s')
    expect(resultSummary(call({ name: 'Bash', output: '' }))).toBe('Done')
  })

  it('shows the first line of any other tool’s output', () => {
    expect(resultSummary(call({ name: 'Grep', output: 'No matches found' }))).toBe('No matches found')
    expect(resultSummary(call({ name: 'Glob', output: null }))).toBe('Done')
  })
})

describe('call state', () => {
  it('colours running blue, done slate and error pink, and names each', () => {
    expect(callIndicator(ToolCallState.Running)).toBe(TaskIndicator.Working)
    expect(callIndicator(ToolCallState.Done)).toBe(TaskIndicator.Done)
    expect(callIndicator(ToolCallState.Error)).toBe(TaskIndicator.Error)
    expect(callStateLabel(ToolCallState.Running)).toBe('Running')
    expect(callStateLabel(ToolCallState.Done)).toBe('Done')
    expect(callStateLabel(ToolCallState.Error)).toBe('Failed')
  })

  it('colours a paused call purple and an interrupted one slate, since neither failed', () => {
    expect(callIndicator(ToolCallState.Paused)).toBe(TaskIndicator.Waiting)
    expect(callIndicator(ToolCallState.Interrupted)).toBe(TaskIndicator.Done)
    expect(callStateLabel(ToolCallState.Paused)).toBe('Paused')
    expect(callStateLabel(ToolCallState.Interrupted)).toBe('Interrupted')
  })
})

describe('dividers', () => {
  it('label each kind', () => {
    expect(dividerLabel({ dividerKind: DividerKind.Turn, turn: 2 })).toBe('turn 2')
    expect(dividerLabel({ dividerKind: DividerKind.MarkedDone, turn: 2 })).toBe('marked done')
    expect(dividerLabel({ dividerKind: DividerKind.Reopened, turn: 2 })).toBe('reopened')
    expect(dividerLabel({ dividerKind: DividerKind.Resumed, turn: 2 })).toBe('resumed after restart')
  })

  it('show the date too when the day changed since the entry before', () => {
    const nextDay = new Date(2026, 8, 25, 9, 14).getTime()
    expect(dividerTime(AT, undefined)).toBe('11:20')
    expect(dividerTime(AT + 60_000, AT)).toBe('11:21')
    expect(dividerTime(nextDay, AT)).toBe('Sep 25, 09:14')
  })
})

describe('toolLogRows', () => {
  it('keeps the log’s order, leaving out turn 1’s divider', () => {
    const nextDay = new Date(2026, 8, 25, 9, 14).getTime()
    const rows = toolLogRows([
      divider('d1', 1),
      narration('n1', 1),
      call({ id: 'c1', toolUseId: 'use-1', name: 'mcp__glade__set_title' }),
      divider('d2', 2),
      divider('d3', 2, DividerKind.MarkedDone),
      divider('d4', 3, DividerKind.Reopened, nextDay),
    ])

    expect(rows.map((row) => row.kind)).toEqual([
      ToolEventKind.Narration,
      ToolEventKind.ToolCall,
      ToolEventKind.Divider,
      ToolEventKind.Divider,
      ToolEventKind.Divider,
    ])
    expect(rows[1]).toMatchObject({ name: 'set_title', children: [] })
    expect(rows.slice(2).map((row) => (row.kind === ToolEventKind.Divider ? row.label : ''))).toEqual([
      'turn 2 · 11:20',
      'marked done · 11:20',
      'reopened · Sep 25, 09:14',
    ])
  })

  it('nests a subagent’s calls under the call that started it, and keeps orphans at the top level', () => {
    const rows = toolLogRows([
      call({ id: 'agent', name: 'Agent', toolUseId: 'use-agent' }),
      call({ id: 'grep', name: 'Grep', toolUseId: 'use-grep', parentToolUseId: 'use-agent' }),
      narration('n1', 1),
      call({ id: 'read', name: 'Read', toolUseId: 'use-read', parentToolUseId: 'use-agent' }),
      call({ id: 'orphan', name: 'Bash', toolUseId: 'use-orphan', parentToolUseId: 'use-gone' }),
    ])

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({
      name: 'Agent',
      children: [{ name: 'Grep', children: [] }, { name: 'Read' }],
    })
    expect(rows[2]).toMatchObject({ name: 'Bash', children: [] })
  })
})

describe('compactions', () => {
  const compaction = (change: Partial<CompactionEvent> = {}): CompactionEvent => ({
    id: 'k1',
    taskId: 't1',
    turn: 1,
    createdAt: AT,
    kind: ToolEventKind.Compaction,
    trigger: CompactionTrigger.Manual,
    state: ToolCallState.Done,
    preTokens: 198_000,
    postTokens: 41_000,
    windowTokens: 200_000,
    ...change,
  })

  it('sit in the log as rows of their own, and count as no tool call', () => {
    const rows = toolLogRows([narration('n1', 1), compaction()])
    expect(rows[1]).toEqual({ kind: ToolEventKind.Compaction, compaction: compaction() })
    expect(toolCallCount([compaction()])).toBe(0)
  })

  it('show the tokens before and after once done', () => {
    expect(compactionArgument(compaction())).toBe('198k → 41k tokens')
    expect(compactionArgument(compaction({ postTokens: null }))).toBe('from 198k tokens')
    expect(compactionArgument(compaction({ state: ToolCallState.Running, preTokens: null }))).toBe('')
    expect(compactionArgument(compaction({ state: ToolCallState.Error }))).toBe('')
  })

  it('say whether they are compacting, finished or never did', () => {
    expect(compactionResult(compaction({ state: ToolCallState.Running }))).toBe('Compacting…')
    expect(compactionResult(compaction({ state: ToolCallState.Error }))).toBe("Didn't finish")
    expect(compactionResult(compaction({ state: ToolCallState.Paused }))).toBe("Didn't finish")
    expect(compactionResult(compaction({ state: ToolCallState.Interrupted }))).toBe("Didn't finish")
    expect(compactionResult(compaction())).toBe('Resuming from a summary')
    expect(compactionResult(compaction({ trigger: CompactionTrigger.Auto }))).toBe(
      'Automatic · resuming from a summary',
    )
  })
})

describe('toolCallCount', () => {
  it('counts every tool call, subagents’ included', () => {
    expect(
      toolCallCount([
        narration('n1', 1),
        call({ id: 'a', toolUseId: 'a' }),
        call({ id: 'b', toolUseId: 'b', parentToolUseId: 'a' }),
        divider('d', 2),
      ]),
    ).toBe(2)
  })
})
