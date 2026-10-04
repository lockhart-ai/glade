import { describe, expect, it } from 'vitest'
import {
  ChildTool,
  hookRefusal,
  isChildTool,
  namedTodo,
  nameTodo,
  readsTodo,
  TODO_FIELDS,
  TODO_TOOLS,
  todoMarker,
} from './child-calls'

describe('isChildTool', () => {
  it('knows the five tools that make a child, and no other', () => {
    for (const tool of Object.values(ChildTool)) expect(isChildTool(tool)).toBe(true)
    for (const tool of ['Read', 'TaskCreate', 'mcp__glade__add_artifact', 'agent', '']) {
      expect(isChildTool(tool)).toBe(false)
    }
  })
})

describe('nameTodo', () => {
  it("puts the marker at the start of each tool's own free text, and leaves the rest of the input alone", () => {
    expect(
      nameTodo(ChildTool.Agent, { description: 'Review the date helpers', prompt: 'Read src/dates.ts.' }, '2'),
    ).toEqual({
      description: '[todo 2] Review the date helpers',
      prompt: 'Read src/dates.ts.',
    })
    expect(
      nameTodo(ChildTool.Monitor, { description: 'CI checks', timeout_ms: 60_000, command: 'gh pr checks' }, '3'),
    ).toEqual({
      description: '[todo 3] CI checks',
      timeout_ms: 60_000,
      command: 'gh pr checks',
    })
    expect(
      nameTodo(ChildTool.Bash, { command: 'npm test', description: 'Run the tests', run_in_background: true }, '1'),
    ).toEqual({
      command: 'npm test',
      description: '[todo 1] Run the tests',
      run_in_background: true,
    })
    expect(
      nameTodo(ChildTool.ScheduleWakeup, { delaySeconds: 300, reason: 'Check the rollout', prompt: 'Check it.' }, '4'),
    ).toEqual({
      delaySeconds: 300,
      reason: '[todo 4] Check the rollout',
      prompt: 'Check it.',
    })
    expect(nameTodo(ChildTool.CronCreate, { cron: '0 9 * * *', prompt: 'Check the queue.' }, '12')).toEqual({
      cron: '0 9 * * *',
      prompt: '[todo 12] Check the queue.',
    })
  })

  it('names the todo in a call that has no text of its own, or an empty one', () => {
    expect(nameTodo(ChildTool.Bash, { command: 'git commit -m Fix' }, '2')).toEqual({
      command: 'git commit -m Fix',
      description: '[todo 2]',
    })
    expect(nameTodo(ChildTool.Agent, { description: '', prompt: 'Go.' }, '2')).toEqual({
      description: '[todo 2]',
      prompt: 'Go.',
    })
    expect(nameTodo(ChildTool.Monitor, { description: 7 }, '2')).toEqual({ description: '[todo 2]' })
  })

  it("doesn't change the input it's given", () => {
    const input = { description: 'CI checks' }
    nameTodo(ChildTool.Monitor, input, '2')
    expect(input).toEqual({ description: 'CI checks' })
  })
})

describe('namedTodo', () => {
  it('reads back what nameTodo wrote, for every tool: the id, and the input as it was', () => {
    for (const tool of Object.values(ChildTool)) {
      const input = { [TODO_FIELDS[tool]]: 'Watch the queue', command: 'sleep 1' }
      expect(namedTodo(tool, nameTodo(tool, input, '7'))).toEqual({ todoId: '7', input })
    }
  })

  it('reads the forms the models write: a hash before the id, other case, space around it', () => {
    expect(namedTodo('Agent', { description: '[todo #3] Review the orders code' })).toEqual({
      todoId: '3',
      input: { description: 'Review the orders code' },
    })
    expect(namedTodo('Monitor', { description: '  [Todo 10]CI checks' })).toEqual({
      todoId: '10',
      input: { description: 'CI checks' },
    })
    expect(namedTodo('Bash', { description: '[todo 2]', command: 'git commit -m Fix' })).toEqual({
      todoId: '2',
      input: { description: '', command: 'git commit -m Fix' },
    })
  })

  it('finds no todo in a call that names none', () => {
    expect(namedTodo('Agent', { description: 'Review the date helpers' })).toBeNull()
    // Only at the start of the text.
    expect(namedTodo('Agent', { description: 'Review [todo 2] the date helpers' })).toBeNull()
    // Only an id Claude Code could have given: digits.
    expect(namedTodo('Agent', { description: '[todo two] Review the date helpers' })).toBeNull()
    expect(namedTodo('Agent', { description: '[todo] Review the date helpers' })).toBeNull()
    // Only in the tool's own field: an `Agent` call's prompt, or a `CronCreate` call's description, isn't it.
    expect(namedTodo('Agent', { description: 'Review', prompt: '[todo 2] Review the date helpers' })).toBeNull()
    expect(namedTodo('CronCreate', { description: '[todo 2] Check', prompt: 'Check the queue.' })).toBeNull()
    expect(namedTodo('ScheduleWakeup', { prompt: '[todo 2] Check the rollout.' })).toBeNull()
  })

  it('finds none in a call with no text there, or to a tool that makes no child', () => {
    expect(namedTodo('Bash', { command: 'git commit -m Fix' })).toBeNull()
    expect(namedTodo('Monitor', { description: 2 })).toBeNull()
    expect(namedTodo('Read', { description: '[todo 2] Read it' })).toBeNull()
    expect(namedTodo('mcp__glade__add_artifact', { description: '[todo 2] Add it' })).toBeNull()
  })
})

describe('readsTodo', () => {
  it('reads an Agent call, whoever makes it, and the agent’s own Bash call in the foreground', () => {
    const agent = { description: '[todo 2] Review the date helpers', prompt: 'Review.' }
    expect(readsTodo({ toolName: 'Agent', input: agent, subagent: false })).toBe(true)
    // A subagent's subagent works on its parent's todo unless its call names another.
    expect(readsTodo({ toolName: 'Agent', input: agent, subagent: true })).toBe(true)
    expect(readsTodo({ toolName: 'Agent', input: { ...agent, run_in_background: true }, subagent: false })).toBe(true)
    const commit = { command: 'git commit -am "Fix"', description: '[todo 2] Commit the fix' }
    expect(readsTodo({ toolName: 'Bash', input: commit, subagent: false })).toBe(true)
    expect(readsTodo({ toolName: 'Bash', input: { ...commit, run_in_background: false }, subagent: false })).toBe(true)
    expect(TODO_TOOLS).toEqual([ChildTool.Agent, ChildTool.Bash])
  })

  it('reads nothing off a watcher’s call, a subagent’s command, or any other tool', () => {
    const watchers: [string, Record<string, unknown>][] = [
      ['Monitor', { description: '[todo 3] CI checks', command: 'gh pr checks 42' }],
      ['Bash', { description: '[todo 2] Run the tests', command: 'npm test', run_in_background: true }],
      ['ScheduleWakeup', { delaySeconds: 300, reason: '[todo 3] Check CI again', prompt: 'Check.' }],
      ['CronCreate', { cron: '0 9 * * *', prompt: '[todo 3] Check the PR.' }],
    ]
    for (const [toolName, input] of watchers) {
      expect(readsTodo({ toolName, input, subagent: false })).toBe(false)
      expect(readsTodo({ toolName, input, subagent: true })).toBe(false)
    }
    // What a subagent commits follows its todo: its command is its own.
    const commit = { command: 'git commit -am "Fix"', description: '[todo 2] Commit the fix' }
    expect(readsTodo({ toolName: 'Bash', input: commit, subagent: true })).toBe(false)
    expect(readsTodo({ toolName: 'Read', input: { description: '[todo 2] Read it' }, subagent: false })).toBe(false)
    expect(readsTodo({ toolName: 'mcp__shell__Bash', input: commit, subagent: false })).toBe(false)
  })
})

describe('todoMarker', () => {
  it("is the todo's id in square brackets", () => {
    expect(todoMarker('2')).toBe('[todo 2]')
  })
})

describe('hookRefusal', () => {
  it('is what the SDK gives the agent for a call a PreToolUse hook refused', () => {
    expect(hookRefusal('Agent', 'Glade: this call must name its todo.')).toBe(
      'PreToolUse:Agent hook error: Glade: this call must name its todo.',
    )
  })
})
