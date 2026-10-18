import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  MessageSource,
  TaskActivity,
  TaskState,
  TodoState,
  ToolCallState,
  ToolEventKind,
  WatcherState,
  type Message,
  type NarrationEvent,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
  type Watcher,
} from '../../shared/domain'
import { ChildKind, FilingSource, type Filing } from '../../shared/todoHub'
import { sampleMessage, sampleTask, sampleWatcher } from '../store/test-bridge'
import { AgentActivity } from '../subagents/subagentsModel'
import { agentLogRows, isAgentEvent } from '../tool-log/toolLogModel'
import {
  activeTabsCrowded,
  agentCallResult,
  agentCount,
  agentDotLabel,
  agentEventsSelector,
  agentFinishedAgo,
  agentName,
  agentsOf,
  agentStateLine,
  agentTabsOf,
  agentTodo,
  agentTodoSelector,
  agentTokensLine,
  formatDuration,
  githubNoticeSelector,
  isRunning,
  mainAgentStateLine,
  mainAgentText,
  mainTokensLine,
  MAIN_AGENT_NAME,
  mainTurnRunning,
  selectAgentTabs,
  selectMainCurrentCall,
  selectShownAgent,
  shownAgent,
  shownAgentFinished,
  todoLineVerb,
} from './agentsModel'

const AT = new Date(2026, 9, 2, 13, 2).getTime()
const MINUTE = 60_000

function call(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return {
    id: `event-${id}`,
    taskId: 't1',
    turn: 1,
    createdAt: AT,
    kind: ToolEventKind.ToolCall,
    name: 'Read',
    input: { file_path: 'api/throttle.py' },
    output: '212 lines',
    state: ToolCallState.Done,
    finishedAt: AT + 1000,
    toolUseId: id,
    parentToolUseId: null,
    progressSummary: null,
    ...overrides,
  }
}

/** A subagent's `Agent` call, running unless `overrides` say otherwise. */
function agent(id: string, overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return call(id, {
    name: 'Agent',
    input: { description: id, prompt: '…' },
    output: null,
    state: ToolCallState.Running,
    finishedAt: null,
    ...overrides,
  })
}

const done = (minutes: number, output = 'Opened PR #511.'): Partial<ToolCallEvent> => ({
  state: ToolCallState.Done,
  output,
  finishedAt: AT + minutes * MINUTE,
})

function note(id: string, parentToolUseId: string | null = null): NarrationEvent {
  return { id, taskId: 't1', turn: 1, createdAt: AT, kind: ToolEventKind.Narration, text: 'Checking.', parentToolUseId }
}

describe('agentsOf', () => {
  it('has no subagents for a task with no log, or one whose agent started none', () => {
    expect(agentsOf(undefined).ids).toEqual([])
    expect(agentsOf([]).ids).toEqual([])
    expect(agentsOf([call('c1'), note('n1')]).ids).toEqual([])
    expect(agentCount(undefined)).toBe(1)
    expect(agentCount([call('c1')])).toBe(1)
  })

  it('puts the running subagents first, then the finished ones, the newest first within each', () => {
    const events: ToolEvent[] = [
      agent('fix-501', done(28)),
      agent('docs-503'),
      call('c1'),
      agent('limits-502'),
      agent('fix-501-ci', { state: ToolCallState.Error, output: 'Stopped', finishedAt: AT + MINUTE }),
      agent('notes-25'),
    ]

    const agents = agentsOf(events)

    expect(agents.ids).toEqual(['notes-25', 'limits-502', 'docs-503', 'fix-501-ci', 'fix-501'])
    expect(agents.calls.get('docs-503')).toBe(events[1])
    expect(agentCount(events)).toBe(6)
  })

  it('counts a call named Task as a subagent, and one a pause or a relaunch cut off as finished', () => {
    const events = [
      agent('paused', { state: ToolCallState.Paused }),
      agent('legacy', { name: 'Task' }),
      agent('cut-off', { state: ToolCallState.Interrupted }),
    ]

    expect(agentsOf(events).ids).toEqual(['legacy', 'cut-off', 'paused'])
    expect(events.map(isRunning)).toEqual([false, true, false])
  })

  it('gives a subagent of a subagent a tab of its own, among the rest', () => {
    const events = [
      agent('outer'),
      agent('inner', { parentToolUseId: 'outer' }),
      call('c1', { parentToolUseId: 'inner' }),
    ]

    expect(agentsOf(events).ids).toEqual(['inner', 'outer'])
  })

  it('moves a subagent to the finished ones when it ends, and back to the running ones when it’s woken', () => {
    const running = [agent('a'), agent('b'), agent('c')]
    expect(agentsOf(running).ids).toEqual(['c', 'b', 'a'])

    const finished = [agent('a'), agent('b', done(3)), agent('c')]
    expect(agentsOf(finished).ids).toEqual(['c', 'a', 'b'])

    // Woken after it finished (#395): its call runs again.
    const woken = [agent('a'), agent('b'), agent('c', done(4))]
    expect(agentsOf(woken).ids).toEqual(['b', 'a', 'c'])
  })

  it('works a log out once, however many read it, and again for the next log', () => {
    const events = [agent('a')]

    expect(agentsOf(events)).toBe(agentsOf(events))
    expect(agentsOf([...events])).not.toBe(agentsOf(events))
  })

  it('orders 50 subagents, half of them finished', () => {
    const events = Array.from({ length: 50 }, (_, index) => agent(`s${String(index)}`, index % 2 === 0 ? done(1) : {}))

    const { ids } = agentsOf(events)

    expect(ids).toHaveLength(50)
    expect(ids.slice(0, 3)).toEqual(['s49', 's47', 's45'])
    expect(ids.slice(25, 28)).toEqual(['s48', 's46', 's44'])
    expect(agentCount(events)).toBe(51)
  })
})

describe('shownAgent', () => {
  const events = [agent('fix-501'), agent('docs-503', done(2))]

  it('is the agent the task was left on, running or finished', () => {
    expect(shownAgent(events, 'fix-501')).toBe('fix-501')
    expect(shownAgent(events, 'docs-503')).toBe('docs-503')
  })

  it('is Main for a task left on none, on one that’s gone, or whose log isn’t loaded', () => {
    expect(shownAgent(events, undefined)).toBeNull()
    expect(shownAgent(events, 'gone')).toBeNull()
    expect(shownAgent(undefined, 'fix-501')).toBeNull()
    // A tool call that isn't a subagent's is no agent.
    expect(shownAgent([call('c1')], 'c1')).toBeNull()
  })

  it('reads the store', () => {
    const state = { toolEvents: { t1: events }, agentTabs: { t1: 'docs-503', t2: 'fix-501' } }

    expect(selectShownAgent(state, 't1')).toBe('docs-503')
    expect(selectShownAgent(state, 't2')).toBeNull()
    expect(selectShownAgent(state, 't3')).toBeNull()
  })
})

describe('agentName', () => {
  it('is Main for the task’s own agent, and a subagent’s description, else its type', () => {
    expect(agentName(undefined)).toBe(MAIN_AGENT_NAME)
    expect(agentName(agent('a', { input: { description: 'fix-501', subagent_type: 'general-purpose' } }))).toBe(
      'fix-501',
    )
    expect(agentName(agent('a', { input: { subagent_type: 'Explore' } }))).toBe('Explore')
    expect(agentName(agent('a', { input: {} }))).toBe('Subagent')
  })

  it('names its tab’s dot by its activity (#579)', () => {
    expect(agentDotLabel(AgentActivity.Running)).toBe('Running')
    expect(agentDotLabel(AgentActivity.Waiting)).toBe('Working in the background')
    expect(agentDotLabel(AgentActivity.Done)).toBe('Finished')
  })
})

describe('an agent’s events', () => {
  const outer = agent('outer')
  const inner = agent('inner', { parentToolUseId: 'outer' })
  const events: ToolEvent[] = [
    { id: 'd1', taskId: 't1', turn: 1, createdAt: AT, kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn },
    note('n-main'),
    call('c-main'),
    outer,
    note('n-outer', 'outer'),
    call('c-outer', { parentToolUseId: 'outer' }),
    inner,
    call('c-inner', { parentToolUseId: 'inner' }),
    { id: 'd2', taskId: 't1', turn: 2, createdAt: AT, kind: ToolEventKind.Divider, dividerKind: DividerKind.Turn },
  ]
  const ids = (agentId: string | null): string[] =>
    events.filter((event) => isAgentEvent(event, agentId)).map(({ id }) => id)

  it('are its own calls and notes: Main’s with the dividers, a subagent’s without what its own subagents did', () => {
    expect(ids(null)).toEqual(['d1', 'n-main', 'event-c-main', 'event-outer', 'd2'])
    expect(ids('outer')).toEqual(['n-outer', 'event-c-outer', 'event-inner'])
    expect(ids('inner')).toEqual(['event-c-inner'])
    expect(ids('gone')).toEqual([])
  })

  it('make its list’s rows, an Agent call a single row with nothing under it', () => {
    const rows = agentLogRows(events, 'outer')

    expect(rows.map((row) => row.kind)).toEqual([
      ToolEventKind.Narration,
      ToolEventKind.ToolCall,
      ToolEventKind.ToolCall,
    ])
    expect(rows.every((row) => row.kind !== ToolEventKind.ToolCall || row.children.length === 0)).toBe(true)
    // Main's are the Tool calls tab's: the second turn's divider, and the subagent's call alone.
    expect(agentLogRows(events, null).map((row) => row.kind)).toEqual([
      ToolEventKind.Narration,
      ToolEventKind.ToolCall,
      ToolEventKind.ToolCall,
      ToolEventKind.Divider,
    ])
    expect(agentLogRows(events, 'inner')).toHaveLength(1)
    expect(agentLogRows(events, 'gone')).toEqual([])
  })

  describe('read from the store', () => {
    it('are the same list until one of them changes, whatever another agent does', () => {
      const select = agentEventsSelector('t1', 'outer')
      const first = select({ toolEvents: { t1: events } })
      expect(first.map(({ id }) => id)).toEqual(['n-outer', 'event-c-outer', 'event-inner'])

      // The same log: not even read again.
      expect(select({ toolEvents: { t1: events } })).toBe(first)
      // Main and the inner subagent did something: a new log, the same list.
      const grown = [...events, call('late-main'), call('late-inner', { parentToolUseId: 'inner' })]
      expect(select({ toolEvents: { t1: grown } })).toBe(first)
      // Another task's log changes nothing.
      expect(select({ toolEvents: { t1: grown, t2: [call('other')] } })).toBe(first)

      // Its own call arrives, then changes.
      const late = call('late-outer', { parentToolUseId: 'outer', state: ToolCallState.Running })
      const more = select({ toolEvents: { t1: [...grown, late] } })
      expect(more).not.toBe(first)
      expect(more.at(-1)).toBe(late)
      const finished = { ...late, state: ToolCallState.Done }
      const after = select({ toolEvents: { t1: [...grown, finished] } })
      expect(after).not.toBe(more)
      expect(after.at(-1)).toBe(finished)
    })

    it('are none for a task with no log, and Main’s for no subagent', () => {
      const none = agentEventsSelector('t9', 'outer')
      expect(none({ toolEvents: {} })).toEqual([])
      expect(none({ toolEvents: {} })).toBe(none({ toolEvents: { t1: events } }))

      const main = agentEventsSelector('t1', null)
      expect(main({ toolEvents: { t1: events } }).map(({ id }) => id)).toEqual(ids(null))
    })

    it('stays one list over 2,000 calls as another agent’s arrive', () => {
      const long: ToolEvent[] = Array.from({ length: 2000 }, (_, index) => call(`c${String(index)}`))
      const select = agentEventsSelector('t1', null)
      const first = select({ toolEvents: { t1: long } })
      expect(first).toHaveLength(2000)

      let log = long
      for (let index = 0; index < 20; index += 1) {
        log = [...log, call(`sub-${String(index)}`, { parentToolUseId: 'outer' })]
        expect(select({ toolEvents: { t1: log } })).toBe(first)
      }
    })
  })
})

describe('Main’s GitHub notices (#682, #715)', () => {
  function notice(id: string, body = 'GitHub:\n- PR #1 A: CI failed'): Message {
    return { ...sampleMessage(id, 't1', body), source: MessageSource.Github }
  }

  const broadcast: Message = { ...sampleMessage('b1', 't1'), source: MessageSource.Broadcast }
  const yours: Message = sampleMessage('m1', 't1')

  it('is the task’s messages left by the link watcher, in order, for Main alone', () => {
    const messages = [yours, notice('g1'), broadcast, notice('g2')]
    const select = githubNoticeSelector('t1', null)
    expect(select({ messages: { t1: messages } })).toEqual([notice('g1'), notice('g2')])
  })

  it('is always empty for a subagent: a notice is only ever Main’s', () => {
    const select = githubNoticeSelector('t1', 'outer')
    expect(select({ messages: { t1: [notice('g1')] } })).toEqual([])
  })

  it('is the same list until one of them changes, whatever an unrelated message does', () => {
    const select = githubNoticeSelector('t1', null)
    const messages = [yours, notice('g1')]
    const first = select({ messages: { t1: messages } })
    expect(first).toEqual([notice('g1')])

    // The same log: not even read again.
    expect(select({ messages: { t1: messages } })).toBe(first)
    // Another message that isn't a notice arrives: a new log, the same list.
    const grown = [...messages, broadcast]
    expect(select({ messages: { t1: grown } })).toBe(first)
    // Another task's messages change nothing.
    expect(select({ messages: { t1: grown, t2: [notice('other')] } })).toBe(first)

    // Its own notice arrives.
    const more = select({ messages: { t1: [...grown, notice('g2')] } })
    expect(more).not.toBe(first)
    expect(more).toEqual([notice('g1'), notice('g2')])
  })

  it('is none for a task with no messages', () => {
    const select = githubNoticeSelector('t9', null)
    expect(select({ messages: {} })).toEqual([])
  })
})

describe('formatDuration', () => {
  it('reads in seconds under a minute, then in minutes, hours and days, rounded down', () => {
    expect(formatDuration(0)).toBe('0s')
    expect(formatDuration(-500)).toBe('0s')
    expect(formatDuration(12_900)).toBe('12s')
    expect(formatDuration(59_999)).toBe('59s')
    expect(formatDuration(MINUTE)).toBe('1m')
    expect(formatDuration(28 * MINUTE + 59_000)).toBe('28m')
    expect(formatDuration(109 * MINUTE)).toBe('1h 49m')
    expect(formatDuration(120 * MINUTE)).toBe('2h')
    expect(formatDuration(3 * 24 * 60 * MINUTE)).toBe('3d')
  })
})

describe('what a subagent’s lines say', () => {
  const now = AT + 6 * MINUTE

  it('its state and how long it has run, while it runs and once it has ended', () => {
    expect(agentStateLine(agent('a'), now)).toBe('Running · 6m')
    expect(agentStateLine(agent('a'), AT + 12_000)).toBe('Running · 12s')
    expect(agentStateLine(agent('a', done(28)), now)).toBe('Done · 28m')
    expect(agentStateLine(agent('a', { state: ToolCallState.Error, finishedAt: AT + 3 * MINUTE }), now)).toBe(
      'Failed · 3m',
    )
    expect(agentStateLine(agent('a', { state: ToolCallState.Interrupted, finishedAt: AT + MINUTE }), now)).toBe(
      'Interrupted · 1m',
    )
  })

  it('its state alone when Glade never recorded when it finished', () => {
    expect(agentStateLine(agent('a', { state: ToolCallState.Done, finishedAt: null }), now)).toBe('Done')
    expect(agentStateLine(agent('a', { state: ToolCallState.Paused }), now)).toBe('Paused')
  })

  it('under its Agent call: live while it runs, then how it ended and the first line of what it came to', () => {
    expect(agentCallResult(agent('a', { output: 'ignored while it runs' }), now)).toBe('Running · 6m')
    expect(agentCallResult(agent('a', done(28, '\nOpened PR #511.\nThe burst test covers it.')), now)).toBe(
      'Done · 28m · Opened PR #511.',
    )
    expect(agentCallResult(agent('a', done(28, '')), now)).toBe('Done · 28m')
    expect(
      agentCallResult(agent('a', { state: ToolCallState.Error, output: 'Stopped by you', finishedAt: AT + 2000 }), now),
    ).toBe('Failed · 2s · Stopped by you')
    expect(agentCallResult(agent('a', { state: ToolCallState.Paused, output: null }), now)).toBe('Paused')
  })

  it('"Working on" until it has finished, then "Worked on"', () => {
    expect(todoLineVerb({ state: ToolCallState.Running })).toBe('Working on')
    expect(todoLineVerb({ state: ToolCallState.Paused })).toBe('Working on')
    expect(todoLineVerb({ state: ToolCallState.Done })).toBe('Worked on')
    expect(todoLineVerb({ state: ToolCallState.Error })).toBe('Worked on')
    expect(todoLineVerb({ state: ToolCallState.Interrupted })).toBe('Worked on')
  })
})

describe('agentTodo', () => {
  const todos: Todo[] = [
    { id: '1', text: '#501 Return Retry-After on 429s', state: TodoState.Doing, note: null, completedAt: null },
    { id: '2', text: '#502 Per-key limits for /search', state: TodoState.Todo, note: null, completedAt: null },
  ]
  const filing = (key: string, todoId: string, kind = ChildKind.Subagent, source = FilingSource.Named): Filing => ({
    taskId: 't1',
    kind,
    key,
    todoId,
    source,
    filedAt: AT,
  })
  const filings = [filing('fix-501', '1'), filing('fix-501-ci', '1'), filing('limits-502', '2'), filing('old', '9')]
  const events = [
    agent('fix-501'),
    agent('fix-501-ci'),
    agent('limits-502'),
    agent('docs-503'),
    agent('old'),
    agent('helper', { parentToolUseId: 'limits-502' }),
    agent('deeper', { parentToolUseId: 'helper' }),
    agent('stray', { parentToolUseId: 'docs-503' }),
  ]
  const agents = agentsOf(events)

  it('is the todo its Agent call was started for: one subagent, one todo', () => {
    expect(agentTodo(filings, todos, agents, 'fix-501')).toBe(todos[0])
    expect(agentTodo(filings, todos, agents, 'fix-501-ci')).toBe(todos[0])
    expect(agentTodo(filings, todos, agents, 'limits-502')).toBe(todos[1])
  })

  it('is its parent’s todo for a subagent of a subagent, however deep, unless it named another', () => {
    expect(agentTodo(filings, todos, agents, 'helper')).toBe(todos[1])
    expect(agentTodo(filings, todos, agents, 'deeper')).toBe(todos[1])
    expect(agentTodo([...filings, filing('deeper', '1')], todos, agents, 'deeper')).toBe(todos[0])
    // One whose parent has no todo has none either.
    expect(agentTodo(filings, todos, agents, 'stray')).toBeNull()
  })

  it('is none for a subagent with no todo, one whose todo was deleted, and until the filings are read', () => {
    expect(agentTodo(filings, todos, agents, 'docs-503')).toBeNull()
    expect(agentTodo(filings, todos, agents, 'old')).toBeNull()
    expect(agentTodo(filings, todos.slice(1), agents, 'fix-501')).toBeNull()
    expect(agentTodo(undefined, todos, agents, 'fix-501')).toBeNull()
    expect(agentTodo(filings, undefined, agents, 'fix-501')).toBeNull()
    expect(agentTodo(filings, todos, agentsOf(undefined), 'fix-501')).toBeNull()
  })

  it('is none for something else filed under the same key', () => {
    expect(agentTodo([filing('fix-501', '1', ChildKind.Commit)], todos, agents, 'fix-501')).toBeNull()
  })

  describe('read from the store', () => {
    const state = {
      filings: { t1: filings },
      todos: { t1: { items: todos, updatedAt: AT } },
      toolEvents: { t1: events },
    }

    it('is worked out once, until the task’s filings, todos or log change', () => {
      const select = agentTodoSelector('t1', 'limits-502')
      expect(select(state)).toBe(todos[1])
      expect(select({ ...state })).toBe(todos[1])

      // Moved to another todo.
      const moved = [
        ...filings,
        { ...filing('limits-502', '1', ChildKind.Subagent, FilingSource.Moved), filedAt: AT + 1 },
      ]
      expect(select({ ...state, filings: { t1: moved } })).toBe(todos[0])
      // Its todo deleted.
      expect(select({ ...state, todos: { t1: { items: todos.slice(0, 1), updatedAt: AT } } })).toBeNull()
      // The log grows: the same answer, from the new log.
      expect(select({ ...state, toolEvents: { t1: [...events, call('late')] } })).toBe(todos[1])
    })

    it('is none for a task with nothing read, or no todo list', () => {
      const select = agentTodoSelector('t9', 'limits-502')
      expect(select({ filings: {}, todos: {}, toolEvents: {} })).toBeNull()
      expect(select({ filings: { t9: filings }, todos: { t9: null }, toolEvents: { t9: events } })).toBeNull()
    })
  })
})

describe('the Main tab’s line (#566)', () => {
  const working = {
    state: TaskState.Active,
    activity: TaskActivity.Working,
    createdAt: AT,
    status: 'Throttles applied to the three viewsets; measuring /search',
  } as const
  const waiting = { state: TaskState.Active, activity: TaskActivity.Waiting, createdAt: AT, status: '' } as const

  it('says the task’s status summary, falling back to its current tool call', () => {
    expect(mainAgentText(working, null, undefined)).toBe(working.status)
    expect(mainAgentText(waiting, null, undefined)).toBeNull()
    const reading = call('read-1', { name: 'Read', input: { file_path: 'api/views.py' } })
    expect(mainAgentText(waiting, reading, '/Users/sample/code/api')).toBe('Read api/views.py')
    // Whatever call it's given is described by its tool and its arguments.
    expect(mainAgentText(waiting, call('agent-1', { name: 'Agent', input: { description: 'PRs' } }), undefined)).toBe(
      'Agent PRs',
    )
  })

  it('says "Running · 42m" by the task’s age while it works, and nothing otherwise', () => {
    expect(mainAgentStateLine(true, AT, AT + 42 * MINUTE)).toBe('Running · 42m')
    expect(mainAgentStateLine(true, AT, AT + 30_000)).toBe('Running · now')
    expect(mainAgentStateLine(false, AT, AT + 42 * MINUTE)).toBeNull()
  })

  it('says what the turns have spent, as the meter writes thousands and millions, a small total as itself (#587)', () => {
    expect(mainTokensLine(1_234_567, 45_000)).toBe('1.2M in · 45k out')
    expect(mainTokensLine(76_000, 3_500)).toBe('76k in · 4k out')
    expect(mainTokensLine(999, 620)).toBe('999 in · 620 out')
    expect(mainTokensLine(1_000, 1_000)).toBe('1k in · 1k out')
    expect(mainTokensLine(1_234_567, 620)).toBe('1.2M in · 620 out')
    expect(mainTokensLine(0, 620)).toBe('0 in · 620 out')
  })

  it("says a native subagent's context size while its split is not in, as the meter writes it (#592)", () => {
    expect(agentTokensLine(478_200, undefined, undefined)).toBe('478k context')
    expect(agentTokensLine(823, undefined, undefined)).toBe('823 context')
    expect(agentTokensLine(1_000_000, undefined, undefined)).toBe('1M context')
  })

  it('prefers a dispatched child’s split, and shows nothing while there is no figure or it is zero (#592)', () => {
    expect(agentTokensLine(478_200, 1_234_567, 45_000)).toBe('1.2M in · 45k out')
    expect(agentTokensLine(undefined, 999, 620)).toBe('999 in · 620 out')
    expect(agentTokensLine(undefined, undefined, undefined)).toBeNull()
    expect(agentTokensLine(0, undefined, undefined)).toBeNull()
    expect(agentTokensLine(478_200, 0, 0)).toBeNull()
    expect(agentTokensLine(undefined, 0, undefined)).toBeNull()
    expect(agentTokensLine(undefined, undefined, 0)).toBeNull()
  })

  it('reads Main’s current tool call from the store: its last running one, a subagent’s call never', () => {
    const events = [
      call('done-1', { state: ToolCallState.Done }),
      call('agent-1', { name: 'Agent', input: { description: 'PRs' } }),
      call('read-1', {
        name: 'Read',
        input: { file_path: 'api/views.py' },
        state: ToolCallState.Running,
        output: null,
        finishedAt: null,
      }),
    ]
    const select = selectMainCurrentCall('t1')
    expect(select({ toolEvents: { t1: events } })).toBe(events[2])
    // The same log reads the same, and another task's log doesn't reach it.
    expect(select({ toolEvents: { t1: events } })).toBe(events[2])
    expect(select({ toolEvents: {} })).toBeNull()
  })
})

describe('mainTurnRunning', () => {
  it('is true only while the task’s own turn works or is paused', () => {
    expect(mainTurnRunning(undefined)).toBe(false)
    expect(mainTurnRunning({ activity: TaskActivity.Working })).toBe(true)
    expect(mainTurnRunning({ activity: TaskActivity.Paused })).toBe(true)
    expect(mainTurnRunning({ activity: TaskActivity.Waiting })).toBe(false)
  })
})

describe('agentTabsOf (#617)', () => {
  const live = (id: string, parentToolUseId: string | null = null): Watcher =>
    sampleWatcher(id, 't1', { parentToolUseId, state: WatcherState.Running })

  it('splits running subagents from finished ones, newest first within each', () => {
    const events = [agent('fix-501', done(28)), agent('docs-503'), agent('limits-502')]

    const tabs = agentTabsOf(events, undefined, false)

    expect(tabs.active).toEqual(['limits-502', 'docs-503'])
    expect(tabs.finished).toEqual(['fix-501'])
  })

  it('lists the finished ones by when they finished, not when they started', () => {
    // fix-501 started first, at AT, and finished at AT+28m; docs-503 started later and finished at AT+29m, so it leads.
    const events = [
      agent('fix-501', { ...done(28), createdAt: AT }),
      agent('docs-503', { ...done(29), createdAt: AT + MINUTE }),
    ]

    expect(agentTabsOf(events, undefined, false).finished).toEqual(['docs-503', 'fix-501'])
  })

  it('sorts a finished one with no recorded end last, ties keeping the order they started in, the active order as it was', () => {
    const events = [
      agent('fix-501', { ...done(28), createdAt: AT }),
      agent('docs-503', { ...done(28), createdAt: AT + MINUTE }), // ended with fix-501, started after it
      agent('limits-502', { state: ToolCallState.Done, output: 'Done.', finishedAt: null }),
      agent('notes-25'),
    ]

    const tabs = agentTabsOf(events, undefined, false)

    expect(tabs.finished).toEqual(['docs-503', 'fix-501', 'limits-502'])
    expect(tabs.active).toEqual(['notes-25'])
  })

  it('keeps a subagent active while a watcher it started is still live, though its own call is done', () => {
    const events = [agent('fix-501', done(28))]

    expect(agentTabsOf(events, [], false).finished).toEqual(['fix-501'])
    expect(agentTabsOf(events, [live('w1', 'fix-501')], false).active).toEqual(['fix-501'])
    expect(agentTabsOf(events, [live('w1', 'fix-501')], false).finished).toEqual([])
    // Ended: finished again.
    const ended = { ...live('w1', 'fix-501'), state: WatcherState.Finished }
    expect(agentTabsOf(events, [ended], false).finished).toEqual(['fix-501'])
  })

  it('keeps Main active while its own turn runs or something it started is still alive, by the same rule', () => {
    const events = [agent('fix-501', done(28))]

    expect(agentTabsOf(events, undefined, false).active).toEqual([])
    expect(agentTabsOf(events, undefined, true).active).toEqual([])
    expect(agentTabsOf(events, [live('w1')], false).active).toEqual([])
  })

  it('is empty for a task with no subagents, and the same object every time', () => {
    expect(agentTabsOf(undefined, undefined, false)).toEqual({ active: [], finished: [] })
    expect(agentTabsOf([], [], false)).toBe(agentTabsOf([], [], false))
  })

  it('works a log out once, by its agent order and its activity, however many read it', () => {
    const events = [agent('a')]
    const watchers: Watcher[] = []

    expect(agentTabsOf(events, watchers, false)).toBe(agentTabsOf(events, watchers, false))
    // A new log, or new watchers, or Main's own turn starting: worked out again.
    expect(agentTabsOf([...events], watchers, false)).not.toBe(agentTabsOf(events, watchers, false))
    expect(agentTabsOf(events, [...watchers], false)).not.toBe(agentTabsOf(events, watchers, false))
    expect(agentTabsOf(events, watchers, true)).not.toBe(agentTabsOf(events, watchers, false))
  })

  it('reads the store by the task’s id', () => {
    const events = [agent('fix-501', done(28)), agent('limits-502')]
    const state = {
      toolEvents: { t1: events },
      watchers: {},
      tasks: { t1: { ...sampleTask('t1', 'w1'), activity: TaskActivity.Working } },
    }

    expect(selectAgentTabs(state, 't1')).toEqual({ active: ['limits-502'], finished: ['fix-501'] })
    expect(selectAgentTabs(state, 't9')).toEqual({ active: [], finished: [] })
  })
})

describe('shownAgentFinished (#617)', () => {
  const events = [agent('fix-501', done(28)), agent('limits-502')]
  const state = {
    toolEvents: { t1: events },
    watchers: {},
    tasks: {},
    agentTabs: {},
  }

  it('is false for Main and an active subagent, true only for a finished one that’s selected', () => {
    expect(shownAgentFinished(state, 't1')).toBe(false)
    expect(shownAgentFinished({ ...state, agentTabs: { t1: 'limits-502' } }, 't1')).toBe(false)
    expect(shownAgentFinished({ ...state, agentTabs: { t1: 'fix-501' } }, 't1')).toBe(true)
    // Gone, or no log: falls back to Main, so false.
    expect(shownAgentFinished({ ...state, agentTabs: { t1: 'gone' } }, 't1')).toBe(false)
    expect(shownAgentFinished(state, 't9')).toBe(false)
  })
})

describe('agentFinishedAgo (#617)', () => {
  it('reads how long ago a finished subagent ended, by formatDuration', () => {
    expect(agentFinishedAgo({ finishedAt: AT }, AT + 2 * MINUTE)).toBe('2m')
    expect(agentFinishedAgo({ finishedAt: AT }, AT + 109 * MINUTE)).toBe('1h 49m')
  })

  it('is null for one Glade never recorded an end for', () => {
    expect(agentFinishedAgo({ finishedAt: null }, AT)).toBeNull()
  })
})

describe('activeTabsCrowded (#617)', () => {
  it('is false with no active tabs, whatever the width', () => {
    expect(activeTabsCrowded(0, 0, 4)).toBe(false)
    expect(activeTabsCrowded(400, 0, 4)).toBe(false)
  })

  it('is true once each tab’s fair share, less the gaps between them, drops under the 56px floor', () => {
    // 3 tabs in 200px, 2 gaps of 4px: (200 - 8) / 3 = 64px each, at the floor's far side.
    expect(activeTabsCrowded(200, 3, 4)).toBe(false)
    // 10 tabs in 400px, 9 gaps of 4px: (400 - 36) / 10 = 36.4px each, under it.
    expect(activeTabsCrowded(400, 10, 4)).toBe(true)
    // Exactly 56px per tab: not yet crowded.
    expect(activeTabsCrowded(56, 1, 4)).toBe(false)
  })
})
