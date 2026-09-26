import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { TaskIndicator } from '../../shared/taskIndicator'
import {
  anyRunning,
  deriveSubagents,
  elapsedMs,
  formatElapsed,
  LatestLineKind,
  metaLine,
  statusIndicator,
  statusLabel,
  subagentCount,
  subagentLogText,
  subagentName,
  SubagentStatus,
  tally,
  toolCallsLabel,
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

    expect(subagents.map(({ name, toolCalls }) => [name, toolCalls])).toEqual([
      ['API changes', 1],
      ['Explore', 1],
    ])
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
    expect(subagents.map(({ name, toolCalls }) => [name, toolCalls])).toEqual([
      ['Outer', 1],
      ['Inner', 1],
    ])
  })

  describe('the latest line', () => {
    it('is nothing before a running subagent has done anything', () => {
      expect(deriveSubagents([agent('api', 'API changes')])[0]?.latest).toBeNull()
    })

    it('is its latest tool call while it runs, with the argument relative to the workspace root', () => {
      const [subagent] = deriveSubagents(
        [
          agent('api', 'API changes'),
          said('n', 'Reading.', 'use-api'),
          call({
            id: 'read',
            toolUseId: 'use-read',
            parentToolUseId: 'use-api',
            input: { file_path: '/code/api/api/throttles.py' },
          }),
        ],
        '/code/api',
      )
      expect(subagent?.latest).toEqual({ kind: LatestLineKind.ToolCall, name: 'Read', argument: 'api/throttles.py' })
    })

    it('is the last thing it said while it runs, when that came after its last call', () => {
      const [subagent] = deriveSubagents([
        agent('dash', 'Dashboard changes'),
        call({ id: 'bash', name: 'Bash', toolUseId: 'use-bash', parentToolUseId: 'use-dash' }),
        said('n', '#1418 belongs under features.', 'use-dash'),
      ])
      expect(subagent?.latest).toEqual({ kind: LatestLineKind.Said, text: '#1418 belongs under features.' })
    })

    it('is the first line of what it finished with, or its last row when that is empty', () => {
      const [done] = deriveSubagents([
        agent('links', 'Check links', { state: ToolCallState.Done, output: '\nFound 2 broken links.\nFixed both.' }),
      ])
      expect(done?.latest).toEqual({ kind: LatestLineKind.Outcome, text: 'Found 2 broken links.' })

      const [failed] = deriveSubagents([agent('api', 'API changes', { state: ToolCallState.Error, output: null })])
      expect(failed?.latest).toBeNull()

      const [quiet] = deriveSubagents([
        agent('api', 'API changes', { state: ToolCallState.Done, output: '' }),
        said('n', 'All sorted.', 'use-api'),
      ])
      expect(quiet?.latest).toEqual({ kind: LatestLineKind.Said, text: 'All sorted.' })
    })
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

describe('subagentCount', () => {
  it('counts the Agent and Task calls, and nothing else', () => {
    expect(subagentCount([])).toBe(0)
    expect(
      subagentCount([
        agent('a', 'A'),
        call({ id: 't', name: 'Task', toolUseId: 'use-t' }),
        call({ id: 'r', toolUseId: 'use-r', parentToolUseId: 'use-a' }),
        said('n', 'Hi', null),
      ]),
    ).toBe(2)
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

  it('goes before the tool call count, when it is known', () => {
    if (running === undefined || unknown === undefined) throw new Error('No subagent')
    expect(metaLine(running, AT + 72_000)).toBe('1m 12s · 0 tool calls')
    expect(metaLine(unknown, AT)).toBe('0 tool calls')
    expect(toolCallsLabel(1)).toBe('1 tool call')
    expect(toolCallsLabel(12)).toBe('12 tool calls')
  })
})

describe('statuses', () => {
  it('have a label and a dot each', () => {
    expect(Object.values(SubagentStatus).map((status) => [statusLabel(status), statusIndicator(status)])).toEqual([
      ['Running', TaskIndicator.Working],
      ['Paused', TaskIndicator.Waiting],
      ['Done', TaskIndicator.Done],
      ['Interrupted', TaskIndicator.Done],
      ['Failed', TaskIndicator.Error],
    ])
  })

  it('tally up by status, leaving out a status no subagent has', () => {
    const subagents = deriveSubagents([
      agent('a', 'A'),
      agent('b', 'B', { state: ToolCallState.Done }),
      agent('c', 'C'),
      agent('d', 'D'),
    ])
    expect(tally(subagents)).toEqual([
      { status: SubagentStatus.Running, label: '3 running' },
      { status: SubagentStatus.Done, label: '1 done' },
    ])
    expect(
      tally(
        deriveSubagents([
          agent('a', 'A', { state: ToolCallState.Error }),
          agent('b', 'B', { state: ToolCallState.Interrupted }),
          agent('c', 'C', { state: ToolCallState.Paused }),
        ]),
      ),
    ).toEqual([
      { status: SubagentStatus.Paused, label: '1 paused' },
      { status: SubagentStatus.Interrupted, label: '1 interrupted' },
      { status: SubagentStatus.Error, label: '1 failed' },
    ])
    expect(anyRunning(subagents)).toBe(true)
    expect(anyRunning(subagents.filter((subagent) => subagent.status === SubagentStatus.Done))).toBe(false)
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
      '/code/api',
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
