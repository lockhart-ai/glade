import { describe, expect, it } from 'vitest'
import {
  CompactionTrigger,
  DividerKind,
  RefusalScope,
  ToolCallState,
  ToolEventKind,
  type CompactionEvent,
  type DividerEvent,
  type NarrationEvent,
  type RefusalFallbackEvent,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
  WatcherState,
} from '../../shared/domain'
import { sampleWatcher } from '../store/test-bridge'
import { TaskIndicator } from '../../shared/taskIndicator'
import { PermissionLineScope, PermissionLineState, type PermissionLine } from '../permissions/permissionLineModel'
import {
  AgentLogRowKind,
  agentLogRows,
  argumentSummary,
  awaitsPermission,
  callIndicator,
  callStateLabel,
  compactionArgument,
  compactionResult,
  dividerLabel,
  dividerTime,
  isParentEvent,
  lineCount,
  parentLogRows,
  relativePath,
  resultSummary,
  rowEvent,
  rowIndicator,
  rowStateLabel,
  sameSubagentRow,
  sameSubagentRows,
  showsCallState,
  showsResult,
  withdrawnUnrun,
  toolLogRows,
  type AgentLogRow,
  type CallRow,
  type LogWatchers,
  type ToolLogRow,
} from './toolLogModel'
import { setHomeFolder } from '../../shared/homeFolder'

// The sample data's home folder, which paths under it are shown from as `~`.
setHomeFolder('/Users/sample')

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
    finishedAt: null,
    toolUseId: 'use-1',
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

function narration(id: string, turn: number, createdAt = AT): NarrationEvent {
  return { id, taskId: 't1', turn, createdAt, kind: ToolEventKind.Narration, text: `note ${id}`, parentToolUseId: null }
}

function divider(id: string, turn: number, dividerKind = DividerKind.Turn, createdAt = AT): DividerEvent {
  return { id, taskId: 't1', turn, createdAt, kind: ToolEventKind.Divider, dividerKind }
}

function refusalFallback(id: string, turn: number): RefusalFallbackEvent {
  return {
    id,
    taskId: 't1',
    turn,
    createdAt: AT,
    kind: ToolEventKind.RefusalFallback,
    originalModel: 'claude-opus-5-5',
    fallbackModel: 'claude-sonnet-5',
    category: 'cyber',
    scope: RefusalScope.Session,
  }
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

  it('shows a file outside the root from ~ when it’s under the home folder, as the sandbox’s cards name folders', () => {
    const root = '/Users/sample/code/api'
    const shared = '/Users/sample/code/acme-shared/openapi/common.yaml'
    expect(argumentSummary(call({ name: 'Read', input: { file_path: shared } }), root)).toBe(
      '~/code/acme-shared/openapi/common.yaml',
    )
    expect(argumentSummary(call({ name: 'Read', input: { file_path: shared } }))).toBe(
      '~/code/acme-shared/openapi/common.yaml',
    )
    expect(argumentSummary(call({ name: 'Read', input: { file_path: '/Users/Shared/notes.md' } }), root)).toBe(
      '/Users/Shared/notes.md',
    )
  })

  it('shows the path a request_access call asks for, not its input', () => {
    const input = { path: '/Users/sample/.cache/uv', access: 'write', reason: 'uv needs its cache.' }
    expect(argumentSummary(call({ name: 'mcp__glade__request_access', input }))).toBe('~/.cache/uv')
    // Without a path, it's an MCP tool's input like any other.
    expect(argumentSummary(call({ name: 'mcp__glade__request_access', input: { access: 'read' } }))).toBe(
      '{"access":"read"}',
    )
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

  it('nests a subagent’s calls and notes under the call that started it, and keeps orphans at the top level', () => {
    const rows = toolLogRows([
      call({ id: 'agent', name: 'Agent', toolUseId: 'use-agent' }),
      call({ id: 'grep', name: 'Grep', toolUseId: 'use-grep', parentToolUseId: 'use-agent' }),
      narration('n1', 1),
      { ...narration('n2', 1), parentToolUseId: 'use-agent' },
      call({ id: 'read', name: 'Read', toolUseId: 'use-read', parentToolUseId: 'use-agent' }),
      call({ id: 'orphan', name: 'Bash', toolUseId: 'use-orphan', parentToolUseId: 'use-gone' }),
      { ...narration('n3', 1), parentToolUseId: 'use-gone' },
    ])

    expect(rows).toHaveLength(4)
    expect(rows[0]).toMatchObject({
      name: 'Agent',
      children: [
        { name: 'Grep', children: [] },
        { kind: ToolEventKind.Narration, narration: { id: 'n2' } },
        { name: 'Read' },
      ],
    })
    expect(rows[1]).toMatchObject({ kind: ToolEventKind.Narration, narration: { id: 'n1' } })
    expect(rows[2]).toMatchObject({ name: 'Bash', children: [] })
    expect(rows[3]).toMatchObject({ kind: ToolEventKind.Narration, narration: { id: 'n3' } })
  })

  it('leaves out a refusal-fallback notice: the chat shows it, not the tool log', () => {
    const rows = toolLogRows([narration('n1', 1), refusalFallback('r1', 1)])
    expect(rows).toEqual([{ kind: ToolEventKind.Narration, narration: narration('n1', 1) }])
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
    summary: null,
    ...change,
  })

  it('sit in the log as rows of their own', () => {
    const rows = toolLogRows([narration('n1', 1), compaction()])
    expect(rows[1]).toEqual({ kind: ToolEventKind.Compaction, compaction: compaction() })
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

describe('the parent’s tool log', () => {
  it('tells the task’s own events from its subagents’', () => {
    expect(isParentEvent(call())).toBe(true)
    expect(isParentEvent(call({ parentToolUseId: 'use-agent' }))).toBe(false)
    expect(isParentEvent(narration('n1', 1))).toBe(true)
    expect(isParentEvent({ ...narration('n1', 1), parentToolUseId: 'use-agent' })).toBe(false)
    expect(isParentEvent(divider('d', 2))).toBe(true)
    expect(isParentEvent(refusalFallback('r1', 1))).toBe(true)
  })

  it('keeps an Agent call as one row, with none of its subagent’s calls or notes under it or beside it', () => {
    const rows = parentLogRows([
      call({ id: 'agent', name: 'Agent', toolUseId: 'use-agent', state: ToolCallState.Running }),
      call({ id: 'grep', name: 'Grep', toolUseId: 'use-grep', parentToolUseId: 'use-agent' }),
      { ...narration('n1', 1), parentToolUseId: 'use-agent' },
      call({ id: 'read', name: 'Read', toolUseId: 'use-read' }),
    ])

    expect(rows).toEqual([
      expect.objectContaining({ name: 'Agent', children: [] }),
      expect.objectContaining({ name: 'Read', children: [] }),
    ])
  })

  it('leaves out nested subagents, interleaved subagents, failed calls and orphans, and keeps the rest in order', () => {
    const rows = parentLogRows([
      call({ id: 'outer', name: 'Agent', toolUseId: 'use-outer' }),
      call({ id: 'other', name: 'Agent', toolUseId: 'use-other' }),
      call({ id: 'o1', name: 'Grep', toolUseId: 'use-o1', parentToolUseId: 'use-outer' }),
      call({ id: 'x1', name: 'Bash', toolUseId: 'use-x1', parentToolUseId: 'use-other', state: ToolCallState.Error }),
      call({ id: 'inner', name: 'Agent', toolUseId: 'use-inner', parentToolUseId: 'use-outer' }),
      call({ id: 'i1', name: 'Read', toolUseId: 'use-i1', parentToolUseId: 'use-inner' }),
      narration('n1', 1),
      call({ id: 'x2', name: 'Read', toolUseId: 'use-x2', parentToolUseId: 'use-other' }),
      divider('d2', 2),
      call({ id: 'orphan', name: 'Bash', toolUseId: 'use-orphan', parentToolUseId: 'use-gone' }),
      call({ id: 'own', name: 'Edit', toolUseId: 'use-own', turn: 2 }),
    ])

    expect(
      rows.map((row) => {
        switch (row.kind) {
          case ToolEventKind.ToolCall:
            return `${row.call.id} (${String(row.children.length)})`
          case ToolEventKind.Narration:
            return row.narration.id
          case ToolEventKind.Divider:
            return row.label
          case ToolEventKind.Compaction:
            return 'compaction'
        }
      }),
    ).toEqual(['outer (0)', 'other (0)', 'n1', 'turn 2 · 11:20', 'own (0)'])
  })
})

describe('permission lines', () => {
  const WAITING: PermissionLine = { state: PermissionLineState.Waiting, subject: null }
  const ONCE: PermissionLine = { state: PermissionLineState.Allowed, scope: PermissionLineScope.Once, subject: null }
  const DENIED: PermissionLine = { state: PermissionLineState.Denied, subject: null, note: 'Not yet' }
  const WITHDRAWN: PermissionLine = { state: PermissionLineState.Withdrawn, subject: null }
  const BLOCKED: PermissionLine = { state: PermissionLineState.Blocked, subject: 'write to ~/.cache/uv' }

  function onlyCall(rows: readonly ToolLogRow[], index = 0): CallRow {
    const row = rows[index]
    if (row?.kind !== ToolEventKind.ToolCall) throw new Error(`Row ${String(index)} is no call`)
    return row
  }

  it('go on the row of the call they name by its tool_use id, a subagent’s nested call included', () => {
    const events = [
      call({ id: 'bash', name: 'Bash', toolUseId: 'use-bash' }),
      call({ id: 'agent', name: 'Agent', toolUseId: 'use-agent' }),
      call({ id: 'write', name: 'Write', toolUseId: 'use-write', parentToolUseId: 'use-agent' }),
      call({ id: 'read', name: 'Read', toolUseId: 'use-read' }),
    ]
    const lines = new Map<string, PermissionLine>([
      ['use-bash', ONCE],
      ['use-write', DENIED],
      ['use-nothing', WAITING],
    ])

    const rows = toolLogRows(events, lines)

    expect(onlyCall(rows, 0).permission).toBe(ONCE)
    expect(onlyCall(rows, 1).permission).toBeNull()
    expect(onlyCall(rows, 1).children).toMatchObject([{ name: 'Write', permission: DENIED }])
    expect(onlyCall(rows, 2).permission).toBeNull()
    // The parent's log has the same lines, and none of the subagent's rows.
    expect(parentLogRows(events, lines)).toMatchObject([
      { name: 'Bash', permission: ONCE },
      { name: 'Agent', permission: null, children: [] },
      { name: 'Read', permission: null },
    ])
  })

  it('leave every row without one when there are none', () => {
    const events = [call({ id: 'bash', name: 'Bash', toolUseId: 'use-bash' })]

    expect(onlyCall(toolLogRows(events)).permission).toBeNull()
    expect(onlyCall(parentLogRows(events)).permission).toBeNull()
  })

  it('make a row differ from itself only when its own line changes, however the lines were made', () => {
    const events = [
      call({ id: 'agent', name: 'Agent', toolUseId: 'use-agent' }),
      call({ id: 'write', name: 'Write', toolUseId: 'use-write', parentToolUseId: 'use-agent' }),
      call({ id: 'bash', name: 'Bash', toolUseId: 'use-bash' }),
    ]
    const rowsWith = (...entries: [string, PermissionLine][]): CallRow[] =>
      toolLogRows(events, new Map(entries)).flatMap((row) => (row.kind === ToolEventKind.ToolCall ? [row] : []))
    const [agent, bash] = rowsWith(['use-bash', WAITING])
    if (agent === undefined || bash === undefined) throw new Error('Rows missing')

    // The same lines, made anew: every row is the same.
    const [sameAgent, sameBash] = rowsWith(['use-bash', { ...WAITING }])
    expect(sameSubagentRow(agent, sameAgent ?? bash)).toBe(true)
    expect(sameSubagentRow(bash, sameBash ?? agent)).toBe(true)

    // Bash's request answered: its row differs, the Agent row doesn't.
    const [agentAfter, bashAfter] = rowsWith(['use-bash', ONCE])
    expect(sameSubagentRow(agent, agentAfter ?? bash)).toBe(true)
    expect(sameSubagentRow(bash, bashAfter ?? bash)).toBe(false)

    // A line for the subagent's nested call: the Agent row holding it differs, Bash's doesn't.
    const [agentNested, bashNested] = rowsWith(['use-bash', WAITING], ['use-write', WAITING])
    expect(sameSubagentRow(agent, agentNested ?? agent)).toBe(false)
    expect(sameSubagentRow(bash, bashNested ?? agent)).toBe(true)
    expect(sameSubagentRows(agent.children, agentNested?.children ?? [])).toBe(false)
  })

  it('show a running call that waits on its card as waiting on you; a call that ended keeps its own dot', () => {
    const running = call({ state: ToolCallState.Running })
    const waiting = { call: running, permission: WAITING }
    expect(awaitsPermission(waiting)).toBe(true)
    expect(rowIndicator(waiting)).toBe(TaskIndicator.Waiting)
    expect(rowStateLabel(waiting)).toBe('Waiting')
    expect(showsCallState(waiting)).toBe(false)

    // With no card open, a running call is a running call.
    for (const permission of [null, ONCE]) {
      const row = { call: running, permission }
      expect(awaitsPermission(row)).toBe(false)
      expect(rowIndicator(row)).toBe(TaskIndicator.Working)
      expect(rowStateLabel(row)).toBe('Running')
      expect(showsCallState(row)).toBe(true)
    }

    // The app quit on it: interrupted, though its card is still open.
    const quit = { call: call({ state: ToolCallState.Interrupted }), permission: WAITING }
    expect(awaitsPermission(quit)).toBe(false)
    expect(rowIndicator(quit)).toBe(TaskIndicator.Done)
    expect(rowStateLabel(quit)).toBe('Interrupted')
    expect(showsCallState(quit)).toBe(true)
  })

  it('show a call that never ran, its request withdrawn, in slate rather than as failed; a denied one did fail', () => {
    const stopped = call({ state: ToolCallState.Error, output: 'You stopped the agent.' })
    const withdrawn = { call: stopped, permission: WITHDRAWN }
    expect(withdrawnUnrun(withdrawn)).toBe(true)
    expect(rowIndicator(withdrawn)).toBe(TaskIndicator.Done)
    expect(rowStateLabel(withdrawn)).toBe('Withdrawn')
    expect(showsCallState(withdrawn)).toBe(false)

    const denied = { call: stopped, permission: DENIED }
    expect(withdrawnUnrun(denied)).toBe(false)
    expect(rowIndicator(denied)).toBe(TaskIndicator.Error)
    expect(rowStateLabel(denied)).toBe('Failed')
    expect(showsCallState(denied)).toBe(true)

    // A failed call no permission was involved in is a failed call, and a withdrawn request's call that the app quit
    // on, or that still runs, keeps its own state.
    expect(withdrawnUnrun({ call: stopped, permission: null })).toBe(false)
    const interrupted = { call: call({ state: ToolCallState.Interrupted }), permission: WITHDRAWN }
    expect(withdrawnUnrun(interrupted)).toBe(false)
    expect(rowStateLabel(interrupted)).toBe('Interrupted')
    const stillRunning = { call: call({ state: ToolCallState.Running }), permission: WITHDRAWN }
    expect(rowIndicator(stillRunning)).toBe(TaskIndicator.Working)
  })

  it('show a result only for a call that ran: not while it waits, nor once denied or withdrawn', () => {
    expect(showsResult({ permission: null })).toBe(true)
    expect(showsResult({ permission: ONCE })).toBe(true)
    expect(showsResult({ permission: BLOCKED })).toBe(true)
    expect(showsResult({ permission: WAITING })).toBe(false)
    expect(showsResult({ permission: DENIED })).toBe(false)
    expect(showsResult({ permission: WITHDRAWN })).toBe(false)
  })
})

describe('an agent’s list with its watchers (#537)', () => {
  const MINUTE = 60_000
  const minute = (minutes: number): number => AT + minutes * MINUTE

  function ended(id: string, endedAt: number | null, overrides: Partial<Watcher> = {}): Watcher {
    return sampleWatcher(id, 't1', { state: WatcherState.Finished, startedAt: AT, endedAt, ...overrides })
  }

  function watchers(list: readonly Watcher[], live: readonly string[] = []): LogWatchers {
    return { ended: list, startedBy: new Set([...list.map(({ toolUseId }) => toolUseId), ...live]) }
  }

  /** Each row as a word: a call's `tool_use` id, a note's or a divider's id, or a watcher's id after an eye. */
  function names(rows: readonly AgentLogRow[]): string[] {
    return rows.map((row) => {
      if (row.kind === AgentLogRowKind.Watcher) return `watcher ${row.watcher.id}`
      return row.kind === ToolEventKind.ToolCall ? row.call.toolUseId : rowEvent(row).id
    })
  }

  const events: ToolEvent[] = [
    narration('n1', 1, minute(0)),
    call({ id: 'c-monitor', name: 'Monitor', toolUseId: 'toolu-ci', createdAt: minute(1) }),
    call({ id: 'c-read', toolUseId: 'read', createdAt: minute(2) }),
    divider('d2', 2, DividerKind.Turn, minute(8)),
    narration('n2', 2, minute(8)),
    call({ id: 'c-agent', name: 'Agent', toolUseId: 'fixer', createdAt: minute(9) }),
    call({ id: 'c-inner', toolUseId: 'inner', parentToolUseId: 'fixer', createdAt: minute(10) }),
    call({ id: 'c-lint', name: 'Bash', toolUseId: 'toolu-lint', parentToolUseId: 'fixer', createdAt: minute(11) }),
  ]

  it('is the tool log’s rows with no watchers', () => {
    expect(agentLogRows(events, null)).toEqual(toolLogRows(events.filter(isParentEvent)))
    expect(names(agentLogRows(events, null, undefined, watchers([])))).toEqual([
      'n1',
      'toolu-ci',
      'read',
      'd2',
      'n2',
      'fixer',
    ])
  })

  it('leaves out the call that started a watcher while it’s live', () => {
    expect(names(agentLogRows(events, null, undefined, watchers([], ['toolu-ci'])))).toEqual([
      'n1',
      'read',
      'd2',
      'n2',
      'fixer',
    ])
  })

  it('puts an ended watcher at the time it ended, with what the agent did next after it', () => {
    const ci = ended('ci', minute(7))
    const rows = agentLogRows(events, null, undefined, watchers([ci]))

    expect(names(rows)).toEqual(['n1', 'read', 'watcher ci', 'd2', 'n2', 'fixer'])
    expect(rows[2]).toEqual({ kind: AgentLogRowKind.Watcher, watcher: ci })
  })

  it('puts one that ended at the very time of an event before it: a wake ends it, then starts the turn', () => {
    expect(names(agentLogRows(events, null, undefined, watchers([ended('ci', minute(8))])))).toEqual([
      'n1',
      'read',
      'watcher ci',
      'd2',
      'n2',
      'fixer',
    ])
  })

  it('puts one that ended after everything last, and one that ended before everything first', () => {
    const late = ended('late', minute(30))
    const early = ended('early', minute(-5), { toolUseId: 'toolu-early' })
    expect(names(agentLogRows(events, null, undefined, watchers([early, ended('ci', minute(7)), late])))).toEqual([
      'watcher early',
      'n1',
      'read',
      'watcher ci',
      'd2',
      'n2',
      'fixer',
      'watcher late',
    ])
  })

  it('keeps several that ended between the same two events in the order they ended', () => {
    const list = [1, 2, 3, 4, 5].map((n) => ended(`w${String(n)}`, minute(2) + n * 1000))
    expect(names(agentLogRows(events, null, undefined, watchers(list)))).toEqual([
      'n1',
      'toolu-ci',
      'read',
      'watcher w1',
      'watcher w2',
      'watcher w3',
      'watcher w4',
      'watcher w5',
      'd2',
      'n2',
      'fixer',
    ])
  })

  it('counts one whose end wasn’t recorded as ending when it started', () => {
    const lost = ended('lost', null, { state: WatcherState.Stopped, startedAt: minute(1) })
    expect(names(agentLogRows(events, null, undefined, watchers([lost], ['toolu-ci'])))).toEqual([
      'n1',
      'watcher lost',
      'read',
      'd2',
      'n2',
      'fixer',
    ])
  })

  it('is the whole list for an agent with watchers and no calls left', () => {
    const only = [call({ id: 'c-monitor', name: 'Monitor', toolUseId: 'toolu-ci' })]
    expect(names(agentLogRows(only, null, undefined, watchers([ended('ci', minute(7))])))).toEqual(['watcher ci'])
    expect(agentLogRows(only, null, undefined, watchers([], ['toolu-ci']))).toEqual([])
  })

  it('shows a subagent’s own on its list: its calls, without the one that started its watcher', () => {
    const lint = ended('lint', minute(12), { toolUseId: 'toolu-lint', parentToolUseId: 'fixer' })
    expect(names(agentLogRows(events, 'fixer', undefined, watchers([lint])))).toEqual(['inner', 'watcher lint'])
    // Main's list doesn't hide a call for a watcher that isn't its own.
    expect(names(agentLogRows(events, 'fixer', undefined, watchers([])))).toEqual(['inner', 'toolu-lint'])
  })

  it('names the event each of the tool log’s rows shows', () => {
    const compaction: CompactionEvent = {
      id: 'k1',
      taskId: 't1',
      turn: 2,
      createdAt: minute(9),
      kind: ToolEventKind.Compaction,
      state: ToolCallState.Done,
      trigger: CompactionTrigger.Auto,
      preTokens: 1000,
      postTokens: 100,
      windowTokens: 200_000,
      summary: null,
    }
    expect(toolLogRows([...events, compaction]).map((row) => rowEvent(row).id)).toEqual([
      'n1',
      'c-monitor',
      'c-read',
      'd2',
      'n2',
      'c-agent',
      'k1',
    ])
  })
})
