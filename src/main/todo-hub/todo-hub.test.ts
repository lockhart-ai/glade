// The todo hub in main, on a real database: what it reads of a task, where it puts each child, what it tells the
// windows when a child is filed.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { ToolCallState, WatcherKind, WatcherState, type Task } from '../../shared/domain'
import {
  ChildFilter,
  ChildKind,
  childrenOf,
  commitChildKey,
  FilingSource,
  subagentTodos,
  UNFILED_TODO_ID,
  type ChildRef,
  type TodoChildren,
} from '../../shared/todoHub'
import { openAppDatabase } from '../db/database'
import { addArtifact, addLinkArtifact, setArtifactFile } from '../db/repositories/artifacts'
import { listFilings } from '../db/repositories/child-filings'
import { listOwedFilings, oweFilings } from '../db/repositories/owed-filings'
import { addTaskCommit, CommitSource } from '../db/repositories/task-commits'
import { deleteTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { listTodoPanels } from '../db/repositories/todo-panels'
import { appendNarration, appendToolCall, updateToolCall } from '../db/repositories/tool-events'
import { addWatcher, updateWatcher } from '../db/repositories/watchers'
import {
  childWithId,
  fileChildren,
  identifyChildren,
  readTodoHub,
  refileChild,
  rememberTodoPanel,
  taskChildren,
  unfileChildren,
  wasWatcherId,
} from './todo-hub'

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

/** A finished call of the agent's (or of the subagent `parent`), logged at `at`. */
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

function deleteTodo(id: string, at: number): void {
  call('TaskUpdate', `toolu_delete_${id}`, { taskId: id, status: 'deleted' }, at)
  finish(`toolu_delete_${id}`, `Updated task #${id} deleted`, at)
}

function monitor(toolUseId: string, parent: string | null, at: number) {
  return addWatcher(
    db,
    {
      taskId: task.id,
      kind: WatcherKind.Monitor,
      toolUseId,
      parentToolUseId: parent,
      sdkId: null,
      label: 'CI on PR #511',
      detail: 'gh pr checks 511 --watch',
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

function commit(hash: string, bashToolUseId: string | null, committedAt: number): void {
  addTaskCommit(db, {
    taskId: task.id,
    gitDir: '/code/acme-api/.git',
    repoPath: '/code/acme-api',
    hash,
    subject: 'Fix the date helpers',
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

const PLAN: ChildRef = { kind: ChildKind.File, key: 'docs/plan.md' }
const PR: ChildRef = { kind: ChildKind.Link, key: 'https://example.com/acme/api/pull/511' }
const REVIEWER: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_agent' }
const NESTED: ChildRef = { kind: ChildKind.Subagent, key: 'toolu_nested' }
/** The calls that started the task's two watchers. A watcher is no child: it has no `ChildRef`. */
const CI_CALL = 'toolu_monitor'
const NESTED_CI_CALL = 'toolu_nested_monitor'
const FIX: ChildRef = { kind: ChildKind.Commit, key: commitChildKey({ hash: 'abc123', repoPath: '/code/acme-api' }) }
const NESTED_FIX: ChildRef = {
  kind: ChildKind.Commit,
  key: commitChildKey({ hash: 'def456', repoPath: '/code/acme-api' }),
}

/**
 * A task that made one of everything: three todos, a file and a link, a subagent with a subagent of its own, a commit
 * by the agent and one by the nested subagent, and (what the hub doesn't hold) a watcher the agent started and one
 * the nested subagent left running.
 */
function busyTask(): void {
  createTodo('1', 'Plan the move', 3_000)
  createTodo('2', 'Review the date helpers', 3_010)
  createTodo('3', 'Watch CI on PR #511', 3_020)
  addArtifact(db, { taskId: task.id, path: PLAN.key, title: 'The plan' }, 4_000)
  setArtifactFile(db, { taskId: task.id, path: PLAN.key, file: { missing: false, modifiedAt: 9_500 } })
  addLinkArtifact(db, { taskId: task.id, url: PR.key, title: '#511' }, 4_100)
  call('Agent', REVIEWER.key, { description: 'Review src/dates.js' }, 5_000)
  call('Agent', NESTED.key, { description: 'Check the tests' }, 5_100, REVIEWER.key)
  call('Bash', 'toolu_nested_bash', { command: 'git commit -am "Fix"' }, 5_200, NESTED.key)
  finish('toolu_nested_bash', '[main def456] Fix the date helpers', 5_300)
  appendNarration(db, { taskId: task.id, turn: 1, text: 'Tests pass.', parentToolUseId: NESTED.key }, 5_400)
  finish(NESTED.key, 'The tests pass.', 5_500)
  call('Bash', 'toolu_bash', { command: 'git commit -am "Fix"' }, 6_000)
  finish('toolu_bash', '[main abc123] Fix the date helpers', 6_100)
  monitor(CI_CALL, null, 7_000)
  const nested = monitor(NESTED_CI_CALL, NESTED.key, 7_100)
  updateWatcher(db, nested.id, { state: WatcherState.Finished, endedAt: 7_900 })
  commit('abc123', 'toolu_bash', 6_050)
  commit('def456', 'toolu_nested_bash', 5_250)
}

/** A group's children as `kind key`, in its order. */
function refs(group: TodoChildren | undefined): string[] {
  return (group?.children ?? []).map(({ kind, key }) => `${kind} ${key}`)
}

const ref = ({ kind, key }: ChildRef): string => `${kind} ${key}`

describe('reading a task’s hub', () => {
  it('gathers its todos, artifacts, every subagent, commits and filings, and no watcher', () => {
    busyTask()
    fileChildren(context(), task.id, [{ ...PLAN, todoId: '1', source: FilingSource.Named }], 8_000)

    const children = taskChildren(db, task.id)

    expect(children.todos.map(({ id, text }) => [id, text])).toEqual([
      ['1', 'Plan the move'],
      ['2', 'Review the date helpers'],
      ['3', 'Watch CI on PR #511'],
    ])
    expect(children.artifacts.map(({ title }) => title)).toEqual(['The plan', '#511'])
    expect(children.subagents.map((agent) => [agent.toolUseId, agent.parentToolUseId, agent.state])).toEqual([
      [REVIEWER.key, null, ToolCallState.Running],
      [NESTED.key, REVIEWER.key, ToolCallState.Done],
    ])
    expect(Object.keys(children).sort()).toEqual(['artifacts', 'commits', 'filings', 'subagents', 'todos'])
    expect(children.commits.map(({ hash, subagentToolUseId }) => [hash, subagentToolUseId])).toEqual([
      ['abc123', null],
      ['def456', NESTED.key],
    ])
    expect(children.filings).toEqual([
      { taskId: task.id, ...PLAN, todoId: '1', source: FilingSource.Named, filedAt: 8_000 },
    ])
  })

  it('shows a task from before the hub with everything it produced under "Not under a todo", and nothing else', () => {
    busyTask()
    const hub = readTodoHub(db, task.id)

    expect(hub.filings).toEqual([])
    expect(hub.panels).toEqual([])
    expect(hub.children.todos.map(({ todoId, children }) => [todoId, children.length])).toEqual([
      ['1', 0],
      ['2', 0],
      ['3', 0],
    ])
    // Most recently updated first: the file changed last, then the commits, then the link. Its two subagents and its
    // two watchers are under nothing.
    expect(refs(hub.children.unfiled)).toEqual([PLAN, FIX, NESTED_FIX, PR].map(ref))
    expect(hub.children.unfiled.tallies).toEqual({
      [ChildKind.File]: 1,
      [ChildKind.Link]: 1,
      [ChildKind.Commit]: 2,
    })
    expect(subagentTodos(taskChildren(db, task.id))).toEqual(new Map())
  })

  it('shows a task that has only subagents and watchers as having produced nothing', () => {
    createTodo('1', 'Review the date helpers', 3_000)
    call('Agent', REVIEWER.key, { description: 'Review src/dates.js' }, 5_000)
    monitor(CI_CALL, null, 7_000)
    monitor(NESTED_CI_CALL, REVIEWER.key, 7_100)
    fileChildren(context(), task.id, [{ ...REVIEWER, todoId: '1', source: FilingSource.Named }], 8_000)

    const hub = readTodoHub(db, task.id)

    expect(hub.children.todos.map(refs)).toEqual([[]])
    expect(hub.children.unfiled.children).toEqual([])
    // The subagent's todo is still there to read: it's a filing, as any other.
    expect(hub.filings.map(({ kind, key, todoId }) => [kind, key, todoId])).toEqual([
      [ChildKind.Subagent, REVIEWER.key, '1'],
    ])
  })

  it('puts each child under the todo it’s filed under, and a subagent’s commits under the todo it works on', () => {
    busyTask()
    fileChildren(
      context(),
      task.id,
      [
        { ...PLAN, todoId: '1', source: FilingSource.Named },
        { ...PR, todoId: '3', source: FilingSource.Named },
        { ...REVIEWER, todoId: '2', source: FilingSource.Named },
      ],
      8_000,
    )

    const { children, filings } = readTodoHub(db, task.id)

    expect(children.todos.map(refs)).toEqual([
      [ref(PLAN)],
      // What the subagent's own subagent committed: neither subagent, and not the watcher that one left running.
      [ref(NESTED_FIX)],
      [ref(PR)],
    ])
    expect(children.todos[1]?.children.map(({ source }) => source)).toEqual([FilingSource.Inherited])
    expect(children.todos[1]?.tallies).toEqual({ [ChildKind.File]: 0, [ChildKind.Link]: 0, [ChildKind.Commit]: 1 })
    // The agent's own commit named no todo.
    expect(refs(children.unfiled)).toEqual([ref(FIX)])
    expect(filings).toHaveLength(3)
    // Both subagents work on the todo the outer one was started for.
    expect(Object.fromEntries(subagentTodos(taskChildren(db, task.id)))).toEqual({
      [REVIEWER.key]: '2',
      [NESTED.key]: '2',
    })
  })

  it('moves a subagent’s commits with it, and drops a deleted todo’s children to the placeholder', () => {
    busyTask()
    fileChildren(context(), task.id, [{ ...REVIEWER, todoId: '2', source: FilingSource.Named }], 8_000)

    fileChildren(context(), task.id, [{ ...REVIEWER, todoId: '3', source: FilingSource.Moved }], 8_500)

    const moved = readTodoHub(db, task.id).children
    expect(moved.todos.map(refs)).toEqual([[], [], [ref(NESTED_FIX)]])
    expect(listFilings(db, task.id)).toEqual([
      { taskId: task.id, ...REVIEWER, todoId: '3', source: FilingSource.Moved, filedAt: 8_500 },
    ])

    deleteTodo('3', 9_000)

    const after = readTodoHub(db, task.id).children
    expect(after.todos.map(({ todoId }) => todoId)).toEqual(['1', '2'])
    expect(after.todos.map(refs)).toEqual([[], []])
    expect(refs(after.unfiled)).toHaveLength(4)
    expect(subagentTodos(taskChildren(db, task.id))).toEqual(new Map())
    // The filing is kept: Claude Code never gives the number to another todo.
    expect(listFilings(db, task.id)).toHaveLength(1)
  })

  it('has nothing to show for a task that has made nothing', () => {
    const hub = readTodoHub(db, task.id)

    expect(hub.children.todos).toEqual([])
    expect(hub.children.unfiled.todoId).toBe(UNFILED_TODO_ID)
    expect(hub.children.unfiled.children).toEqual([])
    expect(hub.filings).toEqual([])
    expect(hub.panels).toEqual([])
  })

  it('fails for a task that isn’t there', () => {
    expect(() => readTodoHub(db, 'gone')).toThrow(
      expect.objectContaining({ code: BridgeErrorCode.NotFound, message: 'No task gone' }),
    )
  })
})

describe('a child’s short id', () => {
  it('names every child of a task from before the hub, oldest first within each kind, filed or not', () => {
    busyTask()
    const named = identifyChildren(db, task.id, childrenOf(taskChildren(db, task.id)))

    expect(named.map(({ id, kind, key }) => [id, ref({ kind, key })])).toEqual([
      ['c1', ref(PLAN)],
      ['c2', ref(PR)],
      ['c3', ref(REVIEWER)],
      ['c4', ref(NESTED)],
      // The nested subagent's commit was made before the agent's own.
      ['c5', ref(NESTED_FIX)],
      ['c6', ref(FIX)],
    ])
    // Its two watchers have no id: they aren't children.
    expect(db.prepare('SELECT COUNT(*) FROM child_ids').pluck().get()).toBe(6)
  })

  it('names no child when it was a watcher’s, from before watchers left the hub, and says it was one', () => {
    busyTask()
    identifyChildren(db, task.id, [PLAN])
    // As the hub wrote a watcher's then: the table still allows the kind.
    db.prepare("INSERT INTO child_ids (task_id, number, kind, key) VALUES (?, 2, 'watcher', ?)").run(task.id, CI_CALL)

    expect(childWithId(db, task.id, 'c2')).toBeUndefined()
    expect(wasWatcherId(db, task.id, 'c2')).toBe(true)
    expect(wasWatcherId(db, task.id, 'c1')).toBe(false)
    expect(wasWatcherId(db, task.id, 'c3')).toBe(false)
    // The next child named doesn't take its number.
    expect(identifyChildren(db, task.id, [PR])).toEqual([{ ...PR, id: 'c3' }])
  })

  it('stays the child’s for the life of the task: as it’s filed, moved, removed and declared again', () => {
    busyTask()
    expect(identifyChildren(db, task.id, [NESTED, PLAN])).toEqual([
      { ...NESTED, id: 'c1' },
      { ...PLAN, id: 'c2' },
    ])

    fileChildren(context(), task.id, [{ ...PLAN, todoId: '1', source: FilingSource.Asked }], 8_000)
    fileChildren(context(), task.id, [{ ...PLAN, todoId: '2', source: FilingSource.Moved }], 8_100)
    unfileChildren(context(), task.id, [PLAN])
    // The artifact is taken off, something else is named meanwhile, and the same file is declared again.
    db.prepare('DELETE FROM artifacts WHERE task_id = ? AND path = ?').run(task.id, PLAN.key)
    expect(identifyChildren(db, task.id, [FIX])).toEqual([{ ...FIX, id: 'c3' }])
    addArtifact(db, { taskId: task.id, path: PLAN.key, title: 'The plan, again' }, 9_000)

    const all = identifyChildren(db, task.id, childrenOf(taskChildren(db, task.id)))
    expect(Object.fromEntries(all.map(({ id, kind, key }) => [ref({ kind, key }), id]))).toEqual({
      [ref(PLAN)]: 'c2',
      [ref(PR)]: 'c4',
      [ref(REVIEWER)]: 'c5',
      [ref(NESTED)]: 'c1',
      [ref(NESTED_FIX)]: 'c6',
      [ref(FIX)]: 'c3',
    })
    expect(childWithId(db, task.id, 'c2')).toEqual(PLAN)
    expect(childWithId(db, task.id, 'c1')).toEqual(NESTED)
  })

  it('names nothing for an id that was never given, or for another task’s', () => {
    identifyChildren(db, task.id, [PLAN])
    const other = sampleTask(db, task.workspaceId)

    expect(childWithId(db, task.id, 'c2')).toBeUndefined()
    expect(childWithId(db, task.id, 'todo 1')).toBeUndefined()
    expect(childWithId(db, other.id, 'c1')).toBeUndefined()
    expect(identifyChildren(db, task.id, [])).toEqual([])
  })

  it('survives a relaunch, and the count carries on from where it was', () => {
    const folder = mkdtempSync(join(tmpdir(), 'glade-todo-hub-'))
    try {
      const first = openAppDatabase(folder).db
      const kept = sampleTask(first, sampleWorkspace(first).id)
      identifyChildren(first, kept.id, [PLAN, PR])
      first.close()

      const second = openAppDatabase(folder).db
      expect(identifyChildren(second, kept.id, [FIX, PR])).toEqual([
        { ...FIX, id: 'c3' },
        { ...PR, id: 'c2' },
      ])
      expect(childWithId(second, kept.id, 'c1')).toEqual(PLAN)
      second.close()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})

describe('filing', () => {
  it('tells the windows what changed, and only that: the filings made, not the task’s whole list', () => {
    fileChildren(context(), task.id, [{ ...PLAN, todoId: '1', source: FilingSource.Named }], 8_000)

    const filed = fileChildren(
      context(),
      task.id,
      [
        { ...PR, todoId: '2', source: FilingSource.Named },
        { ...PLAN, todoId: '2', source: FilingSource.Moved },
      ],
      8_100,
    )

    expect(filed).toEqual([
      { taskId: task.id, ...PR, todoId: '2', source: FilingSource.Named, filedAt: 8_100 },
      { taskId: task.id, ...PLAN, todoId: '2', source: FilingSource.Moved, filedAt: 8_100 },
    ])
    expect(events).toEqual([
      {
        type: EventType.FilingsChanged,
        taskId: task.id,
        filed: [{ taskId: task.id, ...PLAN, todoId: '1', source: FilingSource.Named, filedAt: 8_000 }],
        removed: [],
      },
      { type: EventType.FilingsChanged, taskId: task.id, filed, removed: [] },
    ])
    expect(listFilings(db, task.id)).toHaveLength(2)
  })

  it('sends one event for 200 children filed in one call', () => {
    const children = Array.from({ length: 200 }, (_, index) => ({
      kind: ChildKind.File,
      key: `docs/file-${String(index)}.md`,
      todoId: '1',
      source: FilingSource.Moved,
    }))

    expect(fileChildren(context(), task.id, children)).toHaveLength(200)

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: EventType.FilingsChanged, removed: [] })
  })

  it('files nothing, and says nothing, when there’s nothing to file or the filing can’t be kept', () => {
    expect(fileChildren(context(), task.id, [])).toEqual([])
    expect(() => fileChildren(context(), 'gone', [{ ...PLAN, todoId: '1', source: FilingSource.Named }])).toThrow(
      /FOREIGN KEY/,
    )
    expect(() =>
      fileChildren(context(), task.id, [
        { ...PR, todoId: '1', source: FilingSource.Named },
        { ...PLAN, todoId: UNFILED_TODO_ID, source: FilingSource.Moved },
      ]),
    ).toThrow(/CHECK/)

    expect(events).toEqual([])
    expect(listFilings(db, task.id)).toEqual([])
  })

  it('takes filings away, telling the windows which children lost one', () => {
    fileChildren(
      context(),
      task.id,
      [PLAN, PR, REVIEWER].map((child) => ({ ...child, todoId: '1', source: FilingSource.Named })),
      8_000,
    )
    events = []

    expect(unfileChildren(context(), task.id, [PLAN, FIX, REVIEWER])).toEqual([PLAN, REVIEWER])

    expect(events).toEqual([{ type: EventType.FilingsChanged, taskId: task.id, filed: [], removed: [PLAN, REVIEWER] }])
    expect(listFilings(db, task.id).map(({ key }) => key)).toEqual([PR.key])
    // Nothing that had a filing: nothing to say.
    events = []
    expect(unfileChildren(context(), task.id, [FIX])).toEqual([])
    expect(unfileChildren(context(), task.id, [])).toEqual([])
    expect(events).toEqual([])
  })

  it('settles what the agent owed a filing for, but for a child that only follows its subagent', () => {
    oweFilings(db, task.id, [REVIEWER, FIX, PR], 7_000)

    fileChildren(
      context(),
      task.id,
      [
        { ...REVIEWER, todoId: '3', source: FilingSource.Asked },
        // Not a filing of its own: the child still goes where its subagent goes.
        { ...FIX, todoId: '2', source: FilingSource.Inherited },
      ],
      8_000,
    )

    expect(listOwedFilings(db, task.id)).toEqual([FIX, PR])
    // A filing that can't be kept settles nothing either.
    expect(() =>
      fileChildren(context(), task.id, [{ ...PR, todoId: UNFILED_TODO_ID, source: FilingSource.Asked }]),
    ).toThrow(/CHECK/)
    expect(listOwedFilings(db, task.id)).toEqual([FIX, PR])
  })

  it('moves a child’s filing to its new key, as it was filed, telling the windows both', () => {
    fileChildren(context(), task.id, [{ ...PLAN, todoId: '2', source: FilingSource.Named }], 8_000)
    fileChildren(context(), task.id, [{ ...PR, todoId: '3', source: FilingSource.Asked }], 8_100)
    events = []
    const moved: ChildRef = { kind: ChildKind.File, key: 'docs/the-plan.md' }

    refileChild(context(), task.id, PLAN, moved)

    const filing = { taskId: task.id, ...moved, todoId: '2', source: FilingSource.Named, filedAt: 8_000 }
    expect(events).toEqual([{ type: EventType.FilingsChanged, taskId: task.id, filed: [filing], removed: [PLAN] }])
    expect(listFilings(db, task.id)).toEqual([
      filing,
      { taskId: task.id, ...PR, todoId: '3', source: FilingSource.Asked, filedAt: 8_100 },
    ])
    // A child with no filing has none to move, and one that keeps its key (a new title) isn't touched.
    events = []
    refileChild(context(), task.id, FIX, { kind: ChildKind.Commit, key: 'fed987 /code/acme-api' })
    refileChild(context(), task.id, PR, PR)
    expect(events).toEqual([])
    expect(listFilings(db, task.id)).toHaveLength(2)
  })

  it('goes with the task when it’s deleted', () => {
    fileChildren(context(), task.id, [{ ...PLAN, todoId: '1', source: FilingSource.Named }])
    rememberTodoPanel(db, { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.Files })

    deleteTask(db, task.id)

    expect(listFilings(db, task.id)).toEqual([])
    expect(listTodoPanels(db, task.id)).toEqual([])
  })
})

describe('a todo’s panel', () => {
  it('is remembered for the task, the placeholder’s and a deleted todo’s too, and read back with the hub', () => {
    createTodo('1', 'Plan the move', 3_000)

    rememberTodoPanel(db, { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.Commits })
    rememberTodoPanel(db, { taskId: task.id, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.All })
    rememberTodoPanel(db, { taskId: task.id, todoId: '9', open: false, filter: ChildFilter.Files })

    expect(readTodoHub(db, task.id).panels).toEqual([
      { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.Commits },
      { taskId: task.id, todoId: '9', open: false, filter: ChildFilter.Files },
      { taskId: task.id, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.All },
    ])
    expect(events).toEqual([])
  })

  it('is read back as showing all when it was left on a filter that’s gone, with no error', () => {
    createTodo('1', 'Plan the move', 3_000)
    // As the hub wrote one then: the table still allows both.
    const left = db.prepare('INSERT INTO todo_panels (task_id, todo_id, open, filter) VALUES (?, ?, 1, ?)')
    left.run(task.id, '1', 'subagent')
    left.run(task.id, UNFILED_TODO_ID, 'watcher')

    expect(readTodoHub(db, task.id).panels).toEqual([
      { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.All },
      { taskId: task.id, todoId: UNFILED_TODO_ID, open: true, filter: ChildFilter.All },
    ])
    // Its next change is remembered over the row it had.
    rememberTodoPanel(db, { taskId: task.id, todoId: '1', open: true, filter: ChildFilter.Links })
    expect(listTodoPanels(db, task.id)[0]).toMatchObject({ todoId: '1', filter: ChildFilter.Links })
  })

  it('fails for a task that isn’t there', () => {
    expect(() => {
      rememberTodoPanel(db, { taskId: 'gone', todoId: '1', open: true, filter: ChildFilter.All })
    }).toThrow(expect.objectContaining({ code: BridgeErrorCode.NotFound }))
  })
})

describe('filings and panels survive a relaunch', () => {
  it('reads back, from the database opened again, what was filed and how each panel was left', () => {
    const folder = mkdtempSync(join(tmpdir(), 'glade-todo-hub-'))
    try {
      const first = openAppDatabase(folder).db
      const kept = sampleTask(first, sampleWorkspace(first).id)
      addArtifact(first, { taskId: kept.id, path: PLAN.key, title: 'The plan' }, 4_000)
      fileChildren(
        { db: first, emit: () => undefined },
        kept.id,
        [{ ...PLAN, todoId: '2', source: FilingSource.Named }],
        8_000,
      )
      rememberTodoPanel(first, { taskId: kept.id, todoId: '2', open: true, filter: ChildFilter.Files })
      first.close()

      const second = openAppDatabase(folder).db
      const hub = readTodoHub(second, kept.id)
      expect(hub.filings).toEqual([
        { taskId: kept.id, ...PLAN, todoId: '2', source: FilingSource.Named, filedAt: 8_000 },
      ])
      expect(hub.panels).toEqual([{ taskId: kept.id, todoId: '2', open: true, filter: ChildFilter.Files }])
      second.close()
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })
})
