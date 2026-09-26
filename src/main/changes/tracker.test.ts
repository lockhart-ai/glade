// The change tracker (`./tracker`) against real git repositories and a real database: each `Bash` call is started
// (the `PreToolUse` hook), its command really run, then finished (its result), as a task's agent would run it.
import { join } from 'node:path'
import type { Database } from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import type { Task, TaskCommit } from '../../shared/domain'
import { CommitSource, findTaskCommit, listTaskCommits } from '../db/repositories/task-commits'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall } from '../db/repositories/tool-events'
import { createGit, type Git } from '../git/git'
import { openTestRepos, TEST_GIT_RUN, type TestRepos } from '../git/test-repos'
import { createMemoryLog, type MemoryLog } from '../logging/memory-sink'
import { createChangeTracker, type ChangeTracker } from './tracker'

let database: TestDatabase
let db: Database
let repos: TestRepos
let api: string
let task: Task
let other: Task
let events: GladeEvent[]
let log: MemoryLog
let tracker: ChangeTracker
let calls: number

beforeEach(() => {
  database = openTestDatabase()
  db = database.db
  repos = openTestRepos()
  api = repos.repo('acme-api', {
    'src/date.ts': 'export const header = 1\n',
    'package.json': '{ "version": "2.4.0" }\n',
  })
  const workspace = sampleWorkspace(db, api)
  task = sampleTask(db, workspace.id)
  other = sampleTask(db, workspace.id, 3_000)
  events = []
  log = createMemoryLog()
  tracker = tracking(createGit(TEST_GIT_RUN))
  calls = 0
})

afterEach(() => {
  repos.close()
  database.close()
})

function tracking(git: Git): ChangeTracker {
  return createChangeTracker({ db, emit: (event) => events.push(event), git, home: repos.root, log: log.logger })
}

/** What a command printed, whether or not it failed, as a `Bash` call's result carries it. */
function run(command: string, cwd: string): string {
  try {
    return repos.sh(`${command} 2>&1`, cwd)
  } catch (error) {
    return String(Reflect.get(error as object, 'stdout') ?? '')
  }
}

interface CallOptions {
  readonly taskId?: string
  /** Where it runs; the workspace's repository by default. */
  readonly cwd?: string
  /** The subagent that makes it: its `Agent` call's id. */
  readonly parent?: string
  /** Whether the hook saw it start; it did by default. */
  readonly started?: boolean
}

/** Logs a `Bash` call in the task's tool log, as the runner would. Answers its id. */
function logCall(command: string, { taskId = task.id, parent }: CallOptions = {}): string {
  calls += 1
  const toolUseId = `toolu_bash_${String(calls)}`
  appendToolCall(db, { taskId, turn: 1, name: 'Bash', input: { command }, toolUseId, parentToolUseId: parent ?? null })
  return toolUseId
}

/** A `Bash` call from start to result: the hook, the command, the result. Answers what it printed. */
async function bash(command: string, options: CallOptions = {}): Promise<string> {
  const { taskId = task.id, cwd = api, started = true } = options
  const toolUseId = logCall(command, options)
  if (started) await tracker.bashStarting(taskId, { toolUseId, cwd, command })
  const output = run(command, cwd)
  await tracker.bashFinished(taskId, { toolUseId, command, output, cwd: api })
  return output
}

function subjects(taskId = task.id): string[] {
  return listTaskCommits(db, taskId).map(({ subject }) => subject)
}

/** The latest commits a task's `commits.changed` carried. */
function broadcast(taskId = task.id): readonly TaskCommit[] | undefined {
  return events
    .filter(
      (event): event is Extract<GladeEvent, { type: EventType.CommitsChanged }> =>
        event.type === EventType.CommitsChanged && event.taskId === taskId,
    )
    .at(-1)?.commits
}

function head(cwd = api): string {
  return repos.sh('git rev-parse HEAD', cwd).trim()
}

describe('a commit the task makes', () => {
  it('is linked from what git commit printed, with what its row shows, and broadcast', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\nexport const footer = 3\n')
    await bash('git commit -am "Fix the UTC date test" -m "It built its date in local time."')

    const [commit] = listTaskCommits(db, task.id)
    expect(commit).toMatchObject({
      taskId: task.id,
      hash: head(),
      subject: 'Fix the UTC date test',
      branch: 'main',
      additions: 2,
      deletions: 1,
      filesChanged: 1,
      merge: false,
      repoPath: api,
      subagentToolUseId: null,
    })
    expect(findTaskCommit(db, join(api, '.git'), head())?.source).toBe(CommitSource.Printed)
    expect(broadcast()).toEqual(listTaskCommits(db, task.id))
    expect(subjects(other.id)).toEqual([])
    expect(log.withMessage('commits linked')).toHaveLength(1)
  })

  it('is caught however it’s made: by a script that prints nothing, which only HEAD moving tells', async () => {
    repos.write(
      'acme-api/scripts/release.sh',
      '#!/bin/sh\nsed -i.bak s/2.4.0/2.4.1/ package.json && rm package.json.bak\ngit commit -qam "Bump the version" > /dev/null\n',
    )
    repos.sh('chmod +x scripts/release.sh && git add scripts && git commit -q -m "Add the release script"', api)

    const output = await bash('./scripts/release.sh')
    expect(output).toBe('')
    expect(subjects()).toEqual(['Bump the version'])
    expect(findTaskCommit(db, join(api, '.git'), head())?.source).toBe(CommitSource.Observed)
  })

  it('takes the place of the commit it amends', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    await bash('git commit -qam "Fix the date tset"')
    const typo = head()
    await bash('git commit --amend -q -m "Fix the date test"')

    expect(subjects()).toEqual(['Fix the date test'])
    expect(listTaskCommits(db, task.id)[0]?.hash).toBe(head())
    expect(findTaskCommit(db, join(api, '.git'), typo)).toBeUndefined()
    expect(broadcast()?.map(({ subject }) => subject)).toEqual(['Fix the date test'])

    // Amended twice in one call, it's still the one commit.
    await bash('git commit --amend -q -m "Fix the UTC date test" && git commit --amend -q -m "Fix the UTC date tests"')
    expect(subjects()).toEqual(['Fix the UTC date tests'])
  })

  it('leaves another task’s commit it amends to that task, and lists the amended one as its own', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    await bash('git commit -qam "Fix the date test"', { taskId: other.id })
    await bash('git commit --amend -q -m "Fix the UTC date test"')
    expect(subjects(other.id)).toEqual(['Fix the date test'])
    expect(subjects()).toEqual(['Fix the UTC date test'])
  })

  it('lists several made in one call newest first, a merge commit among them against its first parent', async () => {
    await bash(
      'git checkout -q -b docs/upgrade && printf "# Upgrading\\n" > upgrade.md && git add upgrade.md && ' +
        'git commit -q -m "Add the upgrade guide" && git checkout -q main && ' +
        'printf "a\\nb\\n" > notes.md && git add notes.md && git commit -q -m "Add notes" && ' +
        'git merge -q --no-ff -m "Merge the upgrade guide" docs/upgrade',
    )
    const commits = listTaskCommits(db, task.id)
    expect(commits.map(({ subject, merge, branch }) => [subject, merge, branch])).toEqual([
      ['Merge the upgrade guide', true, 'main'],
      ['Add notes', false, 'main'],
      ['Add the upgrade guide', false, 'main'],
    ])
    expect(commits[0]).toMatchObject({ filesChanged: 1, additions: 1, deletions: 0 })
  })

  it('counts a rename’s changed lines and a binary file as changed, with none of its lines', async () => {
    repos.write('acme-api/docs/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    await bash('git mv src/date.ts src/dates.ts && git add -A && git commit -m "Rename the date helpers, add the logo"')
    expect(listTaskCommits(db, task.id)[0]).toMatchObject({ filesChanged: 2, additions: 0, deletions: 0 })
  })

  it('knows a commit on a detached HEAD has no branch, and a printed one the branch it printed', async () => {
    await bash('git checkout -q --detach && git commit -q --allow-empty -m "Try the other fix"')
    await bash('git checkout -q -b fix/date-test && git commit --allow-empty -m "Try again" && git checkout -q main')
    expect(listTaskCommits(db, task.id).map(({ subject, branch }) => [subject, branch])).toEqual([
      ['Try again', 'fix/date-test'],
      ['Try the other fix', null],
    ])
  })

  it('counts nothing when HEAD only moves to commits that were there: a checkout, a reset, a fast-forward', async () => {
    repos.sh('git checkout -q -b ahead && git commit -q --allow-empty -m "Ahead" && git checkout -q main', api)
    await bash(
      'git checkout -q ahead && git checkout -q main && git merge -q --ff-only ahead && git reset -q --hard HEAD~1',
    )
    await bash('git status && git log --oneline -3')
    expect(subjects()).toEqual([])
    expect(events).toEqual([])
  })

  it('counts nothing someone else committed between the task’s calls', async () => {
    repos.sh('git commit -q --allow-empty -m "Jared’s own commit"', api)
    await bash('git log -1')
    expect(subjects()).toEqual([])
  })
})

describe('where a call commits', () => {
  it('follows the command to another repository it changes to, or runs git in', async () => {
    const web = repos.repo('acme-web')
    await bash(
      `cd ../acme-web && git commit --allow-empty -q -m "Web fix" && git -C ${api} commit --allow-empty -q -m "API fix"`,
    )
    // Made in the same second in two repositories, they're in no order git can tell.
    expect(listTaskCommits(db, task.id).map(({ subject, repoPath }) => [subject, repoPath])).toEqual(
      expect.arrayContaining([
        ['API fix', api],
        ['Web fix', web],
      ]),
    )
    expect(subjects()).toHaveLength(2)
  })

  it('catches a repository or worktree made during the call, from when the call started', async () => {
    const root = repos.root
    await bash('git init -q -b main fresh && cd fresh && git commit -q --allow-empty -m "Start fresh"', { cwd: root })
    await bash(
      'git worktree add -q -b spike ../acme-api-spike && cd ../acme-api-spike && git commit -q --allow-empty -m "Spike"',
    )
    expect(subjects()).toEqual(['Spike', 'Start fresh'])
    expect(listTaskCommits(db, task.id).map(({ branch }) => branch)).toEqual(['spike', 'main'])
  })

  it('counts nothing for a call outside any repository', async () => {
    await bash('ls && echo "[main a1b2c3d] Not a commit"', { cwd: repos.root })
    expect(subjects()).toEqual([])
    expect(events).toEqual([])
  })
})

describe('a subagent’s commit', () => {
  it('is the task’s, labelled with the subagent, made in its own worktree, and stays after the worktree goes', async () => {
    appendToolCall(db, {
      taskId: task.id,
      turn: 1,
      name: 'Agent',
      input: { description: 'Update the upgrade guide', subagent_type: 'general-purpose' },
      toolUseId: 'toolu_agent',
      parentToolUseId: null,
    })
    repos.sh('git worktree add -q -b docs/upgrade ../acme-api-docs', api)
    const worktree = join(repos.root, 'acme-api-docs')
    await bash('printf "# Upgrading\\n" > upgrade.md && git add upgrade.md && git commit -m "Add the upgrade guide"', {
      cwd: worktree,
      parent: 'toolu_agent',
    })

    const [commit] = listTaskCommits(db, task.id)
    expect(commit).toMatchObject({
      subject: 'Add the upgrade guide',
      branch: 'docs/upgrade',
      repoPath: worktree,
      subagentToolUseId: 'toolu_agent',
    })
    repos.sh('git worktree remove --force ../acme-api-docs', api)
    expect(listTaskCommits(db, task.id)).toEqual([commit])
  })
})

describe('two tasks committing in one repository', () => {
  it('each get their own', async () => {
    await bash('git commit --allow-empty -m "Task one’s"')
    await bash('git commit --allow-empty -m "Task two’s"', { taskId: other.id })
    await bash('git commit --allow-empty -q -m "Task one’s again"')
    expect(subjects()).toEqual(['Task one’s again', 'Task one’s'])
    expect(subjects(other.id)).toEqual(['Task two’s'])
  })

  it('at once: the one that printed a commit gets it back from the one whose call saw HEAD move first', async () => {
    const first = logCall('npm test')
    const second = logCall('git commit --allow-empty -m "Task two’s"', { taskId: other.id })
    await tracker.bashStarting(task.id, { toolUseId: first, cwd: api, command: 'npm test' })
    await tracker.bashStarting(other.id, { toolUseId: second, cwd: api, command: 'git commit' })
    const printed = run('git commit --allow-empty -m "Task two’s"', api)
    // The first task's call ends first: HEAD moved while it ran, so it takes the commit.
    await tracker.bashFinished(task.id, { toolUseId: first, command: 'npm test', output: '', cwd: api })
    expect(subjects()).toEqual(['Task two’s'])
    // The second's ends: it printed the commit, so it's the second's.
    await tracker.bashFinished(other.id, { toolUseId: second, command: 'git commit', output: printed, cwd: api })
    expect(subjects()).toEqual([])
    expect(subjects(other.id)).toEqual(['Task two’s'])
    expect(broadcast()).toEqual([])
    expect(broadcast(other.id)?.map(({ subject }) => subject)).toEqual(['Task two’s'])
    expect(findTaskCommit(db, join(api, '.git'), head())?.source).toBe(CommitSource.Printed)
  })

  it('at once the other way round: the one that printed it keeps it', async () => {
    const first = logCall('npm test')
    const second = logCall('git commit', { taskId: other.id })
    await tracker.bashStarting(task.id, { toolUseId: first, cwd: api, command: 'npm test' })
    await tracker.bashStarting(other.id, { toolUseId: second, cwd: api, command: 'git commit' })
    const printed = run('git commit --allow-empty -m "Task two’s"', api)
    await tracker.bashFinished(other.id, { toolUseId: second, command: 'git commit', output: printed, cwd: api })
    await tracker.bashFinished(task.id, { toolUseId: first, command: 'npm test', output: '', cwd: api })
    expect(subjects()).toEqual([])
    expect(subjects(other.id)).toEqual(['Task two’s'])
    // Printed twice, it stays with the first that printed it.
    await tracker.bashFinished(task.id, { toolUseId: 'late', command: 'git log', output: printed, cwd: api })
    expect(subjects(other.id)).toEqual(['Task two’s'])
  })
})

describe('a call whose start wasn’t seen', () => {
  it('links only the commits it printed, found in the repositories the command names', async () => {
    await bash('git commit --allow-empty -m "Printed" && git commit --allow-empty -q -m "Quiet"', { started: false })
    expect(subjects()).toEqual(['Printed'])
  })

  it('counts nothing without a commit printed, and never looks at git for it', async () => {
    const quiet: Git = {
      ...createGit(TEST_GIT_RUN),
      locate: () => Promise.reject(new Error('git was asked')),
    }
    tracker = tracking(quiet)
    await tracker.bashFinished(task.id, { toolUseId: 'toolu_x', command: 'npm test', output: 'ok', cwd: api })
    expect(log.withMessage("couldn't work out the commits a call made")).toEqual([])
    expect(events).toEqual([])
  })

  it('is one whose session ended before its result', async () => {
    const toolUseId = logCall('git commit -q --allow-empty -m "Quiet"')
    await tracker.bashStarting(task.id, { toolUseId, cwd: api, command: 'git commit' })
    run('git commit -q --allow-empty -m "Quiet"', api)
    tracker.sessionEnded(other.id)
    tracker.sessionEnded(task.id)
    await tracker.bashFinished(task.id, { toolUseId, command: 'git commit', output: '', cwd: api })
    expect(subjects()).toEqual([])
  })
})

describe('when git fails', () => {
  it('logs it, and neither throws into the session nor links anything', async () => {
    const broken: Git = {
      ...createGit(TEST_GIT_RUN),
      locate: () => Promise.reject(new Error('git is gone')),
    }
    tracker = tracking(broken)
    await expect(tracker.bashStarting(task.id, { toolUseId: 't1', cwd: api, command: 'git commit' })).resolves.toBe(
      undefined,
    )
    await expect(
      tracker.bashFinished(task.id, { toolUseId: 't1', command: 'git commit', output: '[main a1b2c3d] X', cwd: api }),
    ).resolves.toBe(undefined)
    expect(log.withMessage("couldn't note the repositories a call may commit in")).toHaveLength(1)
    expect(log.withMessage("couldn't work out the commits a call made")).toHaveLength(1)
    expect(subjects()).toEqual([])
  })

  it('skips a commit git can’t summarise', async () => {
    tracker = tracking({ ...createGit(TEST_GIT_RUN), summaries: () => Promise.resolve([]) })
    await bash('git commit --allow-empty -m "Gone"')
    expect(subjects()).toEqual([])
    expect(events).toEqual([])
  })
})
