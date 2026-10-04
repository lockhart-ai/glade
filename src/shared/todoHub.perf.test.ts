// The todo hub works its groups out again whenever anything of its task changes (every entry in its tool log among
// them, since a subagent's commits follow its todo), so grouping a big task has to cost next to nothing: 100 todos, 50
// children under one of them, hundreds more spread over the rest, and 60 subagents whose commits follow them.
import { expect, it } from 'vitest'
import {
  ArtifactKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  type Artifact,
  type TaskCommit,
  type Todo,
  type ToolCallEvent,
} from './domain'
import {
  childOfArtifact,
  ChildKind,
  commitChildKey,
  FilingSource,
  groupChildren,
  subagentTodos,
  type Filing,
  type TaskChildren,
} from './todoHub'

const TODOS = 100
const UNDER_ONE = 50
const FILES = 300
const SUBAGENTS = 60
const COMMITS = 80
/**
 * What grouping the whole task may take: a small part of a frame, so it can run on every event. It's a time, not a
 * count of references, so one budget holds everywhere this runs. Measured for #494 on a Mac (an M1 Max): about 0.35ms
 * with subagents and watchers grouped too, and less since #535 took them out. CI's Linux runners, where the perf tests
 * run one file at a time (`npm run test:perf`), take up to two and a half times what that Mac does in the other perf
 * files (`search.perf.test.ts`), which leaves this budget room to spare.
 */
const BUDGET_MS = 4

const TASK = 'task-1'

function bigTask(): TaskChildren {
  const todos: Todo[] = Array.from({ length: TODOS }, (_, index) => ({
    id: String(index + 1),
    text: `Step ${String(index + 1)}`,
    state: TodoState.Todo,
    note: null,
    completedAt: null,
  }))
  const artifacts: Artifact[] = Array.from({ length: FILES }, (_, index) => ({
    kind: ArtifactKind.File,
    taskId: TASK,
    path: `docs/file-${String(index)}.md`,
    title: `File ${String(index)}`,
    addedAt: index,
    updatedAt: index,
    modifiedAt: (index * 37) % 101,
    missing: false,
  }))
  // Chains three deep: a top-level subagent, its subagent, and that one's.
  const subagents: ToolCallEvent[] = Array.from({ length: SUBAGENTS }, (_, index) => ({
    id: `event-${String(index)}`,
    taskId: TASK,
    turn: 1,
    createdAt: index,
    kind: ToolEventKind.ToolCall,
    name: 'Agent',
    input: { description: `Review file ${String(index)}` },
    output: null,
    state: index % 7 === 0 ? ToolCallState.Running : ToolCallState.Done,
    finishedAt: null,
    toolUseId: `agent-${String(index)}`,
    parentToolUseId: index % 3 === 0 ? null : `agent-${String(index - 1)}`,
    progressSummary: null,
  }))
  const commits: TaskCommit[] = Array.from({ length: COMMITS }, (_, index) => ({
    id: `commit-${String(index)}`,
    taskId: TASK,
    hash: `hash${String(index)}`,
    subject: `Change ${String(index)}`,
    branch: 'main',
    committedAt: (index * 29) % 89,
    additions: 1,
    deletions: 1,
    filesChanged: 1,
    merge: false,
    repoPath: '/code/acme-api',
    subagentToolUseId: index < SUBAGENTS ? `agent-${String(index)}` : null,
  }))
  const filings: Filing[] = [
    ...artifacts.map((artifact, index) => ({
      taskId: TASK,
      ...childOfArtifact(artifact),
      todoId: index < UNDER_ONE ? '1' : String(2 + (index % (TODOS - 1))),
      source: FilingSource.Named,
      filedAt: index,
    })),
    ...subagents
      .filter((call) => call.parentToolUseId === null)
      .map((call, index) => ({
        taskId: TASK,
        kind: ChildKind.Subagent,
        key: call.toolUseId,
        todoId: String(index + 2),
        source: FilingSource.Named,
        filedAt: index,
      })),
    ...commits.slice(SUBAGENTS).map((commit, index) => ({
      taskId: TASK,
      kind: ChildKind.Commit,
      key: commitChildKey(commit),
      todoId: String(index + 30),
      source: FilingSource.Moved,
      filedAt: index,
    })),
  ]
  return { todos, artifacts, subagents, commits, filings }
}

/** The CPU time this process has used, in milliseconds (see search.perf.test.ts for why not the wall clock). */
function cpuMs(): number {
  const { user, system } = process.cpuUsage()
  return (user + system) / 1000
}

/** How long one `run` takes: the median of a few batches after a warm-up, in milliseconds of CPU time. */
function timed(run: () => void): number {
  const BATCH = 50
  const batch = (): void => {
    for (let index = 0; index < BATCH; index += 1) run()
  }
  batch()
  const times: number[] = []
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const start = cpuMs()
    batch()
    times.push((cpuMs() - start) / BATCH)
  }
  times.sort((a, b) => a - b)
  return times[3] ?? Infinity
}

it(`groups ${String(TODOS)} todos, ${String(UNDER_ONE)} children under one, within ${String(BUDGET_MS)}ms`, () => {
  const task = bigTask()

  const grouped = groupChildren(task)
  expect(grouped.todos).toHaveLength(TODOS)
  expect(grouped.todos[0]?.children).toHaveLength(UNDER_ONE)
  // Every file and commit under a todo, the subagents' commits by the todo each works on; no subagent is a child.
  const placed = [...grouped.todos, grouped.unfiled].reduce((count, { children }) => count + children.length, 0)
  expect(placed).toBe(FILES + COMMITS)
  expect(grouped.unfiled.children).toEqual([])

  expect(timed(() => groupChildren(task))).toBeLessThan(BUDGET_MS)
})

it(`finds the todo of each of ${String(SUBAGENTS)} subagents, chained three deep, within ${String(BUDGET_MS)}ms`, () => {
  const task = bigTask()

  expect(subagentTodos(task).size).toBe(SUBAGENTS)

  expect(timed(() => subagentTodos(task))).toBeLessThan(BUDGET_MS)
})
