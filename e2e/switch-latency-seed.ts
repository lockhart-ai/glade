// A large, throwaway installation for #637 (task/workspace switch latency): about 4 workspaces and 100 tasks, at
// least 20 of them with a long history, the rest medium or small. Built on top of `./long-history`'s `historyTask`,
// scaled up and spread across workspaces, with a few watchers, permission requests and an open question added to the
// long tasks so the dataset looks like a real, heavily used installation.
//
// This file is instrumentation for a measurement spike only (docs/kitten-sop.md never saw it as a fix): it writes a
// seed JSON that `applySeed` (src/main/capture-seed.ts) turns into a database before the window opens, the same way
// every other e2e fixture does (`e2e/long-history.ts`, `e2e/fixtures.ts`'s `seed` option).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { historyTask, type HistoryScale, type SeedTask } from './long-history'

/** A long task: about 1,000 messages, 1,500 tool events (a dozen subagents among them), 40 todos, 30 artifacts. */
export const LONG_SCALE: HistoryScale = { messages: 1000, toolEvents: 1500, subagents: 12, artifacts: 30, todos: 40 }

/** A medium task: a few dozen turns, as a task worked for a day or two reads. */
export const MEDIUM_SCALE: HistoryScale = { messages: 50, toolEvents: 120, subagents: 3, artifacts: 5, todos: 5 }

/** A small task: a handful of turns, just started. */
export const SMALL_SCALE: HistoryScale = { messages: 6, toolEvents: 12, subagents: 1, artifacts: 1, todos: 2 }

/** Long tasks per workspace; with `WORKSPACES.length` workspaces this gives at least 20 long tasks overall. */
const LONG_PER_WORKSPACE = 5
const MEDIUM_PER_WORKSPACE = 10
const SMALL_PER_WORKSPACE = 10

export interface SeedWorkspaceDescriptor {
  readonly name: string
  readonly rootPath: string
}

/** The installation's workspaces: the fixture's own (first) plus three more, each a made-up Acme codebase. */
export const WORKSPACES: readonly SeedWorkspaceDescriptor[] = [
  { name: 'Acme API', rootPath: '/Users/sample/code/api' },
  { name: 'Acme Web', rootPath: '/Users/sample/code/web' },
  { name: 'Acme Mobile', rootPath: '/Users/sample/code/mobile' },
  { name: 'Acme Data', rootPath: '/Users/sample/code/data' },
]

/** How many tasks each workspace gets, long first, then medium, then small. */
export const TASKS_PER_WORKSPACE = LONG_PER_WORKSPACE + MEDIUM_PER_WORKSPACE + SMALL_PER_WORKSPACE

/** The titles of the long tasks (the ones a switch-latency spec picks for its "long task" runs), oldest first. */
export const LONG_TASK_TITLES: string[] = []

const WATCHER_KINDS = ['monitor', 'command', 'wakeup', 'cron'] as const

/** A couple of watchers, a few permission requests and (for every third long task) an open question. */
function withExtras(task: SeedTask, index: number, workspace: number): SeedTask {
  const prefix = `w${String(workspace)}-${String(index)}`
  const watchers = [
    {
      kind: WATCHER_KINDS[index % WATCHER_KINDS.length] ?? 'monitor',
      toolUseId: `${prefix}-watch-1`,
      label: `Watch the ${prefix} release`,
      detail: 'gh run watch --repo acme/api',
      minutesAgo: 3,
      ...(index % 2 === 0 ? { lastOutput: 'lint pass 12s · tests running' } : { state: 'scheduled', dueInMinutes: 15 }),
    },
    {
      kind: 'command',
      toolUseId: `${prefix}-watch-2`,
      label: `Background build for ${prefix}`,
      detail: 'npm run build -- --watch',
      minutesAgo: 30,
      state: 'finished',
      outcome: 'Built successfully',
      endedMinutesAgo: 5,
    },
  ]
  const permissionRequests = [
    {
      toolName: 'Bash',
      input: { command: `npm test -- ${prefix}`, description: 'Run the suite' },
      toolUseId: `${prefix}-perm-open`,
      turn: 1,
      minutesAgo: 1,
    },
    {
      toolName: 'Edit',
      input: { file_path: `src/${prefix}/index.ts`, old_string: 'a', new_string: 'b' },
      toolUseId: `${prefix}-perm-allowed`,
      state: 'allowed',
      forTask: true,
      suggestedRule: `Edit src/${prefix}/*`,
      turn: 1,
      minutesAgo: 20,
    },
    {
      toolName: 'Bash',
      input: { command: 'rm -rf dist', description: 'Clean the build' },
      toolUseId: `${prefix}-perm-denied`,
      state: 'denied',
      denyNote: 'Keep dist around.',
      turn: 1,
      minutesAgo: 25,
    },
  ]
  return {
    ...task,
    watchers,
    permissionRequests,
    ...(index % 3 === 0
      ? {
          questionSet: {
            preamble: `A couple of choices before the ${prefix} release notes go out.`,
            turn: 1,
            minutesAgo: 1,
            questions: [{ kind: 'pills', prompt: 'Ship it now?', options: ['Yes', 'Wait for CI'] }],
          },
        }
      : {}),
  } as SeedTask
}

/**
 * Plants the log's first two entries of the first long task: a Reopened divider and a subagent-starting `Agent` call
 * (#637), the two kinds a first load always sends whole however old. They sit a tail's length older than the last
 * screenful, so paging the log in as you scroll up goes by the tail's own cursor: from the oldest entry the window
 * holds — one of these — would ask before `seq` 2 and never load what lies between.
 */
function withEarlyCarried(task: SeedTask): SeedTask {
  return {
    ...task,
    toolEvents: [
      { kind: 'divider', dividerKind: 'reopened', turn: 1, minutesAgo: task.startedMinutesAgo + 2 },
      {
        kind: 'tool_call',
        name: 'Agent',
        input: { description: 'Scout the release', prompt: 'Scout the release.' },
        output: 'The release looks on track.',
        toolUseId: 'agent-early',
        turn: 1,
        minutesAgo: task.startedMinutesAgo + 1,
      },
      ...task.toolEvents,
    ],
  }
}

/** Builds the installation's tasks, one workspace at a time, long tasks first in each. */
function buildTasks(): SeedTask[] {
  const tasks: SeedTask[] = []
  // A steadily increasing `minutesAgo` keeps every task's update time distinct, oldest at the back of the list.
  let minutesAgo = 1
  for (const [workspaceIndex, workspace] of WORKSPACES.entries()) {
    const extra = workspaceIndex === 0 ? {} : { workspace }
    for (let index = 0; index < LONG_PER_WORKSPACE; index += 1) {
      const title = `Ship the ${workspace.name} release ${String(index + 1)}`
      LONG_TASK_TITLES.push(title)
      const selected = workspaceIndex === 0 && index === 0
      const base = historyTask(title, LONG_SCALE, selected, true)
      const seeded = { ...withExtras(base, index, workspaceIndex), minutesAgo, ...extra }
      // The task the window opens on carries the early entries the paging spec checks (#637).
      tasks.push(selected ? withEarlyCarried(seeded) : seeded)
      minutesAgo += 1
    }
    for (let index = 0; index < MEDIUM_PER_WORKSPACE; index += 1) {
      const title = `Fix the ${workspace.name} bug ${String(index + 1)}`
      const base = historyTask(title, MEDIUM_SCALE, false)
      tasks.push({ ...base, minutesAgo, ...extra })
      minutesAgo += 1
    }
    for (let index = 0; index < SMALL_PER_WORKSPACE; index += 1) {
      const title = `Look at the ${workspace.name} report ${String(index + 1)}`
      const base = historyTask(title, SMALL_SCALE, false)
      tasks.push({ ...base, minutesAgo, ...extra })
      minutesAgo += 1
    }
  }
  return tasks
}

/**
 * Writes the large installation into `folder` (about 4 workspaces, 100 tasks, at least 20 with a long history) and
 * returns the seed's path. The fixture's own workspace (`WORKSPACES[0]`) is the one that opens; the window starts on
 * its first long task.
 */
export function writeSwitchLatencySeed(folder: string): string {
  const [first] = WORKSPACES
  if (first === undefined) throw new Error('WORKSPACES must have at least one workspace')
  const seed = {
    workspace: first,
    panelTab: 'agents',
    tasks: buildTasks(),
  }
  const path = join(folder, 'switch-latency.json')
  writeFileSync(path, JSON.stringify(seed))
  return path
}
