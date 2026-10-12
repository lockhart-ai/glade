import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  ToolCallState,
  ToolEventKind,
  WatcherState,
  type NarrationEvent,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import { sampleWatcher } from '../store/test-bridge'
import {
  agentActivity,
  AgentActivity,
  deriveSubagents,
  elapsedMs,
  formatElapsed,
  isAgentActive,
  runningSubagentCounts,
  statusLabel,
  subagentCounts,
  subagentLogText,
  subagentName,
  subagentsLabel,
  SubagentStatus,
  UNNAMED_SUBAGENT,
  waitingSubagentCounts,
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

/** A watcher the subagent `parentToolUseId` started (null for Main's own), live by default. */
function watcher(id: string, parentToolUseId: string | null, overrides: Partial<Watcher> = {}): Watcher {
  return sampleWatcher(id, 't1', { parentToolUseId, ...overrides })
}

describe('agentActivity (#579)', () => {
  it('is Running for an agent whose own turn runs, Main included', () => {
    const events = [agent('a', 'A')]
    expect(agentActivity(events, [], false).get('use-a')).toBe(AgentActivity.Running)
    expect(agentActivity(events, [], true).get(null)).toBe(AgentActivity.Running)
  })

  it('is Waiting for Main while a subagent it started is still active, even though Main’s own turn has ended', () => {
    const events = [agent('a', 'A')]
    expect(agentActivity(events, [], false).get(null)).toBe(AgentActivity.Waiting)
  })

  it('is Done for Main once nothing under it is alive', () => {
    const events = [agent('a', 'A', { state: ToolCallState.Done, output: 'Done.' })]
    expect(agentActivity(events, [], false).get(null)).toBe(AgentActivity.Done)
  })

  it('is Waiting once a finished subagent still has a live watcher, and Done again once it ends (the bug, #579)', () => {
    const events = [agent('a', 'A', { state: ToolCallState.Done, output: 'Done.' })]
    const live = [watcher('w', 'use-a')]
    expect(agentActivity(events, live, false).get('use-a')).toBe(AgentActivity.Waiting)
    // Today, before the fix, only the literal Running state is counted: this is the bug the issue reports.
    expect(subagentCounts(events, [])).toEqual({ running: 0, waiting: 0 })
    expect(subagentCounts(events, live)).toEqual({ running: 0, waiting: 1 })

    const stopped = [watcher('w', 'use-a', { state: WatcherState.Stopped, endedAt: AT })]
    expect(agentActivity(events, stopped, false).get('use-a')).toBe(AgentActivity.Done)
    expect(subagentCounts(events, stopped)).toEqual({ running: 0, waiting: 0 })
  })

  it('counts a scheduled wakeup or a suspended one (after a relaunch) as alive, not only a running process', () => {
    const events = [agent('a', 'A', { state: ToolCallState.Done, output: 'Done.' })]
    expect(
      agentActivity(events, [watcher('scheduled', 'use-a', { state: WatcherState.Scheduled })], false).get('use-a'),
    ).toBe(AgentActivity.Waiting)
    expect(
      agentActivity(events, [watcher('suspended', 'use-a', { state: WatcherState.Suspended })], false).get('use-a'),
    ).toBe(AgentActivity.Waiting)
  })

  it('counts once with two watchers, and stays alive until both end', () => {
    const events = [agent('a', 'A', { state: ToolCallState.Done, output: 'Done.' })]
    const ci = watcher('ci', 'use-a')
    const deploy = watcher('deploy', 'use-a')
    expect(subagentCounts(events, [ci, deploy])).toEqual({ running: 0, waiting: 1 })
    const deployEnded = { ...deploy, state: WatcherState.Finished, endedAt: AT }
    expect(subagentCounts(events, [ci, deployEnded])).toEqual({ running: 0, waiting: 1 })
    const ciEnded = { ...ci, state: WatcherState.Finished, endedAt: AT }
    expect(subagentCounts(events, [ciEnded, deployEnded])).toEqual({ running: 0, waiting: 0 })
  })

  it('is Running, not Waiting, for a subagent whose own turn runs and that also has a live watcher', () => {
    const events = [agent('a', 'A')]
    expect(subagentCounts(events, [watcher('w', 'use-a')])).toEqual({ running: 1, waiting: 0 })
  })

  it('makes an outer subagent Waiting while an inner one it started is still active, nested however deep', () => {
    const events = [
      agent('outer', 'Outer', { state: ToolCallState.Done, output: 'Done.' }),
      agent('inner', 'Inner', { state: ToolCallState.Done, output: 'Done.', parentToolUseId: 'use-outer' }),
      agent('innermost', 'Innermost', { parentToolUseId: 'use-inner' }),
    ]
    const activity = agentActivity(events, [], false)
    expect(activity.get('use-innermost')).toBe(AgentActivity.Running)
    expect(activity.get('use-inner')).toBe(AgentActivity.Waiting)
    expect(activity.get('use-outer')).toBe(AgentActivity.Waiting)
    // Main started the outer subagent directly, so it's active too, while the chain under it still is.
    expect(isAgentActive(activity.get(null) ?? AgentActivity.Done)).toBe(true)
  })

  it('is Done for a subagent with nothing of its own running and nothing alive under it', () => {
    const events = [agent('a', 'A', { state: ToolCallState.Done, output: 'Done.' })]
    expect(agentActivity(events, [], false).get('use-a')).toBe(AgentActivity.Done)
  })
})

describe('subagentCounts', () => {
  it('is zero with no events or watchers', () => {
    expect(subagentCounts(undefined, undefined)).toEqual({ running: 0, waiting: 0 })
    expect(subagentCounts([], [])).toEqual({ running: 0, waiting: 0 })
  })

  it('splits running and waiting apart, leaving Main out of both', () => {
    const events = [
      agent('a', 'A'),
      agent('b', 'B', { state: ToolCallState.Done, output: 'Done.' }),
      agent('c', 'C', { state: ToolCallState.Done, output: 'Done.' }),
    ]
    expect(subagentCounts(events, [watcher('w', 'use-b')])).toEqual({ running: 1, waiting: 1 })
  })
})

describe('runningSubagentCounts and waitingSubagentCounts', () => {
  it('count each task’s subagents apart, leaving out the tasks with none of that kind', () => {
    const toolEvents = {
      t1: [agent('a', 'A'), agent('b', 'B', { state: ToolCallState.Done, output: 'Done.', taskId: 't1' })],
      t2: [agent('c', 'C', { taskId: 't2', state: ToolCallState.Done, output: 'Done.' })],
      t3: [] as ToolCallEvent[],
      t4: [agent('d', 'D', { taskId: 't4' })],
    }
    const watchers = { t1: [watcher('w', 'use-b')] }
    expect(runningSubagentCounts(toolEvents, watchers)).toEqual({ t1: 1, t4: 1 })
    expect(waitingSubagentCounts(toolEvents, watchers)).toEqual({ t1: 1 })
    expect(runningSubagentCounts({}, {})).toEqual({})
    expect(waitingSubagentCounts({}, {})).toEqual({})
  })
})

describe('subagentsLabel', () => {
  it('says how many are running, in the singular for one, with none waiting', () => {
    expect(subagentsLabel({ running: 1, waiting: 0 })).toBe('1 subagent running')
    expect(subagentsLabel({ running: 3, waiting: 0 })).toBe('3 subagents running')
  })

  it('says how many are waiting on a watcher, with none running', () => {
    expect(subagentsLabel({ running: 0, waiting: 1 })).toBe('1 subagent waiting on a watcher')
    expect(subagentsLabel({ running: 0, waiting: 2 })).toBe('2 subagents waiting on a watcher')
  })

  it('splits the two apart when there’s one of each', () => {
    expect(subagentsLabel({ running: 2, waiting: 1 })).toBe('3 subagents: 2 running, 1 waiting on a watcher')
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
    const [explore] = deriveSubagents([
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
    ]).filter((subagent) => subagent.name === 'Find flaky tests')

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
