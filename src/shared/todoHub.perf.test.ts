// The todo hub works its groups out again whenever a child changes (a subagent's every tool call, a watcher's every
// wake), so grouping a big task has to cost next to nothing: 100 todos, 50 children under one of them, and hundreds
// more spread over the rest.
import { expect, it } from 'vitest'
import {
  ArtifactKind,
  TodoState,
  ToolCallState,
  ToolEventKind,
  WatcherKind,
  WatcherState,
  type Artifact,
  type TaskCommit,
  type Todo,
  type Watcher,
} from './domain'
import {
  childOfArtifact,
  ChildKind,
  commitChildKey,
  FilingSource,
  groupChildren,
  type Filing,
  type SubagentChild,
  type TaskChildren,
} from './todoHub'

const TODOS = 100
const UNDER_ONE = 50
const FILES = 300
const SUBAGENTS = 60
const WATCHERS = 60
const COMMITS = 80
/**
 * What grouping the whole task may take: a small part of a frame, so it can run on every event. It's a time, not a
 * count of references, so one budget holds everywhere this runs. Measured for #494 on a Mac (an M1 Max): about 0.35ms.
 * CI's Linux runners, where the perf tests run one file at a time (`npm run test:perf`), take up to two and a half
 * times what that Mac does in the other perf files (`search.perf.test.ts`), which leaves this budget room to spare.
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
  const subagents: SubagentChild[] = Array.from({ length: SUBAGENTS }, (_, index) => ({
    call: {
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
    },
    lastActivityAt: (index * 53) % 97,
  }))
  const watchers: Watcher[] = Array.from({ length: WATCHERS }, (_, index) => ({
    id: `watcher-${String(index)}`,
    taskId: TASK,
    kind: WatcherKind.Monitor,
    toolUseId: `watch-${String(index)}`,
    parentToolUseId: `agent-${String(index)}`,
    label: `Watch ${String(index)}`,
    detail: 'npm test -- --watch',
    schedule: null,
    recurring: true,
    state: index % 5 === 0 ? WatcherState.Running : WatcherState.Finished,
    wakes: index,
    lastWokeAt: index % 2 === 0 ? index : null,
    lastOutput: null,
    nextDueAt: null,
    expiresAt: null,
    outcome: null,
    startedAt: index,
    endedAt: null,
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
      .filter(({ call }) => call.parentToolUseId === null)
      .map(({ call }, index) => ({
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
  return { todos, artifacts, subagents, watchers, commits, filings }
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
  const placed = [...grouped.todos, grouped.unfiled].reduce((count, { children }) => count + children.length, 0)
  expect(placed).toBe(FILES + SUBAGENTS + WATCHERS + COMMITS)
  expect(grouped.unfiled.children).toEqual([])

  expect(timed(() => groupChildren(task))).toBeLessThan(BUDGET_MS)
})
