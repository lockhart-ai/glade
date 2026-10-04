// The agent's side of the todo hub, on a real database: what `list_children` names to it, and what `file_children`
// files, moves and refuses. Each test is a task that made children before anything filed them, as every task is until
// its agent sorts it. A todo holds produced work only (#535): a subagent is named only while it has no todo, and a
// watcher never is.
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { ArtifactKind, TodoState, ToolCallState, WatcherKind, WatcherState, type Task } from '../../shared/domain'
import {
  ChildKind,
  commitChildKey,
  FilingSource,
  subagentTodo,
  subagentTodos,
  TODO_HUB_OFF,
  UNFILED_TODO_ID,
  type ChildRef,
  type TodoChildren,
} from '../../shared/todoHub'
import { addArtifact, addLinkArtifact, removeArtifact } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { updateSettings } from '../db/repositories/settings'
import { addTaskCommit, CommitSource } from '../db/repositories/task-commits'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { addWatcher } from '../db/repositories/watchers'
import {
  CHILD_TITLE_MAX,
  childLabel,
  filedText,
  fileForAgent,
  filingTodos,
  LIST_FOR_IDS,
  listForAgent,
  listingText,
  nameSome,
  NO_TODO,
  NO_TODOS,
  NOTHING_FILED,
  todoLabel,
  todosLine,
  todoStatus,
  WATCHERS_NOT_FILED,
  type FilingOutcome,
  type FilingRequest,
} from './agent-children'
import { fileChildren, readTodoHub, taskChildren } from './todo-hub'

let database: TestDatabase
let db: Database
let task: Task
let events: GladeEvent[]

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
})

afterEach(() => {
  database.close()
})

function turnOn(): void {
  updateSettings(db, { todoHubEnabled: true })
}

/** A call of the agent's (or of the subagent `parent`), logged at `at`. */
function call(
  name: string,
  toolUseId: string,
  input: Record<string, unknown>,
  at: number,
  parent: string | null = null,
) {
  return appendToolCall(db, { taskId: task.id, turn: 1, name, input, toolUseId, parentToolUseId: parent }, at)
}

function finish(toolUseId: string, output: string, at: number): void {
  updateToolCall(db, { taskId: task.id, toolUseId, state: ToolCallState.Done, output }, at)
}

/** Adds a todo as Claude Code's `TaskCreate` does: the call's result names its id. */
function createTodo(id: string, subject: string, at: number): void {
  call('TaskCreate', `toolu_create_${id}`, { subject }, at)
  finish(`toolu_create_${id}`, `Task #${id} created successfully: ${subject}`, at)
}

function updateTodo(id: string, status: string, at: number): void {
  call('TaskUpdate', `toolu_${status}_${id}`, { taskId: id, status }, at)
  finish(`toolu_${status}_${id}`, `Updated task #${id} status`, at)
}

function monitor(toolUseId: string, label: string, parent: string | null, at: number) {
  return addWatcher(
    db,
    {
      taskId: task.id,
      kind: WatcherKind.Monitor,
      toolUseId,
      parentToolUseId: parent,
      sdkId: null,
      label,
      detail: 'gh pr checks 511',
      cron: null,
      schedule: null,
      recurring: true,
      state: WatcherState.Running,
      nextDueAt: null,
      expiresAt: null,
    },
    at,
  )
}

function commit(hash: string, subject: string, bashToolUseId: string | null, committedAt: number): void {
  addTaskCommit(db, {
    taskId: task.id,
    gitDir: '/code/acme-api/.git',
    repoPath: '/code/acme-api',
    hash,
    subject,
    branch: 'main',
    committedAt,
    additions: 4,
    deletions: 1,
    filesChanged: 1,
    parents: 1,
    toolUseId: bashToolUseId,
    source: CommitSource.Printed,
  })
}

const FIX_HASH = 'abc1234d5e6f708192a3b4c5d6e7f8091a2b3c4d'
const NESTED_HASH = 'def4567a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e'
const TIDY_HASH = '1112223a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e'

const PLAN: ChildRef = { kind: ChildKind.File, key: 'docs/plan.md' }
const PR: ChildRef = { kind: ChildKind.Link, key: 'https://example.com/acme/api/pull/511' }
const REVIEWER: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_agent' }
const NESTED: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_nested' }
/** The calls that started the task's two watchers. A watcher is no child: it has no `ChildRef`. */
const CI_CALL = 'toolu_monitor'
const NESTED_CI_CALL = 'toolu_nested_monitor'
const FIX: ChildRef = { kind: ChildKind.Commit, key: commitChildKey({ hash: FIX_HASH, repoPath: '/code/acme-api' }) }
const NESTED_FIX: ChildRef = {
  kind: ChildKind.Commit,
  key: commitChildKey({ hash: NESTED_HASH, repoPath: '/code/acme-api' }),
}
const TIDY: ChildRef = { kind: ChildKind.Commit, key: commitChildKey({ hash: TIDY_HASH, repoPath: '/code/acme-api' }) }

/**
 * A task that made one of everything before the hub, so none of it is filed: three todos, a file and a link, a
 * subagent with a subagent of its own, a commit by the agent and one by the nested subagent, and (what the hub
 * doesn't hold) a watcher the agent started and one the nested subagent left running. First named, its children are
 * c1 to c6: the file, the link, the two subagents, then the commits, oldest first (the nested subagent's, then the
 * agent's).
 */
function busyTask(): void {
  createTodo('1', 'Plan the move', 3_000)
  createTodo('2', 'Review the date helpers', 3_010)
  createTodo('3', 'Watch CI on PR #511', 3_020)
  updateTodo('1', 'completed', 3_100)
  updateTodo('2', 'in_progress', 3_200)
  addArtifact(db, { taskId: task.id, path: PLAN.key, title: 'The plan' }, 4_000)
  addLinkArtifact(db, { taskId: task.id, url: PR.key, title: 'PR #511' }, 4_100)
  call('Agent', REVIEWER.key, { description: 'Review src/dates.js' }, 5_000)
  call('Agent', NESTED.key, { description: 'Check the tests' }, 5_100, REVIEWER.key)
  call('Bash', 'toolu_nested_bash', { command: 'git commit -am "Fix"' }, 5_200, NESTED.key)
  finish('toolu_nested_bash', '[main def4567] Fix the date tests', 5_300)
  finish(NESTED.key, 'The tests pass.', 5_500)
  call('Bash', 'toolu_bash', { command: 'git commit -am "Fix"' }, 6_000)
  finish('toolu_bash', '[main abc1234] Fix the date helpers', 6_100)
  monitor(CI_CALL, 'CI on PR #511', null, 7_000)
  monitor(NESTED_CI_CALL, 'The test run', NESTED.key, 7_100)
  commit(FIX_HASH, 'Fix the date helpers', 'toolu_bash', 6_050)
  commit(NESTED_HASH, 'Fix the date tests', 'toolu_nested_bash', 5_250)
}

const ref = ({ kind, key }: ChildRef): string => `${kind} ${key}`

/** A group's children as `kind key`, sorted, so a test reads which are there whatever their order. */
function refs(group: TodoChildren | undefined): string[] {
  return (group?.children ?? []).map(ref).sort()
}

/** Each todo's children, then the placeholder's. */
function placed(): string[][] {
  const { todos, unfiled } = readTodoHub(db, task.id).children
  return [...todos.map(refs), refs(unfiled)]
}

function list(under?: string): string {
  return listingText(listForAgent(db, task.id, under))
}

function file(requests: readonly FilingRequest[], now = 9_000): FilingOutcome {
  return fileForAgent(context(), task.id, requests, now)
}

/** What a refused call threw: its code and its message. */
function refusal(run: () => unknown): { code: BridgeErrorCode; message: string } {
  try {
    run()
  } catch (error) {
    const { code, message } = error as { code: BridgeErrorCode; message: string }
    return { code, message }
  }
  throw new Error('Expected the call to be refused')
}

/** How many rows the hub's two tables for a task's children hold. */
function rows(table: 'child_ids' | 'child_filings'): number {
  return Number(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get())
}

const TODOS =
  'Your todos: #1 Plan the move (completed) · #2 Review the date helpers (in progress) · #3 Watch CI on PR #511 (pending)'

describe('how Glade names a todo and a child to the agent', () => {
  it('says a todo’s state in Claude Code’s own words', () => {
    expect(Object.values(TodoState).map(todoStatus)).toEqual(['pending', 'in progress', 'completed', 'waiting'])
  })

  it('writes a todo as its id, its text and its state, and a list of them on one line', () => {
    busyTask()
    turnOn()
    const todos = filingTodos(taskChildren(db, task.id).todos)

    expect(todos.map(todoLabel)).toEqual([
      '#1 Plan the move (completed)',
      '#2 Review the date helpers (in progress)',
      '#3 Watch CI on PR #511 (pending)',
    ])
    expect(todosLine(todos)).toBe(TODOS)
    expect(todosLine([])).toBe(NO_TODOS)
  })

  it('leaves out a todo with no id, the placeholder’s id, and the second of two sharing an id', () => {
    const todo = { text: 'Plan', state: TodoState.Todo, note: null, completedAt: null }

    expect(
      filingTodos([
        { ...todo, id: null },
        { ...todo, id: UNFILED_TODO_ID },
        { ...todo, id: '4' },
        { ...todo, id: '4', text: 'A copy' },
        { ...todo, id: '7' },
      ]).map(({ id, text }) => [id, text]),
    ).toEqual([
      ['4', 'Plan'],
      ['7', 'Plan'],
    ])
  })

  it('writes a child as its short id, its kind and its title', () => {
    expect(childLabel({ id: 'c3', kind: ChildKind.Subagent, key: 'toolu_agent', title: 'Review', follows: null })).toBe(
      'c3: subagent "Review"',
    )
  })
})

describe('list_children', () => {
  it('is refused while the hub is off, and names nothing', () => {
    busyTask()

    expect(refusal(() => list())).toEqual({ code: BridgeErrorCode.InvalidTransition, message: TODO_HUB_OFF })
    expect(rows('child_ids')).toBe(0)
  })

  it('lists a task from before the hub: every todo, empty, then what it produced and its subagents under no todo', () => {
    busyTask()
    turnOn()

    expect(list()).toBe(
      [
        '#1 Plan the move (completed), no children',
        '#2 Review the date helpers (in progress), no children',
        '#3 Watch CI on PR #511 (pending), no children',
        'Not under a todo, 6 children:',
        '- c1: file "The plan"',
        '- c2: link "PR #511"',
        '- c3: subagent "Review src/dates.js"',
        '- c4: subagent "Check the tests" (follows c3)',
        '- c5: commit "def4567 Fix the date tests" (follows c4)',
        '- c6: commit "abc1234 Fix the date helpers"',
      ].join('\n'),
    )
    // Listing files nothing and tells the windows nothing, and no watcher got an id.
    expect(rows('child_filings')).toBe(0)
    expect(rows('child_ids')).toBe(6)
    expect(events).toEqual([])
  })

  it('never lists a watcher: the agent’s own, one a subagent left running, or one filed before watchers left the hub', () => {
    busyTask()
    turnOn()
    // As the hub wrote them then: the agent's watcher with an id and a filing under #3, the nested one's with an id.
    const id = db.prepare("INSERT INTO child_ids (task_id, number, kind, key) VALUES (?, ?, 'watcher', ?)")
    id.run(task.id, 1, CI_CALL)
    id.run(task.id, 2, NESTED_CI_CALL)
    db.prepare(
      "INSERT INTO child_filings (task_id, kind, key, todo_id, source, filed_at) VALUES (?, 'watcher', ?, '3', 'named', 8000)",
    ).run(task.id, CI_CALL)

    const listed = list()

    expect(listed).not.toMatch(/watcher/)
    expect(listed).not.toContain('The test run')
    expect(listed).not.toContain('"CI on PR #511"')
    expect(listed.split('\n').slice(2, 5)).toEqual([
      '#3 Watch CI on PR #511 (pending), no children',
      'Not under a todo, 6 children:',
      // The ids the watchers had are never given to another child.
      '- c3: file "The plan"',
    ])
    expect(list('3')).toBe('#3 Watch CI on PR #511 (pending), no children')
    expect(list(NO_TODO)).not.toMatch(/watcher/)
  })

  it('lists a task whose only children are watchers as having none', () => {
    createTodo('1', 'Watch CI on PR #511', 3_000)
    monitor(CI_CALL, 'CI on PR #511', null, 7_000)
    monitor('toolu_deploy', 'Staging deploy', null, 7_100)
    turnOn()

    expect(list()).toBe('#1 Watch CI on PR #511 (pending), no children\nNot under a todo, no children')
    expect(list(NO_TODO)).toBe('Not under a todo, no children')
    expect(rows('child_ids')).toBe(0)
  })

  it('lists each child under its todo once filed; a subagent that has its todo isn’t listed, and its commits are', () => {
    busyTask()
    turnOn()
    list()
    file([
      { child: 'c1', todo: '1' },
      { child: 'c3', todo: '2' },
      { child: 'c2', todo: '3' },
    ])

    expect(list()).toBe(
      [
        '#1 Plan the move (completed), 1 child:',
        '- c1: file "The plan"',
        // What the reviewer's own subagent committed: both work on #2 now, and neither is listed.
        '#2 Review the date helpers (in progress), 1 child:',
        '- c5: commit "def4567 Fix the date tests"',
        '#3 Watch CI on PR #511 (pending), 1 child:',
        '- c2: link "PR #511"',
        'Not under a todo, 1 child:',
        '- c6: commit "abc1234 Fix the date helpers"',
      ].join('\n'),
    )
  })

  it('lists a subagent with commits and a watcher as its commits alone, under the todo it was started for', () => {
    createTodo('1', 'Plan the move', 3_000)
    createTodo('2', 'Review the date helpers', 3_010)
    call('Agent', REVIEWER.key, { description: 'Review src/dates.js' }, 5_000)
    call('Bash', 'toolu_first', { command: 'git commit -am "Fix"' }, 5_100, REVIEWER.key)
    call('Bash', 'toolu_second', { command: 'git commit -am "Test"' }, 5_300, REVIEWER.key)
    commit(NESTED_HASH, 'Fix the date tests', 'toolu_first', 5_150)
    commit(FIX_HASH, 'Fix the date helpers', 'toolu_second', 5_350)
    monitor(NESTED_CI_CALL, 'The test run', REVIEWER.key, 5_400)
    turnOn()
    // As Glade records it when the `Agent` call names its todo.
    fileChildren(context(), task.id, [{ ...REVIEWER, todoId: '2', source: FilingSource.Named }], 5_000)

    expect(list()).toBe(
      [
        '#1 Plan the move (pending), no children',
        '#2 Review the date helpers (pending), 2 children:',
        '- c1: commit "def4567 Fix the date tests"',
        '- c2: commit "abc1234 Fix the date helpers"',
        'Not under a todo, no children',
      ].join('\n'),
    )
    // The subagent was never named to the agent, so it has no id; its todo is the filing Glade made.
    expect(rows('child_ids')).toBe(2)
    expect(subagentTodo(taskChildren(db, task.id), REVIEWER.key)).toBe('2')
  })

  it('narrows to one todo, by its id with or without a #, and to the ones under no todo', () => {
    busyTask()
    turnOn()
    list()
    file([{ child: 'c1', todo: '1' }])

    expect(list('1')).toBe('#1 Plan the move (completed), 1 child:\n- c1: file "The plan"')
    expect(list(' #1 ')).toBe(list('1'))
    expect(list('2')).toBe('#2 Review the date helpers (in progress), no children')
    expect(list(NO_TODO).split('\n')).toEqual([
      'Not under a todo, 5 children:',
      '- c2: link "PR #511"',
      '- c3: subagent "Review src/dates.js"',
      '- c4: subagent "Check the tests" (follows c3)',
      '- c5: commit "def4567 Fix the date tests" (follows c4)',
      '- c6: commit "abc1234 Fix the date helpers"',
    ])
  })

  it('refuses a todo that isn’t in the list, saying which are', () => {
    busyTask()
    turnOn()

    expect(refusal(() => list('9'))).toEqual({
      code: BridgeErrorCode.NotFound,
      message: `There's no todo #9 in this task's list. ${TODOS}`,
    })
    // The placeholder's own id is no todo's.
    expect(refusal(() => list(UNFILED_TODO_ID)).message).toMatch(/^There's no todo #unfiled/)
  })

  it('lists a task with no todos as the ones under no todo alone, and one that made nothing as none', () => {
    turnOn()

    expect(list()).toBe('Not under a todo, no children')
    expect(refusal(() => list('1')).message).toBe(`There's no todo #1 in this task's list. ${NO_TODOS}`)

    addArtifact(db, { taskId: task.id, path: PLAN.key, title: 'The plan' }, 4_000)
    expect(list()).toBe('Not under a todo, 1 child:\n- c1: file "The plan"')
  })

  it('can file nothing under a TodoWrite item, which has no id: it gets no group', () => {
    call(
      'TodoWrite',
      'toolu_write',
      { todos: [{ content: 'Plan the move', status: 'pending', activeForm: '' }] },
      3_000,
    )
    finish('toolu_write', 'Todos have been modified successfully', 3_000)
    addArtifact(db, { taskId: task.id, path: PLAN.key, title: 'The plan' }, 4_000)
    turnOn()

    expect(list()).toBe('Not under a todo, 1 child:\n- c1: file "The plan"')
    expect(refusal(() => file([{ child: 'c1', todo: '1' }])).message).toBe(
      `${NOTHING_FILED} There's no todo #1 in this task's list. ${NO_TODOS}`,
    )
  })

  it('keeps a child’s id for good: a second listing, a new child and a removed one change no one else’s', () => {
    busyTask()
    turnOn()
    const first = list()

    expect(list()).toBe(first)

    // A new file gets the next number, though files are named first; the removed link's number is never used again.
    addArtifact(db, { taskId: task.id, path: 'docs/notes.md', title: 'Notes' }, 8_000)
    removeArtifact(db, task.id, { kind: ArtifactKind.Link, url: PR.key })
    const later = list().split('\n')

    expect(later).toContain('- c7: file "Notes"')
    expect(later).not.toContain('- c2: link "PR #511"')
    expect(later.filter((line) => line.startsWith('- '))).toHaveLength(6)
    expect(later.slice(4, 6)).toEqual(['- c1: file "The plan"', '- c3: subagent "Review src/dates.js"'])
  })

  it('lists a subagent again, with the id it had, once the todo it worked on is deleted', () => {
    busyTask()
    turnOn()
    list()
    file([{ child: 'c3', todo: '3' }], 9_000)
    expect(list()).not.toMatch(/subagent/)

    updateTodo('3', 'deleted', 9_100)

    expect(list(NO_TODO).split('\n').slice(0, 4)).toEqual([
      'Not under a todo, 6 children:',
      '- c1: file "The plan"',
      '- c2: link "PR #511"',
      '- c3: subagent "Review src/dates.js"',
    ])
  })

  it('gives each child a title a person would know it by, on one line, cut when it runs long', () => {
    turnOn()
    const long = `Review ${'the date helpers and '.repeat(8)}report`
    addArtifact(db, { taskId: task.id, path: 'docs/a.md', title: 'Release\nnotes   2.4' }, 4_000)
    call('Agent', 'toolu_typed', { subagent_type: 'Explore', prompt: 'Look around.' }, 5_000)
    call('Agent', 'toolu_bare', { prompt: 'Look around.' }, 5_010)
    call('Agent', 'toolu_long', { description: long }, 5_020)
    commit(FIX_HASH, 'Fix the\n  date helpers', 'toolu_bash', 6_050)

    const lines = list().split('\n')

    expect(lines.slice(0, 4)).toEqual([
      'Not under a todo, 5 children:',
      '- c1: file "Release notes 2.4"',
      '- c2: subagent "Explore"',
      '- c3: subagent "Subagent"',
    ])
    const title = /^- c4: subagent "(.*)"$/.exec(lines[4] ?? '')?.[1] ?? ''
    expect(title.length).toBeGreaterThan(CHILD_TITLE_MAX / 2)
    expect(title.length).toBeLessThanOrEqual(CHILD_TITLE_MAX)
    expect(title.endsWith('…')).toBe(true)
    expect(long.startsWith(title.slice(0, -1))).toBe(true)
    expect(lines[5]).toBe('- c5: commit "abc1234 Fix the date helpers"')
  })

  it('stays compact with 200 children: a line each, none over a title’s length and its id', () => {
    createTodo('1', 'Copy the files', 3_000)
    for (let index = 0; index < 200; index += 1) {
      const n = String(index + 1)
      addLinkArtifact(
        db,
        { taskId: task.id, url: `https://example.com/acme/api/pull/${n}`, title: `PR #${n}` },
        4_000 + index,
      )
    }
    turnOn()

    const lines = list().split('\n')

    expect(lines).toHaveLength(202)
    expect(lines[1]).toBe('Not under a todo, 200 children:')
    expect(lines.at(-1)).toBe('- c200: link "PR #200"')
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(CHILD_TITLE_MAX + 40)
    expect(list().length).toBeLessThan(6_000)
  })
})

describe('file_children', () => {
  it('is refused while the hub is off, with nothing filed or sent', () => {
    busyTask()
    turnOn()
    list()
    updateSettings(db, { todoHubEnabled: false })

    expect(refusal(() => file([{ child: 'c1', todo: '1' }]))).toEqual({
      code: BridgeErrorCode.InvalidTransition,
      message: TODO_HUB_OFF,
    })
    expect(rows('child_filings')).toBe(0)
    expect(events).toEqual([])
  })

  it('sorts a task whose children are all unfiled: each goes under a todo, and nothing is left under none', () => {
    busyTask()
    turnOn()
    list()

    const outcome = file([
      { child: 'c1', todo: '1' },
      { child: 'c2', todo: '3' },
      { child: 'c3', todo: '2' },
      { child: 'c6', todo: '2' },
    ])

    expect(outcome).toEqual({
      filed: [
        { id: 'c1', todoId: '1' },
        { id: 'c2', todoId: '3' },
        { id: 'c3', todoId: '2' },
        { id: 'c6', todoId: '2' },
      ],
      unchanged: [],
      // What the subagent's own subagent committed went with it. That subagent did too, which is nothing to tell.
      brought: ['c5'],
    })
    expect(filedText(outcome)).toBe(
      'Filed 4 children: c1 under #1; c2 under #3; c3, c6 under #2. Moved with their subagent: c5.',
    )
    expect(placed()).toEqual([[ref(PLAN)], [FIX, NESTED_FIX].map(ref).sort(), [ref(PR)], []])
    expect(Object.fromEntries(subagentTodos(taskChildren(db, task.id)))).toEqual({
      [REVIEWER.key]: '2',
      [NESTED.key]: '2',
    })
    expect(list(NO_TODO)).toBe('Not under a todo, no children')
    // Each had no filing of its own: the agent filed it. What followed the subagent has no row.
    const filings = listFilings(db, task.id)
    expect(filings.map(({ source }) => source)).toEqual(Array(4).fill(FilingSource.Asked))
    expect(filings.map(ref).sort()).toEqual([PLAN, PR, REVIEWER, FIX].map(ref).sort())
    // The windows hear them once, together.
    expect(events).toEqual([
      {
        type: EventType.FilingsChanged,
        taskId: task.id,
        filed: [
          { taskId: task.id, ...PLAN, todoId: '1', source: FilingSource.Asked, filedAt: 9_000 },
          { taskId: task.id, ...PR, todoId: '3', source: FilingSource.Asked, filedAt: 9_000 },
          { taskId: task.id, ...REVIEWER, todoId: '2', source: FilingSource.Asked, filedAt: 9_000 },
          { taskId: task.id, ...FIX, todoId: '2', source: FilingSource.Asked, filedAt: 9_000 },
        ],
        removed: [],
      },
    ])
  })

  it('moves a child between two todos, and tells the windows', () => {
    busyTask()
    turnOn()
    list()
    file([{ child: 'c1', todo: '1' }], 9_000)
    events.length = 0

    const outcome = file([{ child: 'c1', todo: '3' }], 9_500)

    expect(outcome).toEqual({ filed: [{ id: 'c1', todoId: '3' }], unchanged: [], brought: [] })
    expect(filedText(outcome)).toBe('Filed 1 child: c1 under #3.')
    expect(placed()[0]).toEqual([])
    expect(placed()[2]).toEqual([ref(PLAN)])
    const moved = { taskId: task.id, ...PLAN, todoId: '3', source: FilingSource.Moved, filedAt: 9_500 }
    expect(listFilings(db, task.id)).toEqual([moved])
    expect(events).toEqual([{ type: EventType.FilingsChanged, taskId: task.id, filed: [moved], removed: [] }])
  })

  it('accepts a subagent: that sets the todo it works on, and nothing shows it there', () => {
    busyTask()
    turnOn()
    list()

    const outcome = file([{ child: 'c4', todo: '3' }])

    expect(outcome).toEqual({ filed: [{ id: 'c4', todoId: '3' }], unchanged: [], brought: ['c5'] })
    expect(subagentTodo(taskChildren(db, task.id), NESTED.key)).toBe('3')
    expect(subagentTodo(taskChildren(db, task.id), REVIEWER.key)).toBeNull()
    expect(listFilings(db, task.id)).toEqual([
      { taskId: task.id, ...NESTED, todoId: '3', source: FilingSource.Asked, filedAt: 9_000 },
    ])
    // Under the todo is the commit it made, and not the subagent.
    expect(placed()[2]).toEqual([ref(NESTED_FIX)])
    expect(list('3')).toBe('#3 Watch CI on PR #511 (pending), 1 child:\n- c5: commit "def4567 Fix the date tests"')
  })

  it('brings a subagent’s commits when it’s given another todo, apart from one filed on its own', () => {
    busyTask()
    // The reviewer commits too, between its own subagent's commit and the agent's.
    call('Bash', 'toolu_reviewer_bash', { command: 'git commit -am "Tidy"' }, 5_550, REVIEWER.key)
    commit(TIDY_HASH, 'Tidy the helpers', 'toolu_reviewer_bash', 5_600)
    turnOn()
    expect(list().split('\n').slice(-3)).toEqual([
      '- c5: commit "def4567 Fix the date tests" (follows c4)',
      '- c6: commit "1112223 Tidy the helpers" (follows c3)',
      '- c7: commit "abc1234 Fix the date helpers"',
    ])
    // The reviewer works on #2, with its own subagent; that one's commit is filed apart, under #1.
    file([
      { child: 'c3', todo: '2' },
      { child: 'c5', todo: '1' },
    ])
    events.length = 0

    const outcome = file([{ child: 'c3', todo: '3' }], 9_500)

    expect(outcome).toEqual({ filed: [{ id: 'c3', todoId: '3' }], unchanged: [], brought: ['c6'] })
    expect(filedText(outcome)).toBe('Filed 1 child: c3 under #3. Moved with their subagent: c6.')
    const [first, second, third] = readTodoHub(db, task.id).children.todos
    expect(refs(first)).toEqual([ref(NESTED_FIX)])
    expect(refs(second)).toEqual([])
    expect(third?.children.map((child) => [ref(child), child.source])).toEqual([[ref(TIDY), FilingSource.Inherited]])
    // The nested subagent works on #3 too now, though nothing says so to the agent.
    expect(Object.fromEntries(subagentTodos(taskChildren(db, task.id)))).toEqual({
      [REVIEWER.key]: '3',
      [NESTED.key]: '3',
    })
    // Only the subagent's own row was rewritten, and only it is sent.
    expect(listFilings(db, task.id).map((filing) => [ref(filing), filing.todoId, filing.source])).toEqual([
      [ref(NESTED_FIX), '1', FilingSource.Asked],
      [ref(REVIEWER), '3', FilingSource.Moved],
    ])
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ filed: [{ ...REVIEWER, todoId: '3' }] })
    expect(list('3').split('\n').slice(1)).toEqual(['- c6: commit "1112223 Tidy the helpers"'])
    expect(list('1')).toBe('#1 Plan the move (completed), 1 child:\n- c5: commit "def4567 Fix the date tests"')
  })

  it('gives a nested subagent another todo than the one that made it, with what it committed', () => {
    busyTask()
    turnOn()
    list()
    file([{ child: 'c3', todo: '2' }])

    expect(file([{ child: 'c4', todo: '3' }], 9_500)).toEqual({
      filed: [{ id: 'c4', todoId: '3' }],
      unchanged: [],
      brought: ['c5'],
    })
    const [, second, third] = readTodoHub(db, task.id).children.todos
    expect(refs(second)).toEqual([])
    expect(refs(third)).toEqual([ref(NESTED_FIX)])
    expect(Object.fromEntries(subagentTodos(taskChildren(db, task.id)))).toEqual({
      [REVIEWER.key]: '2',
      [NESTED.key]: '3',
    })
    // It followed its subagent, with no filing of its own: now the agent has filed it.
    expect(listFilings(db, task.id).map(({ source }) => source)).toEqual([FilingSource.Asked, FilingSource.Asked])
  })

  it('refuses a watcher, by an id one had before watchers left the hub, saying watchers aren’t filed', () => {
    busyTask()
    turnOn()
    list()
    // As the hub named them then: the table still allows the kind.
    const id = db.prepare("INSERT INTO child_ids (task_id, number, kind, key) VALUES (?, ?, 'watcher', ?)")
    id.run(task.id, 7, CI_CALL)
    id.run(task.id, 8, NESTED_CI_CALL)

    expect(refusal(() => file([{ child: 'c7', todo: '3' }]))).toEqual({
      code: BridgeErrorCode.InvalidRequest,
      message: `${NOTHING_FILED} ${WATCHERS_NOT_FILED}: c7.`,
    })
    expect(WATCHERS_NOT_FILED).toBe("Watchers aren't filed under todos")
    // Among good filings and other mistakes: all or nothing, each said once.
    expect(
      refusal(() =>
        file([
          { child: 'c1', todo: '1' },
          { child: 'C8', todo: '3' },
          { child: 'c7', todo: '3' },
          { child: 'c7', todo: '2' },
          { child: 'c99', todo: '9' },
        ]),
      ).message,
    ).toBe(
      `${NOTHING_FILED} Not a child of this task: c99. ${WATCHERS_NOT_FILED}: c8, c7. ${LIST_FOR_IDS} ` +
        `There's no todo #9 in this task's list. ${TODOS}`,
    )
    expect(rows('child_filings')).toBe(0)
    expect(events).toEqual([])
    // A watcher the agent names some other way is no child of the task's, as anything else that isn't.
    expect(refusal(() => file([{ child: CI_CALL, todo: '3' }])).message).toBe(
      `${NOTHING_FILED} Not a child of this task: ${CI_CALL}. ${LIST_FOR_IDS}`,
    )
  })

  it('changes nothing for a bad todo id, and says which, with the todos there are', () => {
    busyTask()
    turnOn()
    list()
    file([{ child: 'c1', todo: '1' }])
    const before = listFilings(db, task.id)
    events.length = 0

    // One good filing among the bad: all or nothing.
    const refused = refusal(() =>
      file([
        { child: 'c2', todo: '3' },
        { child: 'c1', todo: '9' },
        { child: 'c5', todo: 'none' },
        { child: 'c6', todo: '9' },
      ]),
    )

    expect(refused).toEqual({
      code: BridgeErrorCode.InvalidRequest,
      message: `${NOTHING_FILED} There's no todo #9, #none in this task's list. ${TODOS}`,
    })
    expect(listFilings(db, task.id)).toEqual(before)
    expect(events).toEqual([])
  })

  it('changes nothing for a bad child key, and says which', () => {
    busyTask()
    turnOn()
    list()

    const refused = refusal(() =>
      file([
        { child: 'c1', todo: '1' },
        { child: 'c99', todo: '1' },
        { child: 'docs/plan.md', todo: '2' },
        { child: 'c0', todo: '2' },
        { child: 'c99', todo: '3' },
      ]),
    )

    expect(refused).toEqual({
      code: BridgeErrorCode.InvalidRequest,
      message: `${NOTHING_FILED} Not a child of this task: c99, docs/plan.md, c0. ${LIST_FOR_IDS}`,
    })
    expect(rows('child_filings')).toBe(0)
    expect(events).toEqual([])
    // An id it was never given names nothing, and gives no child an id.
    expect(rows('child_ids')).toBe(6)
  })

  it('says everything wrong with a call at once: unknown children, a todo that isn’t there, a child for two todos', () => {
    busyTask()
    turnOn()
    list()

    expect(
      refusal(() =>
        file([
          { child: 'c1', todo: '1' },
          { child: 'c1', todo: '2' },
          { child: 'c42', todo: '7' },
        ]),
      ).message,
    ).toBe(
      `${NOTHING_FILED} Not a child of this task: c42. Named for two todos in this call: c1. ${LIST_FOR_IDS} ` +
        `There's no todo #7 in this task's list. ${TODOS}`,
    )
    expect(rows('child_filings')).toBe(0)
  })

  it('never takes another task’s child for its own: short ids are a task’s', () => {
    busyTask()
    turnOn()
    list()
    const mine = task
    task = sampleTask(db, mine.workspaceId)
    createTodo('1', 'Plan', 3_000)

    expect(refusal(() => file([{ child: 'c1', todo: '1' }])).message).toBe(
      `${NOTHING_FILED} Not a child of this task: c1. ${LIST_FOR_IDS}`,
    )
  })

  describe('under stress', () => {
    it('leaves a child alone when it’s moved to the todo it’s already under', () => {
      busyTask()
      turnOn()
      list()
      fileChildren(context(), task.id, [{ ...PLAN, todoId: '1', source: FilingSource.Named }], 8_000)
      events.length = 0

      const outcome = file([{ child: 'c1', todo: '1' }], 9_000)

      expect(outcome).toEqual({ filed: [], unchanged: ['c1'], brought: [] })
      expect(filedText(outcome)).toBe('Nothing changed. Already there: c1.')
      // Still as it was first filed, and nobody is told.
      expect(listFilings(db, task.id)).toEqual([
        { taskId: task.id, ...PLAN, todoId: '1', source: FilingSource.Named, filedAt: 8_000 },
      ])
      expect(events).toEqual([])

      // Among others that do move, it's said apart.
      expect(
        filedText(
          file([
            { child: 'c1', todo: '1' },
            { child: 'c2', todo: '1' },
          ]),
        ),
      ).toBe('Filed 1 child: c2 under #1. Already there: c1.')
    })

    it('files a commit that only followed its subagent when it’s filed where it already shows, so it stays behind', () => {
      busyTask()
      turnOn()
      list()
      file([{ child: 'c3', todo: '2' }])

      // The nested subagent's commit shows under #2 by following; filed there, it has a filing of its own.
      expect(file([{ child: 'c5', todo: '2' }], 9_100)).toEqual({
        filed: [{ id: 'c5', todoId: '2' }],
        unchanged: [],
        brought: [],
      })
      expect(file([{ child: 'c3', todo: '3' }], 9_200).brought).toEqual([])
      expect(refs(readTodoHub(db, task.id).children.todos[1])).toEqual([ref(NESTED_FIX)])
    })

    it('counts a child named twice for the same todo once, and refuses one named for two', () => {
      busyTask()
      turnOn()
      list()

      const outcome = file([
        { child: 'c1', todo: '2' },
        { child: 'C1', todo: '#2' },
        { child: ' c1 ', todo: ' 2 ' },
      ])

      expect(outcome).toEqual({ filed: [{ id: 'c1', todoId: '2' }], unchanged: [], brought: [] })
      expect(listFilings(db, task.id)).toHaveLength(1)
      events.length = 0

      expect(
        refusal(() =>
          file([
            { child: 'c1', todo: '3' },
            { child: 'c2', todo: '3' },
            { child: 'c1', todo: '1' },
          ]),
        ).message,
      ).toBe(`${NOTHING_FILED} Named for two todos in this call: c1.`)
      expect(listFilings(db, task.id).map(({ todoId }) => todoId)).toEqual(['2'])
      expect(events).toEqual([])
    })

    it('files 200 children in one call, in one write and one event', () => {
      createTodo('1', 'Copy the files', 3_000)
      createTodo('2', 'Check the copies', 3_010)
      for (let index = 0; index < 200; index += 1) {
        const n = String(index + 1)
        addLinkArtifact(
          db,
          { taskId: task.id, url: `https://example.com/acme/api/pull/${n}`, title: `PR #${n}` },
          4_000 + index,
        )
      }
      turnOn()
      list()
      const requests = Array.from({ length: 200 }, (_, index) => ({
        child: `c${String(index + 1)}`,
        todo: index % 2 === 0 ? '1' : '2',
      }))

      const outcome = file(requests)

      expect(outcome.filed).toHaveLength(200)
      expect(filedText(outcome)).toMatch(/^Filed 200 children: c1, c3, .*c199 under #1; c2, c4, .*c200 under #2\.$/)
      expect(filedText(outcome).length).toBeLessThan(1_300)
      expect(placed().map((group) => group.length)).toEqual([100, 100, 0])
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({ type: EventType.FilingsChanged, removed: [] })
      expect(events[0]?.type === EventType.FilingsChanged ? events[0].filed.length : 0).toBe(200)

      // And one bad id among 200 files none of them.
      events.length = 0
      const moved = requests.map(({ child }) => ({ child, todo: '2' }))
      expect(refusal(() => file([...moved, { child: 'c201', todo: '2' }])).message).toBe(
        `${NOTHING_FILED} Not a child of this task: c201. ${LIST_FOR_IDS}`,
      )
      expect(placed().map((group) => group.length)).toEqual([100, 100, 0])
      expect(events).toEqual([])
    })

    it('brings the commits of 50 subagents, three deep, when the first of each chain is given another todo', () => {
      createTodo('1', 'Review every module', 3_000)
      createTodo('2', 'Fix what the reviews found', 3_010)
      for (let index = 0; index < 50; index += 1) {
        const n = String(index)
        const parent = index % 3 === 0 ? null : `toolu_agent_${String(index - 1)}`
        call('Agent', `toolu_agent_${n}`, { description: `Review module ${n}` }, 5_000 + index, parent)
        call('Bash', `toolu_bash_${n}`, { command: 'git commit -am "Fix"' }, 6_000 + index, `toolu_agent_${n}`)
        commit(`${n.padStart(4, '0')}${'ab'.repeat(18)}`, `Fix module ${n}`, `toolu_bash_${n}`, 6_000 + index)
        monitor(`toolu_watch_${n}`, `Tests of module ${n}`, `toolu_agent_${n}`, 7_000 + index)
      }
      turnOn()
      const tops = Array.from({ length: 17 }, (_, index) => ({
        kind: ChildKind.Subagent,
        key: `toolu_agent_${String(index * 3)}`,
      }))
      fileChildren(
        context(),
        task.id,
        tops.map((top) => ({ ...top, todoId: '1', source: FilingSource.Named })),
        8_000,
      )
      events.length = 0

      // Its 50 commits, under #1 with the subagents that made them: no subagent, no watcher.
      const lines = list().split('\n')
      expect(lines[0]).toBe('#1 Review every module (pending), 50 children:')
      expect(lines.slice(1, 51).every((line) => /^- c\d+: commit "/.test(line))).toBe(true)
      expect(lines.slice(51)).toEqual([
        '#2 Fix what the reviews found (pending), no children',
        'Not under a todo, no children',
      ])
      expect(rows('child_ids')).toBe(50)

      // The agent is asked to say which todo the first chain is for, as Glade does for a subagent it named none for.
      const [named] = nameSome(db, task.id, taskChildren(db, task.id), [tops[0] ?? REVIEWER])
      const outcome = file([{ child: named?.id ?? '', todo: '2' }])

      expect(outcome.filed).toEqual([{ id: 'c51', todoId: '2' }])
      // The three commits of its chain, and nothing of the other 16.
      expect(outcome.brought).toEqual(['c1', 'c2', 'c3'])
      expect(placed().map((group) => group.length)).toEqual([47, 3, 0])
      expect(events).toHaveLength(1)
    })

    it('refuses a child whose artifact was removed since it was listed, and files nothing', () => {
      busyTask()
      turnOn()
      list()
      removeArtifact(db, task.id, { kind: ArtifactKind.File, path: PLAN.key })

      expect(
        refusal(() =>
          file([
            { child: 'c2', todo: '3' },
            { child: 'c1', todo: '1' },
          ]),
        ),
      ).toEqual({
        code: BridgeErrorCode.InvalidRequest,
        message: `${NOTHING_FILED} No longer a child of this task (removed since it was listed): c1. ${LIST_FOR_IDS}`,
      })
      expect(rows('child_filings')).toBe(0)
      expect(events).toEqual([])

      // Declared again, it's the child it was, with the id it had.
      addArtifact(db, { taskId: task.id, path: PLAN.key, title: 'The plan, again' }, 9_000)
      expect(file([{ child: 'c1', todo: '1' }]).filed).toEqual([{ id: 'c1', todoId: '1' }])
      expect(list('1')).toBe('#1 Plan the move (completed), 1 child:\n- c1: file "The plan, again"')
    })

    it('refuses a todo deleted between the list and the move, and leaves the child where it was', () => {
      busyTask()
      turnOn()
      list()
      file([{ child: 'c1', todo: '1' }], 9_000)
      events.length = 0
      updateTodo('3', 'deleted', 9_100)

      expect(refusal(() => file([{ child: 'c1', todo: '3' }], 9_200))).toEqual({
        code: BridgeErrorCode.InvalidRequest,
        message:
          `${NOTHING_FILED} There's no todo #3 in this task's list. ` +
          'Your todos: #1 Plan the move (completed) · #2 Review the date helpers (in progress)',
      })
      expect(listFilings(db, task.id).map(({ todoId, filedAt }) => [todoId, filedAt])).toEqual([['1', 9_000]])
      expect(events).toEqual([])
    })

    it('moves a child out of a deleted todo, where it showed under no todo', () => {
      busyTask()
      turnOn()
      list()
      file([{ child: 'c2', todo: '3' }], 9_000)
      updateTodo('3', 'deleted', 9_100)
      expect(list(NO_TODO)).toContain('- c2: link "PR #511"')

      // It had a filing of its own, though its todo is gone: this is a move.
      expect(file([{ child: 'c2', todo: '2' }], 9_200).filed).toEqual([{ id: 'c2', todoId: '2' }])
      expect(listFilings(db, task.id)).toEqual([
        { taskId: task.id, ...PR, todoId: '2', source: FilingSource.Moved, filedAt: 9_200 },
      ])
    })

    it('files a child Glade named in another way than a listing, and one filed as inherited', () => {
      busyTask()
      turnOn()
      // An artifact a subagent declared keeps an inherited filing; filing it by hand makes it the agent's own.
      fileChildren(context(), task.id, [{ ...PLAN, todoId: '2', source: FilingSource.Inherited }], 8_000)
      list()

      expect(file([{ child: 'c1', todo: '2' }], 9_000).filed).toEqual([{ id: 'c1', todoId: '2' }])
      expect(listFilings(db, task.id)).toEqual([
        { taskId: task.id, ...PLAN, todoId: '2', source: FilingSource.Asked, filedAt: 9_000 },
      ])
    })

    it('answers an empty call with nothing changed', () => {
      turnOn()

      expect(filedText(file([]))).toBe('Nothing changed.')
      expect(events).toEqual([])
    })
  })
})
