// Filing a child as it's made (P16-04, #495), on a real database: what Glade does at each of the three hooks, without
// a session around it. Each test plays what the hooks say and what the runner writes for a call (its row in the tool
// log, its watcher, its commit), in the order a real session gives them.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  ArtifactKind,
  TodoState,
  ToolCallState,
  WatcherKind,
  WatcherState,
  type Artifact,
  type Task,
} from '../../shared/domain'
import { ChildKind, commitChildKey, FilingSource, type ChildRef, type TodoChildren } from '../../shared/todoHub'
import { ChildTool, nameTodo } from '../agent/child-calls'
import { addArtifact, addLinkArtifact } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { listOwedFilings } from '../db/repositories/owed-filings'
import { updateSettings } from '../db/repositories/settings'
import { addTaskCommit, CommitSource, findTaskCommit, removeTaskCommit } from '../db/repositories/task-commits'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { addWatcher } from '../db/repositories/watchers'
import { fileForAgent, NO_TODOS } from './agent-children'
import {
  ARTIFACT_NEEDS_TODO,
  artifactTodo,
  askToFile,
  createChildFiler,
  fileArtifact,
  holdToFile,
  MAX_HOLDS,
  NOTHING_ADDED,
  type ChildFiler,
} from './filing'
import { readTodoHub } from './todo-hub'

let database: TestDatabase
let db: Database
let task: Task
let events: GladeEvent[]
let filer: ChildFiler
let clock: number

const context = () => ({
  db,
  emit: (event: GladeEvent) => {
    events.push(event)
  },
})

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
  task = sampleTask(db, sampleWorkspace(db).id)
  events = []
  clock = 10_000
  updateSettings(db, { todoHubEnabled: true })
  filer = createChildFiler({ ...context(), now: () => clock })
})

afterEach(() => {
  database.close()
})

const GIT_DIR = '/code/acme-api/.git'
const REPO = '/code/acme-api'

/** A call's row in the tool log, as the runner writes it when the call streams. */
function logged(name: string, toolUseId: string, input: Record<string, unknown>, parent: string | null = null): void {
  clock += 10
  appendToolCall(db, { taskId: task.id, turn: 1, name, input, toolUseId, parentToolUseId: parent }, clock)
}

function finished(toolUseId: string, output: string): void {
  clock += 10
  updateToolCall(db, { taskId: task.id, toolUseId, state: ToolCallState.Done, output }, clock)
}

/** Adds a todo as Claude Code's `TaskCreate` does: the call's result names its id. */
function createTodo(id: string, subject: string): void {
  logged('TaskCreate', `toolu_create_${id}`, { subject })
  finished(`toolu_create_${id}`, `Task #${id} created successfully: ${subject}`)
}

function updateTodo(id: string, status: string): void {
  logged('TaskUpdate', `toolu_${status}_${id}`, { taskId: id, status })
  finished(`toolu_${status}_${id}`, `Updated task #${id} status`)
}

/** The watcher the runner makes for a call: a monitor's, a background command's, a wakeup's or a cron job's. */
function watching(toolUseId: string, label: string, parent: string | null = null, kind = WatcherKind.Monitor): void {
  clock += 10
  addWatcher(
    db,
    {
      taskId: task.id,
      kind,
      toolUseId,
      parentToolUseId: parent,
      sdkId: null,
      label,
      detail: 'gh pr checks 511 --watch',
      cron: null,
      schedule: null,
      recurring: false,
      state: WatcherState.Running,
      nextDueAt: null,
      expiresAt: null,
    },
    clock,
  )
}

/** The commit the change tracker links to a `Bash` call. */
function committed(hash: string, subject: string, toolUseId: string, committedAt = clock): ChildRef {
  addTaskCommit(db, {
    taskId: task.id,
    gitDir: GIT_DIR,
    repoPath: REPO,
    hash,
    subject,
    branch: 'main',
    committedAt,
    additions: 4,
    deletions: 1,
    filesChanged: 1,
    parents: 1,
    toolUseId,
    source: CommitSource.Printed,
  })
  return { kind: ChildKind.Commit, key: commitChildKey({ hash, repoPath: REPO }) }
}

const subagent = (toolUseId: string): ChildRef => ({ kind: ChildKind.Subagent, key: toolUseId })
const watcher = (toolUseId: string): ChildRef => ({ kind: ChildKind.Watcher, key: toolUseId })

/** The agent's own call, about to run: what the hook answers for it. */
function starting(tool: ChildTool, toolUseId: string, input: Record<string, unknown>) {
  return filer.callStarting(task.id, { toolName: tool, input, toolUseId })
}

/** A call that names `todo`, about to run. */
function named(tool: ChildTool, toolUseId: string, input: Record<string, unknown>, todo: string) {
  return starting(tool, toolUseId, nameTodo(tool, input, todo))
}

/** A group's children as `kind key source`, sorted. */
function refs(group: TodoChildren): string[] {
  return group.children.map(({ kind, key, source }) => `${kind} ${key} ${source ?? 'unfiled'}`).sort()
}

/** Each todo's children, then the placeholder's. */
function placed(): string[][] {
  const { todos, unfiled } = readTodoHub(db, task.id).children
  return [...todos.map(refs), refs(unfiled)]
}

function filings(): string[] {
  return listFilings(db, task.id).map(({ kind, key, todoId, source }) => `${kind} ${key} #${todoId} ${source}`)
}

function threeTodos(): void {
  createTodo('1', 'Review the date helpers')
  createTodo('2', 'Fix the UTC date test')
  createTodo('3', 'Watch CI on PR #511')
}

describe('a call that names its todo', () => {
  beforeEach(threeTodos)

  it('files a subagent under the todo before it exists, and runs without the marker', () => {
    const input = { description: 'Review src/dates.js', prompt: 'Review it.', subagent_type: 'Explore' }

    expect(named(ChildTool.Agent, 'toolu_agent', input, '1')).toEqual(input)

    // Filed already, by the call that will start it: it's under its todo from the moment its row is written.
    expect(filings()).toEqual(['subagent toolu_agent #1 named'])
    expect(events).toEqual([
      {
        type: EventType.FilingsChanged,
        taskId: task.id,
        filed: [
          { taskId: task.id, ...subagent('toolu_agent'), todoId: '1', source: FilingSource.Named, filedAt: 10_060 },
        ],
        removed: [],
      },
    ])
    logged('Agent', 'toolu_agent', input)
    expect(placed()).toEqual([['subagent toolu_agent named'], [], [], []])
    // Its message's calls have run: there's nothing to ask, and nothing more is written.
    events = []
    expect(filer.batchFinished(task.id, ['toolu_agent'])).toBeNull()
    expect(events).toEqual([])
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('files each kind of watcher by the call that starts it', () => {
    const monitor = { description: 'CI checks on PR #511', command: 'gh pr checks 511 --watch' }
    const command = { description: 'Integration tests', command: 'npm run test:integration', run_in_background: true }
    const wakeup = { delaySeconds: 300, reason: 'Check CI again', prompt: 'Check CI.' }
    const cron = { cron: '0 9 * * *', prompt: 'Check the PR for review comments.' }

    expect(named(ChildTool.Monitor, 'toolu_monitor', monitor, '3')).toEqual(monitor)
    expect(named(ChildTool.Bash, 'toolu_command', command, '2')).toEqual(command)
    expect(named(ChildTool.ScheduleWakeup, 'toolu_wakeup', wakeup, '3')).toEqual(wakeup)
    expect(named(ChildTool.CronCreate, 'toolu_cron', cron, '3')).toEqual(cron)

    // Filed in the same instant, so listed by their keys.
    expect(filings()).toEqual([
      'watcher toolu_command #2 named',
      'watcher toolu_cron #3 named',
      'watcher toolu_monitor #3 named',
      'watcher toolu_wakeup #3 named',
    ])
    for (const [toolUseId, label] of [
      ['toolu_monitor', 'CI checks on PR #511'],
      ['toolu_command', 'Integration tests'],
      ['toolu_wakeup', 'Check CI again'],
      ['toolu_cron', 'Check the PR for review comments.'],
    ] as const) {
      watching(toolUseId, label)
    }
    const calls = ['toolu_monitor', 'toolu_command', 'toolu_wakeup', 'toolu_cron']
    expect(filer.batchFinished(task.id, calls)).toBeNull()
    expect(placed()).toEqual([
      [],
      ['watcher toolu_command named'],
      ['watcher toolu_cron named', 'watcher toolu_monitor named', 'watcher toolu_wakeup named'],
      [],
    ])
  })

  it('reads the marker however the model writes it', () => {
    for (const [index, marker] of ['[todo 2]', '[todo #2]', '  [TODO 2]', '[Todo 2]   '].entries()) {
      const toolUseId = `toolu_${String(index)}`
      expect(starting(ChildTool.Agent, toolUseId, { description: `${marker} Review src/dates.js` })).toEqual({
        description: 'Review src/dates.js',
      })
      expect(listFilings(db, task.id).find(({ key }) => key === toolUseId)?.todoId).toBe('2')
    }
  })

  it('files a commit under the todo as the commit is found', () => {
    const input = { command: 'git commit -am "Fix the UTC date test"', description: 'Commit the fix' }

    expect(named(ChildTool.Bash, 'toolu_commit', input, '2')).toEqual(input)
    // A command in the foreground may make nothing: nothing is filed until it has.
    expect(filings()).toEqual([])

    logged('Bash', 'toolu_commit', input)
    const fix = committed('a'.repeat(40), 'Fix the UTC date test', 'toolu_commit')
    filer.commitsLinked(task.id, 'toolu_commit')

    expect(filings()).toEqual([`commit ${fix.key} #2 named`])
    events = []
    // Told again (the tracker and the hook both hear of the call), and at its message's end: nothing more to file.
    filer.commitsLinked(task.id, 'toolu_commit')
    expect(filer.batchFinished(task.id, ['toolu_commit'])).toBeNull()
    expect(events).toEqual([])
    expect(placed()).toEqual([[], [`commit ${fix.key} named`], [], []])
  })

  it('files a commit nobody told it of, and a command moved to the background, once the message has run', () => {
    const input = { command: 'npm run release', description: 'Cut the release' }
    named(ChildTool.Bash, 'toolu_release', input, '2')
    logged('Bash', 'toolu_release', input)
    // A release script that commits, and runs past its timeout: the SDK moves it to the background.
    const release = committed('b'.repeat(40), 'Release 2.4', 'toolu_release')
    watching('toolu_release', 'Cut the release', null, WatcherKind.Command)

    expect(filer.batchFinished(task.id, ['toolu_release'])).toBeNull()

    expect(placed()).toEqual([[], [`commit ${release.key} named`, 'watcher toolu_release named'], [], []])
  })

  it('leaves a commit linked to a call that named no todo for the agent to file', () => {
    starting(ChildTool.Bash, 'toolu_plain', { command: 'git commit -am "Tidy"', description: 'Commit' })
    committed('c'.repeat(40), 'Tidy', 'toolu_plain')

    filer.commitsLinked(task.id, 'toolu_plain')
    // Nor one of a call it never heard of (a subagent's).
    filer.commitsLinked(task.id, 'toolu_subagents_bash')
    filer.commitsLinked('another-task', 'toolu_plain')

    expect(filings()).toEqual([])
    expect(events).toEqual([])
  })

  it('takes back the filing of a call that made nothing: one that failed, or was refused', () => {
    named(ChildTool.Monitor, 'toolu_refused', { description: 'CI checks', command: 'gh pr checks 511' }, '3')
    named(ChildTool.Agent, 'toolu_evicted', { description: 'Review src/dates.js' }, '1')
    expect(filings()).toHaveLength(2)
    // You denied the monitor, so no task started for it; the subagent's call was evicted from the log (a retry on a
    // fallback model superseded it).
    logged('Monitor', 'toolu_refused', { description: 'CI checks', command: 'gh pr checks 511' })
    events = []

    expect(filer.batchFinished(task.id, ['toolu_refused', 'toolu_evicted'])).toBeNull()

    expect(filings()).toEqual([])
    expect(events).toEqual([
      {
        type: EventType.FilingsChanged,
        taskId: task.id,
        filed: [],
        removed: [watcher('toolu_refused'), subagent('toolu_evicted')],
      },
    ])
  })

  it('files nothing for a wakeup that only cancels the ones before it', () => {
    expect(
      named(ChildTool.ScheduleWakeup, 'toolu_stop', { stop: true, reason: 'No need to check again' }, '3'),
    ).toEqual({ stop: true, reason: 'No need to check again' })

    expect(filings()).toEqual([])
    expect(filer.batchFinished(task.id, ['toolu_stop'])).toBeNull()
  })

  it('files under a todo that is done, and three subagents of one message under three todos', () => {
    updateTodo('1', 'completed')

    named(ChildTool.Agent, 'toolu_a', { description: 'Review src/dates.js' }, '1')
    named(ChildTool.Agent, 'toolu_b', { description: 'Review src/users.js' }, '2')
    named(ChildTool.Agent, 'toolu_c', { description: 'Review src/orders.js' }, '3')
    for (const id of ['toolu_a', 'toolu_b', 'toolu_c']) logged('Agent', id, {})

    expect(filer.batchFinished(task.id, ['toolu_a', 'toolu_b', 'toolu_c'])).toBeNull()
    expect(placed()).toEqual([['subagent toolu_a named'], ['subagent toolu_b named'], ['subagent toolu_c named'], []])
  })
})

describe('a call that names no todo of the task', () => {
  beforeEach(threeTodos)

  it('goes ahead as it is, and is told of with its result', () => {
    const input = { description: 'Review src/dates.js', prompt: 'Review it.' }

    // No marker: the hook hands nothing back, and the tool runs with what the model wrote.
    expect(starting(ChildTool.Agent, 'toolu_agent', input)).toBeNull()
    expect(filings()).toEqual([])
    logged('Agent', 'toolu_agent', input)

    expect(filer.batchFinished(task.id, ['toolu_agent'])).toBe(
      [
        'Glade: file what you just made under its todo now, before your next step, with one ' +
          'mcp__glade__file_children call.',
        'Made:',
        '- c1: subagent "Review src/dates.js"',
        'Your todos: #1 Review the date helpers (pending) · #2 Fix the UTC date test (pending) · ' +
          '#3 Watch CI on PR #511 (pending)',
        'If no todo fits, create it first with TaskCreate.',
      ].join('\n'),
    )
    expect(listOwedFilings(db, task.id)).toEqual([subagent('toolu_agent')])
    // Nothing is filed by guessing, whichever todo is in progress.
    updateTodo('1', 'in_progress')
    expect(placed()).toEqual([[], [], [], ['subagent toolu_agent unfiled']])
  })

  it('counts a marker for a todo that is not there as naming none, and still takes it off', () => {
    const input = { description: 'CI checks on PR #511', command: 'gh pr checks 511 --watch' }

    expect(named(ChildTool.Monitor, 'toolu_monitor', input, '9')).toEqual(input)
    expect(filings()).toEqual([])
    watching('toolu_monitor', 'CI checks on PR #511')

    expect(filer.batchFinished(task.id, ['toolu_monitor'])).toContain('- c1: watcher "CI checks on PR #511"')
    expect(placed()).toEqual([[], [], [], ['watcher toolu_monitor unfiled']])
  })

  it('counts a marker for a deleted todo as naming none', () => {
    updateTodo('2', 'deleted')
    const input = { description: 'Review src/dates.js' }

    expect(named(ChildTool.Agent, 'toolu_agent', input, '2')).toEqual(input)
    logged('Agent', 'toolu_agent', input)

    const asked = filer.batchFinished(task.id, ['toolu_agent'])
    expect(asked).toContain('- c1: subagent "Review src/dates.js"')
    expect(asked).toContain('Your todos: #1 Review the date helpers (pending) · #3 Watch CI on PR #511 (pending)')
    expect(filings()).toEqual([])
  })

  it('tells of five children made in one message at once, each with its short id, in the order they were made', () => {
    const agent = { description: 'Review the order totals' }
    const commit = { command: 'git commit -am "Note the review"', description: 'Commit the note' }
    const monitor = { description: 'Deploy to staging', command: './deploy-status.sh' }
    const wakeup = { delaySeconds: 300, reason: 'Check the deploy', prompt: 'Check it.' }
    const calls = ['toolu_agent', 'toolu_commit', 'toolu_monitor', 'toolu_wakeup']
    for (const [toolUseId, tool, input] of [
      ['toolu_agent', ChildTool.Agent, agent],
      ['toolu_commit', ChildTool.Bash, commit],
      ['toolu_monitor', ChildTool.Monitor, monitor],
      ['toolu_wakeup', ChildTool.ScheduleWakeup, wakeup],
    ] as const) {
      expect(starting(tool, toolUseId, input)).toBeNull()
      logged(tool, toolUseId, input)
    }
    watching('toolu_monitor', 'Deploy to staging')
    watching('toolu_wakeup', 'Check the deploy', null, WatcherKind.Wakeup)
    // Two commits by the one call, in the same second: they keep the order they were made in.
    committed('d'.repeat(40), 'Note the review', 'toolu_commit', 5_000)
    committed('e'.repeat(40), 'Fix a typo in the note', 'toolu_commit', 5_000)

    const asked = filer.batchFinished(task.id, calls)

    expect(asked?.split('\n').slice(1, 7)).toEqual([
      'Made:',
      '- c1: subagent "Review the order totals"',
      '- c2: commit "ddddddd Note the review"',
      '- c3: commit "eeeeeee Fix a typo in the note"',
      '- c4: watcher "Deploy to staging"',
      '- c5: watcher "Check the deploy"',
    ])
    expect(listOwedFilings(db, task.id)).toHaveLength(5)
    // One call files them all, and nothing is owed any more.
    fileForAgent(context(), task.id, [
      { child: 'c1', todo: '1' },
      { child: 'c2', todo: '2' },
      { child: 'c3', todo: '2' },
      { child: 'c4', todo: '3' },
      { child: 'c5', todo: '3' },
    ])
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(filings().map((filing) => filing.split(' ').at(-1))).toEqual(Array(5).fill('asked'))
    expect(filer.turnEnding(task.id, false)).toBeNull()
  })

  it('asks for nothing when the calls made nothing, and when there are none', () => {
    starting(ChildTool.Bash, 'toolu_ls', { command: 'ls', description: 'List the files' })
    logged('Bash', 'toolu_ls', { command: 'ls' })

    expect(filer.batchFinished(task.id, ['toolu_ls'])).toBeNull()
    expect(filer.batchFinished(task.id, [])).toBeNull()
    // A tool that makes no child is none of its business.
    expect(
      filer.callStarting(task.id, { toolName: 'Read', input: { file_path: 'a.ts' }, toolUseId: 'toolu_read' }),
    ).toBe(null)
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])
  })

  it('tells an agent with no todo list to create a todo first', () => {
    const other = sampleTask(db, task.workspaceId)
    task = other
    starting(ChildTool.Monitor, 'toolu_monitor', { description: 'Deploy to staging', command: './deploy-status.sh' })
    watching('toolu_monitor', 'Deploy to staging')

    const asked = filer.batchFinished(task.id, ['toolu_monitor'])

    expect(asked).toBe(
      [
        'Glade: file what you just made under its todo now, before your next step, with one ' +
          'mcp__glade__file_children call.',
        'Made:',
        '- c1: watcher "Deploy to staging"',
        NO_TODOS,
      ].join('\n'),
    )
    // A marker can't name a todo either, with none to name.
    expect(named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')).toEqual({
      description: 'Review src/dates.js',
    })
    expect(filings()).toEqual([])
    expect(filer.turnEnding(task.id, false)).toBe(
      [
        "Glade: these aren't filed under a todo yet. File them with one mcp__glade__file_children call, then end " +
          'your turn.',
        '- c1: watcher "Deploy to staging"',
        NO_TODOS,
      ].join('\n'),
    )
  })

  it('has nothing to file under todos kept with TodoWrite, which have no id', () => {
    const other = sampleTask(db, task.workspaceId)
    task = other
    logged('TodoWrite', 'toolu_todos', { todos: [{ content: 'Review the date helpers', status: 'in_progress' }] })
    finished('toolu_todos', 'Todos have been modified successfully.')
    starting(ChildTool.Agent, 'toolu_agent', { description: '[todo 1] Review src/dates.js' })
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })

    expect(filer.batchFinished(task.id, ['toolu_agent'])).toContain(NO_TODOS)
    expect(filings()).toEqual([])
  })
})

describe('the end of a turn', () => {
  beforeEach(threeTodos)

  /** A subagent and a watcher the agent made without naming a todo, and was told of. */
  function twoOwed(): void {
    starting(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' })
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    starting(ChildTool.Monitor, 'toolu_monitor', { description: 'CI checks', command: 'gh pr checks 511' })
    watching('toolu_monitor', 'CI checks')
    filer.batchFinished(task.id, ['toolu_agent', 'toolu_monitor'])
  }

  const HOLD = [
    "Glade: these aren't filed under a todo yet. File them with one mcp__glade__file_children call, then end your turn.",
    '- c1: subagent "Review src/dates.js"',
    '- c2: watcher "CI checks"',
    'Your todos: #1 Review the date helpers (pending) · #2 Fix the UTC date test (pending) · ' +
      '#3 Watch CI on PR #511 (pending)',
  ].join('\n')

  it('is let through with nothing owed', () => {
    expect(filer.turnEnding(task.id, false)).toBeNull()
    named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')
    logged('Agent', 'toolu_agent', {})
    filer.batchFinished(task.id, ['toolu_agent'])

    expect(filer.turnEnding(task.id, false)).toBeNull()
  })

  it('is held while a filing is owed, twice at most, and the next turn asks again', () => {
    twoOwed()

    expect(MAX_HOLDS).toBe(2)
    expect(filer.turnEnding(task.id, false)).toBe(HOLD)
    expect(filer.turnEnding(task.id, true)).toBe(HOLD)
    // The agent ignored it twice: the turn ends, and what's left stays under "Not under a todo".
    expect(filer.turnEnding(task.id, true)).toBeNull()
    expect(filer.turnEnding(task.id, true)).toBeNull()
    expect(placed()).toEqual([[], [], [], ['subagent toolu_agent unfiled', 'watcher toolu_monitor unfiled']])

    // The end of its next turn asks again, twice more.
    expect(filer.turnEnding(task.id, false)).toBe(HOLD)
    expect(filer.turnEnding(task.id, true)).toBe(HOLD)
    expect(filer.turnEnding(task.id, true)).toBeNull()
  })

  it('is let through once the agent has filed what it was held for, and holds only for what is left', () => {
    twoOwed()
    expect(filer.turnEnding(task.id, false)).toBe(HOLD)

    fileForAgent(context(), task.id, [{ child: 'c1', todo: '1' }])
    expect(filer.turnEnding(task.id, true)).toBe(
      [HOLD.split('\n')[0], '- c2: watcher "CI checks"', HOLD.split('\n')[3]].join('\n'),
    )
    fileForAgent(context(), task.id, [{ child: 'c2', todo: '3' }])

    expect(filer.turnEnding(task.id, true)).toBeNull()
    expect(placed()).toEqual([['subagent toolu_agent asked'], [], ['watcher toolu_monitor asked'], []])
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('still asks after a relaunch: what is owed is kept, though how often the turn was held is not', () => {
    twoOwed()
    expect(filer.turnEnding(task.id, false)).toBe(HOLD)
    expect(filer.turnEnding(task.id, true)).toBe(HOLD)

    const relaunched = createChildFiler(context())

    expect(relaunched.turnEnding(task.id, false)).toBe(HOLD)
  })

  it('takes in what a message that never finished made: a turn you stopped', () => {
    starting(ChildTool.Monitor, 'toolu_monitor', { description: 'CI checks', command: 'gh pr checks 511' })
    watching('toolu_monitor', 'CI checks')
    named(ChildTool.Bash, 'toolu_commit', { command: 'git commit -am "Fix"', description: 'Commit' }, '2')
    const fix = committed('f'.repeat(40), 'Fix the UTC date test', 'toolu_commit')
    // You stopped the turn before its message's calls had all run: nothing told the agent, and the turn ended. At
    // the end of the next one, the watcher is owed, and the commit is under the todo its call named.

    expect(filer.turnEnding(task.id, false)).toContain('- c1: watcher "CI checks"')
    expect(placed()).toEqual([[], [`commit ${fix.key} named`], [], ['watcher toolu_monitor unfiled']])
  })

  it('forgets the calls of a session that is gone, and how often its turn was held', () => {
    twoOwed()
    starting(ChildTool.Monitor, 'toolu_lost', { description: 'Deploy', command: './deploy-status.sh' })
    filer.turnEnding(task.id, false)
    filer.turnEnding(task.id, true)
    expect(filer.turnEnding(task.id, true)).toBeNull()

    filer.sessionEnded(task.id)
    // The lost call's watcher, started by a session that died, is nobody's to ask about.
    watching('toolu_lost', 'Deploy')

    // What was owed before still is, and is asked for afresh.
    expect(filer.turnEnding(task.id, true)).toBe(HOLD)
  })

  it('owes nothing for a child that is gone: a commit amended away', () => {
    starting(ChildTool.Bash, 'toolu_commit', { command: 'git commit -am "Fix"', description: 'Commit' })
    committed('1'.repeat(40), 'Fix the UTC date test', 'toolu_commit')
    expect(filer.batchFinished(task.id, ['toolu_commit'])).toContain('- c1: commit "1111111 Fix the UTC date test"')
    removeTaskCommit(db, findTaskCommit(db, GIT_DIR, '1'.repeat(40))?.id ?? '')

    expect(filer.turnEnding(task.id, false)).toBeNull()
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('never asks for what the task made before the hub, or what was added with no call of the agent’s', () => {
    logged('Agent', 'toolu_before', { description: 'Review the old code' })
    watching('toolu_old', 'An old watch')
    committed('2'.repeat(40), 'An old fix', 'toolu_old_bash')
    addLinkArtifact(db, { taskId: task.id, url: 'https://example.com/acme/api/pull/511', title: 'PR #511' })
    addArtifact(db, { taskId: task.id, path: 'docs/plan.md', title: 'The plan' })

    expect(filer.turnEnding(task.id, false)).toBeNull()
    expect(placed()[3]).toHaveLength(5)
  })

  it('leaves a subagent’s children to follow the subagent: its watcher, its commit, its own subagent', () => {
    named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    // What the subagent does reaches no hook of Glade's: only the tool log, the watchers and the commits say.
    logged('Agent', 'toolu_nested', { description: 'Check the tests' }, 'toolu_agent')
    logged('Bash', 'toolu_nested_bash', { command: 'git commit -am "Fix"' }, 'toolu_nested')
    const nestedFix = committed('3'.repeat(40), 'Fix the date tests', 'toolu_nested_bash')
    watching('toolu_tests', 'The test run', 'toolu_agent')
    // The agent commits too, naming another todo.
    named(ChildTool.Bash, 'toolu_commit', { command: 'git commit -am "Fix"', description: 'Commit' }, '2')
    logged('Bash', 'toolu_commit', { command: 'git commit -am "Fix"' })
    const fix = committed('4'.repeat(40), 'Fix the UTC date test', 'toolu_commit')

    expect(filer.batchFinished(task.id, ['toolu_agent', 'toolu_commit'])).toBeNull()
    expect(filer.turnEnding(task.id, false)).toBeNull()

    expect(placed()).toEqual([
      [
        `commit ${nestedFix.key} inherited`,
        'subagent toolu_agent named',
        'subagent toolu_nested inherited',
        'watcher toolu_tests inherited',
      ],
      [`commit ${fix.key} named`],
      [],
      [],
    ])
    // Only the two the agent made have a filing of their own.
    expect(filings()).toEqual(['subagent toolu_agent #1 named', `commit ${fix.key} #2 named`])
  })
})

describe('with the hub turned off under a session that has it', () => {
  beforeEach(threeTodos)

  it('still takes a marker off, and files, asks, holds and writes nothing', () => {
    starting(ChildTool.Monitor, 'toolu_owed', { description: 'Deploy to staging', command: './deploy-status.sh' })
    watching('toolu_owed', 'Deploy to staging')
    expect(filer.batchFinished(task.id, ['toolu_owed'])).toContain('- c1: watcher')
    updateSettings(db, { todoHubEnabled: false })
    events = []
    const run: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = (sql: string) => {
      run.push(sql)
      return prepare(sql)
    }

    // The session's prompt still asks for markers, so they still come off.
    expect(named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')).toEqual({
      description: 'Review src/dates.js',
    })
    expect(starting(ChildTool.Monitor, 'toolu_ci', { description: 'CI checks', command: 'gh pr checks 511' })).toBe(
      null,
    )
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    watching('toolu_ci', 'CI checks')
    committed('9'.repeat(40), 'Fix', 'toolu_agent')
    filer.commitsLinked(task.id, 'toolu_agent')

    expect(filer.batchFinished(task.id, ['toolu_agent', 'toolu_ci'])).toBeNull()
    expect(filer.turnEnding(task.id, false)).toBeNull()

    expect(events).toEqual([])
    expect(run.filter((sql) => /child_ids|child_filings|todo_panels|owed_filings/.test(sql))).toEqual([])
    // What was owed while it was on is still there, for when it's on again; what was made meanwhile isn't asked for.
    db.prepare = prepare
    updateSettings(db, { todoHubEnabled: true })
    expect(filer.turnEnding(task.id, false)).toContain('- c1: watcher "Deploy to staging"')
    expect(filer.turnEnding(task.id, true)).not.toContain('CI checks')
  })
})

describe('what Glade tells the agent', () => {
  const todos = [
    { id: '1', text: 'Review src/dates.js for bugs', state: TodoState.Doing, note: null, completedAt: null },
    { id: '4', text: 'Fix README.md heading typo and commit', state: TodoState.Todo, note: null, completedAt: null },
  ]
  const made = [
    { ...subagent('toolu_a'), id: 'c1', title: 'Review src/dates.js for bugs', follows: null },
    { ...subagent('toolu_b'), id: 'c2', title: 'Review src/users.js for bugs', follows: null },
  ]

  it('is worded as the probes ran it, after a call and at the end of a turn', () => {
    // docs/sdk-notes.md §16, "Telling the agent after the call" and "Holding the end of the turn".
    expect(askToFile(made, todos)).toBe(
      [
        'Glade: file what you just made under its todo now, before your next step, with one ' +
          'mcp__glade__file_children call.',
        'Made:',
        '- c1: subagent "Review src/dates.js for bugs"',
        '- c2: subagent "Review src/users.js for bugs"',
        'Your todos: #1 Review src/dates.js for bugs (in progress) · #4 Fix README.md heading typo and commit (pending)',
        'If no todo fits, create it first with TaskCreate.',
      ].join('\n'),
    )
    expect(holdToFile(made, todos)).toBe(
      [
        "Glade: these aren't filed under a todo yet. File them with one mcp__glade__file_children call, then end " +
          'your turn.',
        '- c1: subagent "Review src/dates.js for bugs"',
        '- c2: subagent "Review src/users.js for bugs"',
        'Your todos: #1 Review src/dates.js for bugs (in progress) · #4 Fix README.md heading typo and commit (pending)',
      ].join('\n'),
    )
  })
})

describe('an artifact’s todo', () => {
  beforeEach(threeTodos)

  const plan = (): Artifact => addArtifact(db, { taskId: task.id, path: 'docs/plan.md', title: 'The plan' })

  it('is the todo the call gives, by its id, with or without the hash', () => {
    expect(artifactTodo(db, task.id, '2')).toBe('2')
    expect(artifactTodo(db, task.id, ' #3 ')).toBe('3')
    updateTodo('1', 'completed')
    expect(artifactTodo(db, task.id, '1')).toBe('1')
  })

  it('is needed: a call without one is refused, with the task’s todos', () => {
    expect(() => artifactTodo(db, task.id, undefined)).toThrow(
      `${ARTIFACT_NEEDS_TODO} Your todos: #1 Review the date helpers (pending) · #2 Fix the UTC date test (pending) · ` +
        '#3 Watch CI on PR #511 (pending)',
    )
    const empty = sampleTask(db, task.workspaceId)
    expect(() => artifactTodo(db, empty.id, undefined)).toThrow(`${ARTIFACT_NEEDS_TODO} ${NO_TODOS}`)
  })

  it('must be in the task’s list: an unknown one and a deleted one are refused, saying which todos there are', () => {
    expect(() => artifactTodo(db, task.id, '9')).toThrow(
      `${NOTHING_ADDED} There's no todo #9 in this task's list. Your todos: #1 Review the date helpers (pending)`,
    )
    updateTodo('2', 'deleted')
    expect(() => artifactTodo(db, task.id, '2')).toThrow(
      `${NOTHING_ADDED} There's no todo #2 in this task's list. Your todos: #1 Review the date helpers (pending) · ` +
        '#3 Watch CI on PR #511 (pending)',
    )
    const empty = sampleTask(db, task.workspaceId)
    expect(() => artifactTodo(db, empty.id, '1')).toThrow(
      `${NOTHING_ADDED} There's no todo #1 in this task's list. ${NO_TODOS}`,
    )
  })

  it('files a file and a link as named, keeps a filing that is already right, and moves one declared again', () => {
    const file = plan()
    const link = addLinkArtifact(db, { taskId: task.id, url: 'https://example.com/acme/api/pull/511', title: 'PR' })
    expect(file.kind).toBe(ArtifactKind.File)

    fileArtifact(context(), task.id, file, '1', 20_000)
    fileArtifact(context(), task.id, link, '3', 20_001)
    expect(filings()).toEqual(['file docs/plan.md #1 named', 'link https://example.com/acme/api/pull/511 #3 named'])

    events = []
    // Declared again under the same todo (a rename): its filing stays as it was, and nothing is sent.
    fileArtifact(context(), task.id, file, '1', 30_000)
    expect(events).toEqual([])
    expect(listFilings(db, task.id)[0]?.filedAt).toBe(20_000)
    // Declared again under another: it moves there.
    fileArtifact(context(), task.id, file, '2', 30_000)
    expect(filings()).toContain('file docs/plan.md #2 moved')
    expect(events).toHaveLength(1)
  })

  it('files nothing while the hub is off', () => {
    updateSettings(db, { todoHubEnabled: false })

    fileArtifact(context(), task.id, plan(), '1')

    expect(listFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])
  })
})
