/**
 * Which commits a task made, for the Changes tab. Glade watches git and never drives it: the agents commit, branch and
 * make worktrees as they like, and Glade works out afterwards what each task's `Bash` calls committed
 * (`docs/sdk-notes.md` §14), from two things it sees of each call:
 *
 * - **Where `HEAD` moved.** Before a `Bash` call runs (the session's `PreToolUse` hook, which the SDK waits for), the
 *   repositories it may commit in are noted: the one its folder is in, and those it `cd`s to or runs `git -C` in
 *   (`./commands`), with how long each working tree's `HEAD` reflog is. Once the call's result is in, the reflog
 *   entries added meanwhile are read, and each that made a commit (a commit, an amend, a merge commit, a cherry-pick, a
 *   revert) is the task's. That catches a commit however it was made, by a script or `--amend`; a checkout, a reset or
 *   a fast-forward moves `HEAD` without making one, and counts for nothing. A repository or worktree made during the
 *   call has no reflog length from before: its entries from after the call started count.
 * - **What the call printed.** `git commit` prints the commit it made (`[main a1b2c3d] Fix the test`): a hash printed
 *   in one of the call's repositories is the task's, surely. When two tasks commit in one working tree at once, each
 *   one's reflog window can take in the other's commit: the first to finish takes it, but the one that printed it
 *   takes it back.
 *
 * An amend replaces the commit `HEAD` was at: if that one was the task's, its link goes, and the amended commit is
 * listed in its place. A commit is linked to one task at most, and a task's links are kept in SQLite with what its row
 * shows, so the tab lists them without git, across a relaunch and after a worktree is removed. A subagent's calls are
 * the task's calls, so its commits are the task's too; the tool log says which subagent made each (the call's parent).
 *
 * Every change is saved, then broadcast as the task's commits (`commits.changed`). Nothing here ever throws into the
 * session: a call git can't read is logged, and counts for nothing.
 */
import { homedir } from 'node:os'
import type { Database } from 'better-sqlite3'
import { EventType } from '../../shared/bridge'
import type { EpochMs } from '../../shared/domain'
import type { Emit } from '../bridge/events'
import {
  addTaskCommit,
  CommitSource,
  findTaskCommit,
  listTaskCommits,
  reassignTaskCommit,
  removeTaskCommit,
} from '../db/repositories/task-commits'
import type { Git, HeadState, RepoLocation } from '../git/git'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { commandTargets, isAmendEntry, isCommitEntry, printedCommits, type PrintedCommit } from './commands'

/** The most reflog entries read for a repository made during a call, which has no length from before. */
const NEW_REPO_ENTRIES = 50

/** A `Bash` call about to run: what the session's `PreToolUse` hook says of it. */
export interface BashStart {
  readonly toolUseId: string
  /** The folder it runs in. */
  readonly cwd: string
  readonly command: string
}

/** A `Bash` call whose result is in. */
export interface BashEnd {
  readonly toolUseId: string
  readonly command: string
  /** Its result's text: what it printed. */
  readonly output: string
  /** The folder it ran in when its start wasn't seen: the task's workspace root. */
  readonly cwd: string
}

export interface ChangeTrackerOptions {
  readonly db: Database
  readonly emit: Emit
  readonly git: Git
  /** The clock. `Date.now` by default. */
  readonly now?: () => EpochMs
  /** The home folder, for a `cd ~/…`. The user's by default. */
  readonly home?: string
  readonly log?: Logger
}

export interface ChangeTracker {
  /** A `Bash` call is about to run: note the repositories it may commit in, and where their `HEAD`s are. */
  bashStarting(taskId: string, call: BashStart): Promise<void>
  /** A `Bash` call's result is in: link the commits it made to the task, and broadcast them. */
  bashFinished(taskId: string, call: BashEnd): Promise<void>
  /** The task's session is gone: its calls that were running will never have results. */
  sessionEnded(taskId: string): void
}

/** A repository a call may commit in, and where its `HEAD` was when the call started; null for one made since. */
interface Watched {
  readonly repo: RepoLocation
  readonly before: HeadState | null
}

/** A call that's running. */
interface Pending {
  readonly taskId: string
  readonly startedAt: EpochMs
  readonly targets: readonly string[]
  readonly repos: ReadonlyMap<string, Watched>
}

/** A commit a call made: where, and how Glade knows. */
interface Made {
  readonly repo: RepoLocation
  readonly hash: string
  readonly source: CommitSource
  /** The branch it printed; undefined when it didn't print one. */
  readonly printedBranch?: string | null
  /** The commit an amend replaced. */
  readonly amended: string | null
}

/** A key for a call, which is unique within its task. */
function callKey(taskId: string, toolUseId: string): string {
  return `${taskId}\0${toolUseId}`
}

export function createChangeTracker({
  db,
  emit,
  git,
  now = Date.now,
  home = homedir(),
  log = SILENT_LOGGER,
}: ChangeTrackerOptions): ChangeTracker {
  const pending = new Map<string, Pending>()

  const broadcast = (taskId: string): void => {
    emit({ type: EventType.CommitsChanged, taskId, commits: listTaskCommits(db, taskId) })
  }

  /** The repositories some folders are in, by their working trees' git dirs. */
  const locateAll = async (dirs: readonly string[]): Promise<Map<string, RepoLocation>> => {
    const found = await Promise.all(dirs.map((dir) => git.locate(dir)))
    const repos = new Map<string, RepoLocation>()
    for (const repo of found) if (repo !== null && !repos.has(repo.gitDir)) repos.set(repo.gitDir, repo)
    return repos
  }

  /** The commits `HEAD`'s reflog says were made in a repository while a call ran, oldest first. */
  const reflogCommits = async (watched: Watched, startedAt: EpochMs): Promise<Made[]> => {
    const { repo, before } = watched
    let entries
    let previous: string | null = null
    if (before === null) {
      const since = Math.floor(startedAt / 1000) * 1000
      entries = (await git.reflog(repo, NEW_REPO_ENTRIES)).filter(({ at }) => at >= since)
    } else {
      const after = await git.head(repo)
      const added = after.reflogLength - before.reflogLength
      if (added <= 0) return []
      const read = await git.reflog(repo, added + 1)
      entries = read.slice(0, added)
      previous = read.length > added ? (read[added]?.hash ?? null) : before.head
    }
    const made: Made[] = []
    // Oldest first, so each entry knows the commit HEAD was at before it: what an amend replaced.
    for (const entry of [...entries].reverse()) {
      if (isCommitEntry(entry.subject)) {
        const amended = isAmendEntry(entry.subject) ? previous : null
        made.push({ repo, hash: entry.hash, source: CommitSource.Observed, amended })
      }
      previous = entry.hash
    }
    return made
  }

  /** The repository a printed commit is in, among a call's; undefined when it's in none of them. */
  const printedIn = async (printed: PrintedCommit, repos: readonly RepoLocation[]): Promise<Made | undefined> => {
    for (const repo of repos) {
      const hash = await git.resolveCommit(repo.commonDir, printed.hash)
      if (hash !== null) {
        return { repo, hash, source: CommitSource.Printed, printedBranch: printed.branch, amended: null }
      }
    }
    return undefined
  }

  /** Every commit a call made, oldest first, each once: a printed one as printed. */
  const madeBy = async (call: BashEnd, running: Pending | undefined): Promise<Made[]> => {
    const printed = printedCommits(call.output)
    // Without its start, only what it printed says anything: its window is unknown.
    if (running === undefined && printed.length === 0) return []
    const targets = running?.targets ?? commandTargets(call.command, call.cwd, home)
    const repos = new Map<string, Watched>(running?.repos ?? [])
    for (const [gitDir, repo] of await locateAll(targets)) {
      if (!repos.has(gitDir)) repos.set(gitDir, { repo, before: null })
    }
    const observed =
      running === undefined
        ? []
        : (await Promise.all([...repos.values()].map((watched) => reflogCommits(watched, running.startedAt)))).flat()
    const locations = [...repos.values()].map(({ repo }) => repo)
    const fromOutput = (await Promise.all(printed.map((commit) => printedIn(commit, locations)))).filter(
      (made): made is Made => made !== undefined,
    )
    const made: Made[] = []
    for (const commit of [...observed, ...fromOutput]) {
      const same = made.findIndex(({ repo, hash }) => repo.commonDir === commit.repo.commonDir && hash === commit.hash)
      const existing = made[same]
      if (existing === undefined) made.push(commit)
      else if (commit.source === CommitSource.Printed) {
        made[same] = { ...commit, amended: existing.amended }
      }
    }
    return made
  }

  /** Links the commits a call made to its task: see the module comment. Answers the tasks whose commits changed. */
  const link = async (taskId: string, toolUseId: string, made: readonly Made[]): Promise<Set<string>> => {
    const changed = new Set<string>()
    const byRepo = new Map<string, Made[]>()
    for (const commit of made) byRepo.set(commit.repo.commonDir, [...(byRepo.get(commit.repo.commonDir) ?? []), commit])
    const branches = new Map<string, string | null>()
    for (const commit of made) {
      if (commit.printedBranch === undefined && !branches.has(commit.repo.gitDir)) {
        branches.set(commit.repo.gitDir, await git.branch(commit.repo))
      }
    }
    for (const [commonDir, commits] of byRepo) {
      const summaries = await git.summaries(
        commonDir,
        commits.map(({ hash }) => hash),
      )
      for (const commit of commits) {
        const summary = summaries.find(({ hash }) => hash === commit.hash)
        if (summary === undefined) continue
        const branch =
          commit.printedBranch !== undefined ? commit.printedBranch : (branches.get(commit.repo.gitDir) ?? null)
        const existing = findTaskCommit(db, commonDir, commit.hash)
        if (existing === undefined) {
          addTaskCommit(
            db,
            {
              taskId,
              gitDir: commonDir,
              repoPath: commit.repo.worktreePath,
              hash: commit.hash,
              subject: summary.subject,
              branch,
              committedAt: summary.committedAt,
              additions: summary.additions,
              deletions: summary.deletions,
              filesChanged: summary.filesChanged,
              parents: summary.parents.length,
              toolUseId,
              source: commit.source,
            },
            now(),
          )
          changed.add(taskId)
        } else if (
          commit.source === CommitSource.Printed &&
          existing.source === CommitSource.Observed &&
          existing.taskId !== taskId
        ) {
          // Another task's call ran alongside and took it first; this one printed it, so it's this one's.
          reassignTaskCommit(db, existing.id, { taskId, toolUseId, source: CommitSource.Printed, branch })
          changed.add(existing.taskId)
          changed.add(taskId)
        }
        if (commit.amended !== null) {
          const replaced = findTaskCommit(db, commonDir, commit.amended)
          if (replaced?.taskId === taskId) {
            removeTaskCommit(db, replaced.id)
            changed.add(taskId)
          }
        }
      }
    }
    return changed
  }

  return {
    async bashStarting(taskId, call) {
      try {
        const targets = commandTargets(call.command, call.cwd, home)
        const startedAt = now()
        const located = await locateAll(targets)
        const heads = await Promise.all([...located.values()].map((repo) => git.head(repo)))
        const repos = new Map<string, Watched>()
        ;[...located.values()].forEach((repo, index) => {
          repos.set(repo.gitDir, { repo, before: heads[index] ?? null })
        })
        pending.set(callKey(taskId, call.toolUseId), { taskId, startedAt, targets, repos })
      } catch (error) {
        log.warn("couldn't note the repositories a call may commit in", { toolUseId: call.toolUseId, error })
      }
    },

    async bashFinished(taskId, call) {
      const key = callKey(taskId, call.toolUseId)
      const running = pending.get(key)
      pending.delete(key)
      try {
        const made = await madeBy(call, running)
        if (made.length === 0) return
        const changed = await link(taskId, call.toolUseId, made)
        if (changed.size > 0) log.info('commits linked', { toolUseId: call.toolUseId, commits: made.length })
        for (const changedTask of changed) broadcast(changedTask)
      } catch (error) {
        log.warn("couldn't work out the commits a call made", { toolUseId: call.toolUseId, error })
      }
    },

    sessionEnded(taskId) {
      for (const [key, call] of pending) if (call.taskId === taskId) pending.delete(key)
    },
  }
}
