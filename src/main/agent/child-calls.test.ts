import { describe, expect, it } from 'vitest'
import {
  ChildTool,
  hookRefusal,
  isChildTool,
  namedTodo,
  nameTodo,
  readsTodo,
  TODO_FIELD,
  TODO_TOOLS,
  todoMarker,
} from './child-calls'

/** A watcher's call, by the tool that starts one, with a marker where a todo's would go if watchers were filed. */
const WATCHER_CALLS: [string, Record<string, unknown>][] = [
  ['Monitor', { description: '[todo 3] CI checks', command: 'gh pr checks 42' }],
  ['Bash', { description: '[todo 2] Run the tests', command: 'npm test', run_in_background: true }],
  ['ScheduleWakeup', { delaySeconds: 300, reason: '[todo 3] Check CI again', prompt: '[todo 3] Check.' }],
  ['CronCreate', { cron: '0 9 * * *', prompt: '[todo 3] Check the PR.', description: '[todo 3] Check' }],
]

describe('isChildTool', () => {
  it('knows the two tools a todo is read off, and no other: no tool that starts a watcher but Bash', () => {
    expect(Object.values(ChildTool)).toEqual(['Agent', 'mcp__glade-agents__dispatch', 'Bash'])
    expect(TODO_TOOLS).toEqual([ChildTool.Agent, ChildTool.Dispatch, ChildTool.Bash])
    for (const tool of TODO_TOOLS) expect(isChildTool(tool)).toBe(true)
    for (const tool of ['Monitor', 'ScheduleWakeup', 'CronCreate', 'Read', 'TaskCreate', 'agent', 'bash', '']) {
      expect(isChildTool(tool), tool).toBe(false)
    }
    expect(isChildTool('mcp__glade__add_artifact')).toBe(false)
  })
})

describe('nameTodo', () => {
  it('puts the marker at the start of the call’s description, and leaves the rest of the input alone', () => {
    expect(TODO_FIELD).toBe('description')
    expect(nameTodo({ description: 'Review the date helpers', prompt: 'Read src/dates.ts.' }, '2')).toEqual({
      description: '[todo 2] Review the date helpers',
      prompt: 'Read src/dates.ts.',
    })
    expect(nameTodo({ command: 'git commit -m Fix', description: 'Commit the fix' }, '12')).toEqual({
      command: 'git commit -m Fix',
      description: '[todo 12] Commit the fix',
    })
  })

  it('names the todo in a call that has no description, an empty one, or one that isn’t text', () => {
    expect(nameTodo({ command: 'git commit -m Fix' }, '2')).toEqual({
      command: 'git commit -m Fix',
      description: '[todo 2]',
    })
    expect(nameTodo({ description: '', prompt: 'Go.' }, '2')).toEqual({ description: '[todo 2]', prompt: 'Go.' })
    expect(nameTodo({ description: 7 }, '2')).toEqual({ description: '[todo 2]' })
  })

  it("doesn't change the input it's given", () => {
    const input = { description: 'Commit the fix' }
    nameTodo(input, '2')
    expect(input).toEqual({ description: 'Commit the fix' })
  })
})

describe('namedTodo', () => {
  it('reads back what nameTodo wrote, for either tool: the id, and the input as it was', () => {
    for (const tool of TODO_TOOLS) {
      const input = { description: 'Fix the UTC date test', command: 'git commit -am Fix' }
      expect(namedTodo(tool, nameTodo(input, '7'))).toEqual({ todoId: '7', input })
    }
  })

  it('reads the forms the models write: a hash before the id, other case, space around it', () => {
    expect(namedTodo('Agent', { description: '[todo #3] Review the orders code' })).toEqual({
      todoId: '3',
      input: { description: 'Review the orders code' },
    })
    expect(namedTodo('Agent', { description: '  [Todo 10]Review the orders code' })).toEqual({
      todoId: '10',
      input: { description: 'Review the orders code' },
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
    // Only in the description: an `Agent` call's prompt, or a `Bash` call's command, isn't it.
    expect(namedTodo('Agent', { description: 'Review', prompt: '[todo 2] Review the date helpers' })).toBeNull()
    expect(namedTodo('Bash', { description: 'Commit', command: '[todo 2] git commit' })).toBeNull()
  })

  it('finds none in a call with no text there, or to a tool no todo is read off, a watcher’s among them', () => {
    expect(namedTodo('Bash', { command: 'git commit -m Fix' })).toBeNull()
    expect(namedTodo('Agent', { description: 2 })).toBeNull()
    expect(namedTodo('Read', { description: '[todo 2] Read it' })).toBeNull()
    expect(namedTodo('mcp__glade__add_artifact', { description: '[todo 2] Add it' })).toBeNull()
    // Whatever field its marker is in: nothing knows a watcher's tools any more.
    for (const [tool, input] of WATCHER_CALLS.filter(([name]) => name !== 'Bash')) {
      expect(namedTodo(tool, input), tool).toBeNull()
    }
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
  })

  it('reads nothing off a watcher’s call, a subagent’s command, or any other tool', () => {
    for (const [toolName, input] of WATCHER_CALLS) {
      expect(readsTodo({ toolName, input, subagent: false }), toolName).toBe(false)
      expect(readsTodo({ toolName, input, subagent: true }), toolName).toBe(false)
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
