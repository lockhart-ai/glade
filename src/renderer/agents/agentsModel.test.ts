import { describe, expect, it } from 'vitest'
import {
  DividerKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  type NarrationEvent,
  type Todo,
  type ToolCallEvent,
  type ToolEvent,
} from '../../shared/domain'
import { ChildKind, FilingSource, type Filing } from '../../shared/todoHub'
import { agentLogRows, isAgentEvent } from '../tool-log/toolLogModel'
import {
  agentCallResult,
  agentCount,
  agentDotLabel,
  agentEventsSelector,
  agentName,
  agentsOf,
  agentStateLine,
  agentTodo,
  agentTodoSelector,
  formatDuration,
  isRunning,
  MAIN_AGENT_NAME,
  selectShownAgent,
  shownAgent,
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

  it('names its tab’s dot by whether it runs', () => {
    expect(agentDotLabel(true)).toBe('Running')
    expect(agentDotLabel(false)).toBe('Finished')
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
