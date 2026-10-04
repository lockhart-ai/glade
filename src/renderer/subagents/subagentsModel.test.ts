import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import {
  deriveSubagents,
  elapsedMs,
  formatElapsed,
  runningSubagentCount,
  runningSubagentCounts,
  statusLabel,
  subagentLogText,
  subagentName,
  subagentsRunningLabel,
  SubagentStatus,
  UNNAMED_SUBAGENT,
} from './subagentsModel'

const AT = 1_000_000

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
    state: ToolCallState.Running,
    finishedAt: null,
    toolUseId: 'use-1',
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

/** An `Agent` call starting a subagent with this id and description. */
function agent(id: string, description: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return call({ id, name: 'Agent', toolUseId: `use-${id}`, input: { description, prompt: '…' }, ...overrides })
}

function said(id: string, text: string, parent: string | null, createdAt = AT): NarrationEvent {
  return { id, taskId: 't1', turn: 1, createdAt, kind: ToolEventKind.Narration, text, parentToolUseId: parent }
}

describe('subagentName', () => {
  it('is the description, else the subagent type, else a plain name', () => {
    expect(subagentName(agent('a', 'API changes'))).toBe('API changes')
    expect(subagentName(call({ name: 'Agent', input: { description: ' ', subagent_type: 'Explore' } }))).toBe('Explore')
    expect(subagentName(call({ name: 'Task', input: { prompt: 'Look around.' } }))).toBe(UNNAMED_SUBAGENT)
  })
})

describe('deriveSubagents', () => {
  it('makes a subagent of each Agent or Task call, with what its subagent did nested under it', () => {
    const events: ToolEvent[] = [
      { id: 'd', taskId: 't1', turn: 1, createdAt: AT, kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn },
      said('top', 'Splitting the work.', null),
      call({ id: 'top-read', toolUseId: 'use-top-read', state: ToolCallState.Done, output: 'x' }),
      agent('api', 'API changes'),
      call({ id: 'task', name: 'Task', toolUseId: 'use-task', input: { subagent_type: 'Explore' } }),
      said('api-note', 'Reading the API PRs, newest first.', 'use-api'),
      call({ id: 'api-bash', name: 'Bash', toolUseId: 'use-api-bash', parentToolUseId: 'use-api' }),
      call({ id: 'task-grep', name: 'Grep', toolUseId: 'use-task-grep', parentToolUseId: 'use-task' }),
    ]

    const subagents = deriveSubagents(events)

    expect(subagents.map(({ name }) => name)).toEqual(['API changes', 'Explore'])
    expect(subagents[0]?.log.map((row) => row.kind)).toEqual([ToolEventKind.Narration, ToolEventKind.ToolCall])
    expect(subagents[0]?.call.id).toBe('api')
  })

  it('lists running subagents first, then done, then failed, each in the order they started', () => {
    const subagents = deriveSubagents([
      agent('links', 'Check links', { state: ToolCallState.Done, output: 'Fixed both.' }),
      agent('api', 'API changes'),
      agent('admin', 'Admin changes', { state: ToolCallState.Error, output: 'Stopped.' }),
      agent('dashboard', 'Dashboard changes'),
    ])
    expect(subagents.map(({ name, status }) => [name, status])).toEqual([
      ['API changes', SubagentStatus.Running],
      ['Dashboard changes', SubagentStatus.Running],
      ['Check links', SubagentStatus.Done],
      ['Admin changes', SubagentStatus.Error],
    ])
  })

  it('counts a subagent started by another subagent too', () => {
    const subagents = deriveSubagents([
      agent('outer', 'Outer'),
      agent('inner', 'Inner', { parentToolUseId: 'use-outer' }),
      call({ id: 'grep', name: 'Grep', toolUseId: 'use-grep', parentToolUseId: 'use-inner' }),
    ])
    expect(subagents.map(({ name, log }) => [name, log.length])).toEqual([
      ['Outer', 1],
      ['Inner', 1],
    ])
  })

  describe('the summary', () => {
    it("is each running subagent's own latest progress summary, and nothing before its first", () => {
      const [api, dash, quiet] = deriveSubagents([
        agent('api', 'API changes', { progressSummary: 'Reading the API PRs' }),
        agent('dash', 'Dashboard changes', { progressSummary: 'Sorting the dashboard PRs' }),
        agent('quiet', 'Contributor list'),
      ])
      expect([api?.summary, dash?.summary, quiet?.summary]).toEqual([
        'Reading the API PRs',
        'Sorting the dashboard PRs',
        null,
      ])
    })

    it.each([ToolCallState.Done, ToolCallState.Error, ToolCallState.Paused, ToolCallState.Interrupted])(
      'is nothing once it is %s, whatever its call still holds',
      (state) => {
        const [subagent] = deriveSubagents([
          agent('api', 'API changes', { state, output: 'Sorted.', progressSummary: 'Reading the API PRs' }),
        ])
        expect(subagent?.summary).toBeNull()
      },
    )
  })
})

describe('runningSubagentCount', () => {
  it('counts the Agent and Task calls still running, nested ones included, and nothing else', () => {
    expect(runningSubagentCount(undefined)).toBe(0)
    expect(runningSubagentCount([])).toBe(0)
    expect(
      runningSubagentCount([
        agent('a', 'A'),
        call({ id: 't', name: 'Task', toolUseId: 'use-t' }),
        agent('nested', 'Nested', { parentToolUseId: 'use-a' }),
        // A running call that doesn't start a subagent, and a subagent's own running call.
        call({ id: 'r', toolUseId: 'use-r' }),
        call({ id: 'ar', toolUseId: 'use-ar', parentToolUseId: 'use-a' }),
        said('n', 'Hi', null),
      ]),
    ).toBe(3)
  })

  it('leaves out the subagents that have stopped running, however they stopped', () => {
    const stopped = [ToolCallState.Done, ToolCallState.Error, ToolCallState.Paused, ToolCallState.Interrupted]
    const events = stopped.map((state, index) => agent(`s${String(index)}`, 'Stopped', { state }))
    expect(runningSubagentCount(events)).toBe(0)
    expect(runningSubagentCount([...events, agent('live', 'Live')])).toBe(1)
  })

  it('is how many of the task’s subagents are running', () => {
    const events = [
      agent('a', 'A'),
      agent('b', 'B', { state: ToolCallState.Done, output: 'Done.' }),
      agent('c', 'C', { parentToolUseId: 'use-a' }),
    ]
    const running = deriveSubagents(events).filter(({ status }) => status === SubagentStatus.Running)
    expect(runningSubagentCount(events)).toBe(running.length)
  })
})

describe('runningSubagentCounts', () => {
  it('counts each task’s running subagents, leaving out the tasks with none', () => {
    expect(
      runningSubagentCounts({
        t1: [agent('a', 'A'), agent('b', 'B')],
        t2: [agent('c', 'C', { taskId: 't2', state: ToolCallState.Done })],
        t3: [],
        t4: [agent('d', 'D', { taskId: 't4' })],
      }),
    ).toEqual({ t1: 2, t4: 1 })
    expect(runningSubagentCounts({})).toEqual({})
  })
})

describe('subagentsRunningLabel', () => {
  it('says how many are running, in the singular for one', () => {
    expect(subagentsRunningLabel(1)).toBe('1 subagent running')
    expect(subagentsRunningLabel(3)).toBe('3 subagents running')
  })
})

describe('elapsed time', () => {
  const [running] = deriveSubagents([agent('a', 'A')])
  const [done] = deriveSubagents([agent('a', 'A', { state: ToolCallState.Done, finishedAt: AT + 72_000 })])
  const [unknown] = deriveSubagents([agent('a', 'A', { state: ToolCallState.Done })])

  it('runs until now while it runs, and stops when it finishes', () => {
    if (running === undefined || done === undefined || unknown === undefined) throw new Error('No subagent')
    expect(elapsedMs(running, AT + 5_000)).toBe(5_000)
    expect(elapsedMs(running, AT - 5_000)).toBe(0)
    expect(elapsedMs(done, AT + 999_000)).toBe(72_000)
    expect(elapsedMs(unknown, AT + 999_000)).toBeNull()
  })

  it('reads in seconds, minutes and hours, padded', () => {
    expect(formatElapsed(0)).toBe('0s')
    expect(formatElapsed(59_900)).toBe('59s')
    expect(formatElapsed(185_000)).toBe('3m 05s')
    expect(formatElapsed(252_000)).toBe('4m 12s')
    expect(formatElapsed(3_720_000)).toBe('1h 02m')
  })
})

describe('statuses', () => {
  it('have a label each', () => {
    expect(Object.values(SubagentStatus).map((status) => statusLabel(status))).toEqual([
      'Running',
      'Paused',
      'Done',
      'Interrupted',
      'Failed',
    ])
  })
})

describe('subagentLogText', () => {
  it('writes the log out: its name, each call with its argument and result, each note, nested ones indented', () => {
    const [explore] = deriveSubagents(
      [
        agent('explore', 'Find flaky tests', { state: ToolCallState.Done, output: 'Found one.\n' }),
        said('n1', 'Looking for timezone use.', 'use-explore'),
        call({
          id: 'grep',
          name: 'Grep',
          toolUseId: 'use-grep',
          input: { pattern: 'new Date' },
          output: 'test/date.test.ts',
          state: ToolCallState.Done,
          parentToolUseId: 'use-explore',
        }),
        agent('inner', 'Check one', { parentToolUseId: 'use-explore' }),
        said('n2', 'Checking.', 'use-inner'),
        call({ id: 'ls', name: 'LS', toolUseId: 'use-ls', parentToolUseId: 'use-explore' }),
      ],
    ).filter((subagent) => subagent.name === 'Find flaky tests')

    if (explore === undefined) throw new Error('No subagent')
    expect(subagentLogText(explore, '/code/api')).toBe(
      [
        'Find flaky tests',
        'Looking for timezone use.',
        'Grep new Date',
        '  test/date.test.ts',
        'Agent Check one',
        '  Running…',
        '  Checking.',
        'LS',
        '  Running…',
        '',
        'Found one.',
      ].join('\n'),
    )
  })

  it('has no outcome while it runs', () => {
    const [running] = deriveSubagents([agent('api', 'API changes', { output: 'partial' })])
    expect(running === undefined ? '' : subagentLogText(running)).toBe('API changes')
  })
})
