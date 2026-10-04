// Filing produced work as it's made (P16-04, #495), on a real database: what Glade does at each of the three hooks,
// without a session around it. Each test plays what the hooks say and what the runner writes for a call (its row in
// the tool log, its watcher, its commit), in the order a real session gives them. Commits are filed, a subagent's todo
// is recorded, and a watcher's call is left exactly as it is.
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
import {
  ChildKind,
  commitChildKey,
  FilingSource,
  subagentTodo,
  type ChildRef,
  type TodoChildren,
} from '../../shared/todoHub'
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
import { readTodoHub, taskChildren } from './todo-hub'

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

/** The agent's own call, as it's written or about to run: what Glade answers for it. */
function starting(tool: ChildTool, toolUseId: string, input: Record<string, unknown>) {
  return filer.callStarting(task.id, { toolName: tool, input, toolUseId, subagent: false })
}

/** A call of the agent's own that names `todo`. */
function named(tool: ChildTool, toolUseId: string, input: Record<string, unknown>, todo: string) {
  return starting(tool, toolUseId, nameTodo(tool, input, todo))
}

/** A subagent's own call. */
function nested(tool: ChildTool, toolUseId: string, input: Record<string, unknown>) {
  return filer.callStarting(task.id, { toolName: tool, input, toolUseId, subagent: true })
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

  it('records a subagent’s todo before the subagent exists, and runs without the marker', () => {
    const input = { description: 'Review src/dates.js', prompt: 'Review it.', subagent_type: 'Explore' }

    expect(named(ChildTool.Agent, 'toolu_agent', input, '1')).toEqual(input)

    // Recorded already, by the call that will start it.
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
    // It can be read back: the todo the subagent works on.
    expect(subagentTodo(taskChildren(db, task.id), 'toolu_agent')).toBe('1')
    // Its message's calls have run: there's nothing to ask, and nothing more is written.
    events = []
    expect(filer.batchFinished(task.id, ['toolu_agent'])).toBeNull()
    expect(events).toEqual([])
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('reads the marker however the model writes it, and only once for a call told of twice', () => {
    for (const [index, marker] of ['[todo 2]', '[todo #2]', '  [TODO 2]', '[Todo 2]   '].entries()) {
      const toolUseId = `toolu_${String(index)}`
      expect(starting(ChildTool.Agent, toolUseId, { description: `${marker} Review src/dates.js` })).toEqual({
        description: 'Review src/dates.js',
      })
      expect(listFilings(db, task.id).find(({ key }) => key === toolUseId)?.todoId).toBe('2')
    }
    // As it streams, then as it's about to run: the marker comes off both times, and it's filed once.
    events = []
    expect(starting(ChildTool.Agent, 'toolu_0', { description: '[todo 2] Review src/dates.js' })).toEqual({
      description: 'Review src/dates.js',
    })
    expect(events).toEqual([])
  })

  it('files a commit under the todo as the commit is found', () => {
    const input = { command: 'git commit -am "Fix the UTC date test"', description: 'Commit the fix' }

    expect(named(ChildTool.Bash, 'toolu_commit', input, '2')).toEqual(input)
    // A command may commit nothing: nothing is filed until it has.
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

  it('files a commit nobody told it of once the message has run: one a release script made', () => {
    const input = { command: 'npm run release', description: 'Cut the release' }
    named(ChildTool.Bash, 'toolu_release', input, '2')
    logged('Bash', 'toolu_release', input)
    // A release script that commits, and runs past its timeout: the SDK moves it to the background, as a watcher.
    const release = committed('b'.repeat(40), 'Release 2.4', 'toolu_release')
    watching('toolu_release', 'Cut the release', null, WatcherKind.Command)

    expect(filer.batchFinished(task.id, ['toolu_release'])).toBeNull()

    // The commit is under its todo; the watcher it became isn't filed.
    expect(filings()).toEqual([`commit ${release.key} #2 named`])
    expect(placed()).toEqual([[], [`commit ${release.key} named`], [], ['watcher toolu_release unfiled']])
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

  it('takes back the todo of a subagent that never started: a call that failed, or was refused', () => {
    named(ChildTool.Agent, 'toolu_refused', { description: 'Review src/dates.js' }, '1')
    named(ChildTool.Bash, 'toolu_failed', { command: 'git commit -am "Fix"', description: 'Commit' }, '2')
    expect(filings()).toEqual(['subagent toolu_refused #1 named'])
    // The `Agent` call's row was evicted from the log (a retry on a fallback model superseded it), and the command
    // committed nothing.
    logged('Bash', 'toolu_failed', { command: 'git commit -am "Fix"' })
    events = []

    expect(filer.batchFinished(task.id, ['toolu_refused', 'toolu_failed'])).toBeNull()

    expect(filings()).toEqual([])
    expect(events).toEqual([
      { type: EventType.FilingsChanged, taskId: task.id, filed: [], removed: [subagent('toolu_refused')] },
    ])
  })

  it('files under a todo that is done, and three subagents of one message under three todos', () => {
    updateTodo('1', 'completed')

    named(ChildTool.Agent, 'toolu_a', { description: 'Review src/dates.js' }, '1')
    named(ChildTool.Agent, 'toolu_b', { description: 'Review src/users.js' }, '2')
    named(ChildTool.Agent, 'toolu_c', { description: 'Review src/orders.js' }, '3')
    for (const id of ['toolu_a', 'toolu_b', 'toolu_c']) logged('Agent', id, {})

    expect(filer.batchFinished(task.id, ['toolu_a', 'toolu_b', 'toolu_c'])).toBeNull()
    expect(placed()).toEqual([['subagent toolu_a named'], ['subagent toolu_b named'], ['subagent toolu_c named'], []])
    const children = taskChildren(db, task.id)
    expect(['toolu_a', 'toolu_b', 'toolu_c'].map((id) => subagentTodo(children, id))).toEqual(['1', '2', '3'])
  })
})

describe('a watcher’s call', () => {
  beforeEach(threeTodos)

  const WATCHERS = [
    [ChildTool.Monitor, 'toolu_monitor', { description: '[todo 3] CI checks on PR #511', command: 'gh pr checks 511' }],
    [
      ChildTool.Bash,
      'toolu_command',
      { description: '[todo 2] Integration tests', command: 'npm run test:integration', run_in_background: true },
    ],
    [
      ChildTool.ScheduleWakeup,
      'toolu_wakeup',
      { delaySeconds: 300, reason: '[todo 3] Check CI again', prompt: 'Check.' },
    ],
    [ChildTool.CronCreate, 'toolu_cron', { cron: '0 9 * * *', prompt: '[todo 3] Check the PR for review comments.' }],
  ] as const

  it('is left exactly as it is: no marker read or taken off, nothing filed, nothing asked, no hold', () => {
    for (const [tool, toolUseId, input] of WATCHERS) {
      // Whatever its text starts with, it's the model's own: Glade hands nothing back in its place.
      expect(starting(tool, toolUseId, input)).toBeNull()
      expect(nested(tool, toolUseId, input)).toBeNull()
      watching(toolUseId, String(Object.values(input)[0]))
    }
    const calls = WATCHERS.map(([, toolUseId]) => toolUseId)

    expect(filer.batchFinished(task.id, calls)).toBeNull()
    expect(filer.turnEnding(task.id, false)).toBeNull()

    expect(filings()).toEqual([])
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])
    expect(placed()[3]).toHaveLength(4)
  })

  it('is never asked about beside a subagent and a commit that are', () => {
    starting(ChildTool.Agent, 'toolu_agent', { description: 'Review the order totals' })
    logged('Agent', 'toolu_agent', { description: 'Review the order totals' })
    starting(ChildTool.Monitor, 'toolu_deploy', { description: 'Deploy to staging', command: './deploy-status.sh' })
    watching('toolu_deploy', 'Deploy to staging')

    const asked = filer.batchFinished(task.id, ['toolu_agent', 'toolu_deploy'])

    expect(asked).toContain('- c1: subagent "Review the order totals"')
    expect(asked).not.toContain('Deploy to staging')
    expect(listOwedFilings(db, task.id)).toEqual([subagent('toolu_agent')])
    expect(filer.turnEnding(task.id, false)).not.toContain('Deploy to staging')
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
    expect(subagentTodo(taskChildren(db, task.id), 'toolu_agent')).toBeNull()
  })

  it('counts a marker for a todo that is not there as naming none, and still takes it off', () => {
    const input = { command: 'git commit -am "Fix"', description: 'Commit the fix' }

    expect(named(ChildTool.Bash, 'toolu_commit', input, '9')).toEqual(input)
    committed('a'.repeat(40), 'Fix the UTC date test', 'toolu_commit')
    filer.commitsLinked(task.id, 'toolu_commit')
    expect(filings()).toEqual([])

    expect(filer.batchFinished(task.id, ['toolu_commit'])).toContain('- c1: commit "aaaaaaa Fix the UTC date test"')
    expect(placed()[3]).toHaveLength(1)
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

  it('tells of five commits made in one message at once, each with its short id, in the order they were made', () => {
    const calls = ['toolu_notes', 'toolu_fix', 'toolu_release']
    for (const toolUseId of calls) {
      expect(starting(ChildTool.Bash, toolUseId, { command: 'git commit -am "…"', description: 'Commit' })).toBeNull()
      logged('Bash', toolUseId, { command: 'git commit -am "…"' })
    }
    // Two by one call in the same second, which keep the order they were made in, one by the next, two by the last.
    committed('d'.repeat(40), 'Note the review', 'toolu_notes', 5_000)
    committed('e'.repeat(40), 'Fix a typo in the note', 'toolu_notes', 5_000)
    committed('f'.repeat(40), 'Fix the UTC date test', 'toolu_fix', 6_000)
    committed('1'.repeat(40), 'Bump the version', 'toolu_release', 7_000)
    committed('2'.repeat(40), 'Release 2.4', 'toolu_release', 8_000)

    const asked = filer.batchFinished(task.id, calls)

    expect(asked?.split('\n').slice(1, 7)).toEqual([
      'Made:',
      '- c1: commit "ddddddd Note the review"',
      '- c2: commit "eeeeeee Fix a typo in the note"',
      '- c3: commit "fffffff Fix the UTC date test"',
      '- c4: commit "1111111 Bump the version"',
      '- c5: commit "2222222 Release 2.4"',
    ])
    expect(listOwedFilings(db, task.id)).toHaveLength(5)
    // One call files them all, and nothing is owed any more.
    fileForAgent(
      context(),
      task.id,
      ['c1', 'c2', 'c3', 'c4', 'c5'].map((child) => ({ child, todo: '2' })),
    )
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(filings().map((filing) => filing.split(' ').at(-1))).toEqual(Array(5).fill('asked'))
    expect(filer.turnEnding(task.id, false)).toBeNull()
  })

  it('asks for nothing when the calls made nothing, and when there are none', () => {
    starting(ChildTool.Bash, 'toolu_ls', { command: 'ls', description: 'List the files' })
    logged('Bash', 'toolu_ls', { command: 'ls' })

    expect(filer.batchFinished(task.id, ['toolu_ls'])).toBeNull()
    expect(filer.batchFinished(task.id, [])).toBeNull()
    // A tool Glade reads no todo off is none of its business.
    expect(starting('Read' as ChildTool, 'toolu_read', { file_path: 'a.ts', description: '[todo 1] Read it' })).toBe(
      null,
    )
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(events).toEqual([])
  })

  it('tells an agent with no todo list to create a todo first', () => {
    const other = sampleTask(db, task.workspaceId)
    task = other
    starting(ChildTool.Bash, 'toolu_commit', { command: 'git commit -am "Fix"', description: 'Commit the fix' })
    committed('a'.repeat(40), 'Fix the UTC date test', 'toolu_commit')

    const asked = filer.batchFinished(task.id, ['toolu_commit'])

    expect(asked).toBe(
      [
        'Glade: file what you just made under its todo now, before your next step, with one ' +
          'mcp__glade__file_children call.',
        'Made:',
        '- c1: commit "aaaaaaa Fix the UTC date test"',
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
        '- c1: commit "aaaaaaa Fix the UTC date test"',
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

  /** A subagent and a commit the agent made without naming a todo, and was told of. */
  function twoOwed(): void {
    starting(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' })
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    starting(ChildTool.Bash, 'toolu_commit', { command: 'git commit -am "Fix"', description: 'Commit the fix' })
    committed('a'.repeat(40), 'Fix the UTC date test', 'toolu_commit')
    filer.batchFinished(task.id, ['toolu_agent', 'toolu_commit'])
  }

  const HOLD = [
    "Glade: these aren't filed under a todo yet. File them with one mcp__glade__file_children call, then end your turn.",
    '- c1: subagent "Review src/dates.js"',
    '- c2: commit "aaaaaaa Fix the UTC date test"',
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
    expect(placed()[3]).toHaveLength(2)

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
      [HOLD.split('\n')[0], '- c2: commit "aaaaaaa Fix the UTC date test"', HOLD.split('\n')[3]].join('\n'),
    )
    fileForAgent(context(), task.id, [{ child: 'c2', todo: '2' }])

    expect(filer.turnEnding(task.id, true)).toBeNull()
    const kinds = filings().map((filing) => filing.replace(/ a+ \S+/, ''))
    expect(kinds.sort()).toEqual(['commit #2 asked', 'subagent toolu_agent #1 asked'])
    expect(listOwedFilings(db, task.id)).toEqual([])
    expect(subagentTodo(taskChildren(db, task.id), 'toolu_agent')).toBe('1')
  })

  it('still asks after a relaunch: what is owed is kept, though how often the turn was held is not', () => {
    twoOwed()
    expect(filer.turnEnding(task.id, false)).toBe(HOLD)
    expect(filer.turnEnding(task.id, true)).toBe(HOLD)

    const relaunched = createChildFiler(context())

    expect(relaunched.turnEnding(task.id, false)).toBe(HOLD)
  })

  it('takes in what a message that never finished made: a turn you stopped', () => {
    starting(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' })
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    named(ChildTool.Bash, 'toolu_commit', { command: 'git commit -am "Fix"', description: 'Commit' }, '2')
    const fix = committed('f'.repeat(40), 'Fix the UTC date test', 'toolu_commit')
    // You stopped the turn before its message's calls had all run: nothing told the agent, and the turn ended. At
    // the end of the next one, the subagent is owed a todo, and the commit is under the todo its call named.

    expect(filer.turnEnding(task.id, false)).toContain('- c1: subagent "Review src/dates.js"')
    expect(placed()).toEqual([[], [`commit ${fix.key} named`], [], ['subagent toolu_agent unfiled']])
  })

  it('forgets the calls of a session that is gone, and how often its turn was held', () => {
    twoOwed()
    starting(ChildTool.Agent, 'toolu_lost', { description: 'Review src/users.js' })
    filer.turnEnding(task.id, false)
    filer.turnEnding(task.id, true)
    expect(filer.turnEnding(task.id, true)).toBeNull()

    filer.sessionEnded(task.id)
    // The lost call's subagent, started by a session that died, is nobody's to ask about.
    logged('Agent', 'toolu_lost', { description: 'Review src/users.js' })

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
})

describe('a subagent’s own calls', () => {
  beforeEach(threeTodos)

  it('are never asked about: its commits, and the subagents it starts, work on its todo', () => {
    named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    // The subagent starts one of its own, naming no todo, and both commit.
    expect(nested(ChildTool.Agent, 'toolu_nested', { description: 'Check the tests' })).toBeNull()
    logged('Agent', 'toolu_nested', { description: 'Check the tests' }, 'toolu_agent')
    logged('Bash', 'toolu_sub_bash', { command: 'git commit -am "Fix"' }, 'toolu_agent')
    const fix = committed('3'.repeat(40), 'Fix the date helpers', 'toolu_sub_bash')
    logged('Bash', 'toolu_nested_bash', { command: 'git commit -am "Fix"' }, 'toolu_nested')
    const nestedFix = committed('4'.repeat(40), 'Fix the date tests', 'toolu_nested_bash')
    // The tracker says of each call that its commits were linked: a subagent's are none of the filer's to file.
    filer.commitsLinked(task.id, 'toolu_sub_bash')
    filer.commitsLinked(task.id, 'toolu_nested_bash')

    expect(filer.batchFinished(task.id, ['toolu_agent'])).toBeNull()
    expect(filer.turnEnding(task.id, false)).toBeNull()

    // Only the subagent the agent started has a todo recorded: the rest follows it.
    expect(filings()).toEqual(['subagent toolu_agent #1 named'])
    expect(placed()).toEqual([
      [
        `commit ${fix.key} inherited`,
        `commit ${nestedFix.key} inherited`,
        'subagent toolu_agent named',
        'subagent toolu_nested inherited',
      ],
      [],
      [],
      [],
    ])
    const children = taskChildren(db, task.id)
    expect(subagentTodo(children, 'toolu_nested')).toBe('1')
    expect(listOwedFilings(db, task.id)).toEqual([])
  })

  it('work on another todo when the subagent’s Agent call names one, and the marker comes off', () => {
    named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    events = []

    expect(nested(ChildTool.Agent, 'toolu_nested', { description: '[todo 2] Fix the UTC test' })).toEqual({
      description: 'Fix the UTC test',
    })
    // Told of twice, as any call is: recorded once.
    expect(nested(ChildTool.Agent, 'toolu_nested', { description: '[todo 2] Fix the UTC test' })).toEqual({
      description: 'Fix the UTC test',
    })
    logged('Agent', 'toolu_nested', { description: 'Fix the UTC test' }, 'toolu_agent')
    logged('Bash', 'toolu_nested_bash', { command: 'git commit -am "Fix"' }, 'toolu_nested')
    const fix = committed('5'.repeat(40), 'Fix the UTC date test', 'toolu_nested_bash')

    expect(events).toHaveLength(1)
    expect(filings()).toEqual(['subagent toolu_agent #1 named', 'subagent toolu_nested #2 named'])
    const children = taskChildren(db, task.id)
    expect(subagentTodo(children, 'toolu_agent')).toBe('1')
    expect(subagentTodo(children, 'toolu_nested')).toBe('2')
    // What it commits follows it there.
    expect(placed()[1]).toEqual([`commit ${fix.key} inherited`, 'subagent toolu_nested named'])
    expect(filer.turnEnding(task.id, false)).toBeNull()
  })

  it('stay on the parent’s todo when the marker names a todo that is not there, and its Bash calls are left alone', () => {
    named(ChildTool.Agent, 'toolu_agent', { description: 'Review src/dates.js' }, '1')
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })

    // The marker still comes off: it shows nowhere.
    expect(nested(ChildTool.Agent, 'toolu_nested', { description: '[todo 9] Check the tests' })).toEqual({
      description: 'Check the tests',
    })
    logged('Agent', 'toolu_nested', { description: 'Check the tests' }, 'toolu_agent')
    // A subagent's command is its own, marker or no marker: nothing is read off it.
    expect(nested(ChildTool.Bash, 'toolu_sub_bash', { command: 'git commit', description: '[todo 2] Commit' })).toBe(
      null,
    )

    expect(filings()).toEqual(['subagent toolu_agent #1 named'])
    expect(subagentTodo(taskChildren(db, task.id), 'toolu_nested')).toBe('1')
    expect(listOwedFilings(db, task.id)).toEqual([])
  })
})

describe('with the hub turned off under a session that has it', () => {
  beforeEach(threeTodos)

  it('still takes a marker off, and files, asks, holds and writes nothing', () => {
    starting(ChildTool.Agent, 'toolu_owed', { description: 'Review src/users.js' })
    logged('Agent', 'toolu_owed', { description: 'Review src/users.js' })
    expect(filer.batchFinished(task.id, ['toolu_owed'])).toContain('- c1: subagent')
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
    expect(nested(ChildTool.Agent, 'toolu_nested', { description: '[todo 2] Check the tests' })).toEqual({
      description: 'Check the tests',
    })
    expect(starting(ChildTool.Agent, 'toolu_other', { description: 'Review src/orders.js' })).toBe(null)
    logged('Agent', 'toolu_agent', { description: 'Review src/dates.js' })
    logged('Agent', 'toolu_other', { description: 'Review src/orders.js' })
    committed('9'.repeat(40), 'Fix', 'toolu_agent')
    filer.commitsLinked(task.id, 'toolu_agent')

    expect(filer.batchFinished(task.id, ['toolu_agent', 'toolu_other'])).toBeNull()
    expect(filer.turnEnding(task.id, false)).toBeNull()

    expect(events).toEqual([])
    expect(run.filter((sql) => /child_ids|child_filings|todo_panels|owed_filings/.test(sql))).toEqual([])
    // What was owed while it was on is still there, for when it's on again; what was made meanwhile isn't asked for.
    db.prepare = prepare
    updateSettings(db, { todoHubEnabled: true })
    expect(filer.turnEnding(task.id, false)).toContain('- c1: subagent "Review src/users.js"')
    expect(filer.turnEnding(task.id, true)).not.toContain('Review src/orders.js')
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
