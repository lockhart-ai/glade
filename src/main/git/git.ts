/**
 * Reading git, for the Changes tab (`../changes`): what Glade needs to know of a repository, over plain `git` commands
 * run with `execFile` (no library), each one's output parsed here, at the boundary, into typed values. Glade only ever
 * reads: nothing here writes to a repository, its index or its refs, and every command runs with optional locks off
 * (`GIT_OPTIONAL_LOCKS=0`), so reading never gets in the way of an agent's own git.
 *
 * A folder's repository is located as its working tree (the repository's own, or a linked worktree's), that tree's own
 * git dir (its `HEAD` and `HEAD`'s reflog) and the common git dir every worktree shares (the objects). Commits and
 * their files are read through the common git dir, so they can still be read after their worktree is removed.
 */
import { execFile } from 'node:child_process'
import { CommitFileStatus, type CommitFile, type EpochMs } from '../../shared/domain'

/** How long one git command gets before it's given up on. */
export const GIT_TIMEOUT_MS = 15_000

/** The most output a git command may give, in bytes: a huge commit's file list stays well under. */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024

/** What running one git command came to: its output, as far as it was read, and whether it succeeded. */
export interface GitOutput {
  /** Whether it exited 0 with its output whole. */
  readonly ok: boolean
  readonly stdout: Buffer
  /** Whether its output was cut short at the most it was allowed to give. */
  readonly truncated: boolean
}

/** Runs `git` with `args` in `cwd`, reading at most `maxBytes` of its output. Never throws. */
export type GitRun = (args: readonly string[], cwd: string | null, maxBytes: number) => Promise<GitOutput>

/** Where a folder's repository is. Every path is absolute and real. */
export interface RepoLocation {
  /** The top of the working tree the folder is in: the repository's own, or a linked worktree's. */
  readonly worktreePath: string
  /** That working tree's own git dir: its `HEAD`, and `HEAD`'s reflog. */
  readonly gitDir: string
  /** The git dir every worktree of the repository shares: its objects, which outlive a removed worktree. */
  readonly commonDir: string
}

/** Where a working tree's `HEAD` is, and how long its reflog is. */
export interface HeadState {
  /** The commit `HEAD` is at; null before the first commit. */
  readonly head: string | null
  /** How many entries `HEAD`'s reflog has: each move of `HEAD` adds one. */
  readonly reflogLength: number
}

/** One move of a working tree's `HEAD`, from its reflog. */
export interface ReflogEntry {
  /** The commit `HEAD` moved to. */
  readonly hash: string
  /** What moved it, as git words it: `commit: Fix the test`, `commit (amend): …`, `checkout: moving from a to b`. */
  readonly subject: string
  /** When, to the second. */
  readonly at: EpochMs
}

/** A commit as the Changes tab's row shows it. */
export interface CommitSummary {
  readonly hash: string
  readonly parents: readonly string[]
  readonly committedAt: EpochMs
  readonly subject: string
  readonly filesChanged: number
  readonly additions: number
  readonly deletions: number
}

/** A file's contents at a commit: its first bytes, up to what was asked for, and its whole size. */
export interface BlobContent {
  readonly bytes: Buffer
  readonly size: number
}

export interface Git {
  /** The repository a folder is in; null when it's in none (or isn't there, or git can't be run). */
  locate(dir: string): Promise<RepoLocation | null>
  /** Where a working tree's `HEAD` is, and how long its reflog is. */
  head(repo: RepoLocation): Promise<HeadState>
  /** The branch a working tree is on; null on a detached `HEAD`. */
  branch(repo: RepoLocation): Promise<string | null>
  /** The latest `count` moves of a working tree's `HEAD`, newest first. */
  reflog(repo: RepoLocation, count: number): Promise<ReflogEntry[]>
  /** The full hash of the commit a name (such as a short hash) names in a repository; null when it names none. */
  resolveCommit(commonDir: string, name: string): Promise<string | null>
  /** The commits with these hashes, in the same order, skipping any the repository doesn't have. */
  summaries(commonDir: string, hashes: readonly string[]): Promise<CommitSummary[]>
  /**
   * Every file a commit changed, in git's order: a merge's against its first parent, renames found. Throws a
   * `GitError` when the repository doesn't have the commit (any more).
   */
  files(commonDir: string, hash: string): Promise<CommitFile[]>
  /** A file as it was at a commit, up to `maxBytes` of it; null when the commit has no file at that path. */
  fileAt(commonDir: string, hash: string, path: string, maxBytes: number): Promise<BlobContent | null>
}

/** A git command that failed, where failing means something went wrong rather than "no". */
export class GitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GitError'
  }
}

/**
 * What every command starts with: no pager, paths as they are (not quoted and escaped), and no colour or signatures in
 * what's parsed, whatever the user's config says.
 */
const BASE_ARGS = ['--no-pager', '-c', 'core.quotepath=off', '-c', 'color.ui=false', '-c', 'log.showSignature=false']

/** A commit's diff, as the Changes tab counts it: renames found, and a merge's against its first parent. */
const DIFF_ARGS = ['-M', '--diff-merges=first-parent', '--no-ext-diff', '--no-textconv']

/** The unit separator, between a record's fields, and the record separator, before each record. */
const FIELD = '\x1f'
const RECORD = '\x1e'

const HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/

/** Runs git with `execFile`, in the environment given, with optional locks off and no prompts. */
export function execGit(env: NodeJS.ProcessEnv = process.env): GitRun {
  const gitEnv = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' }
  return (args, cwd, maxBytes) =>
    new Promise((resolve) => {
      execFile(
        'git',
        [...BASE_ARGS, ...args],
        {
          ...(cwd === null ? {} : { cwd }),
          env: gitEnv,
          encoding: 'buffer',
          maxBuffer: maxBytes,
          timeout: GIT_TIMEOUT_MS,
        },
        (error, stdout) => {
          const truncated = error !== null && Reflect.get(error, 'code') === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          resolve({ ok: error === null, stdout, truncated })
        },
      )
    })
}

function text(output: GitOutput): string {
  return output.stdout.toString('utf8')
}

/** The non-empty lines of a command's output. */
function lines(output: GitOutput): string[] {
  return text(output)
    .split('\n')
    .filter((line) => line !== '')
}

/** The seconds of a reflog entry's selector with `--date=unix`, `HEAD@{1790395578}`, as a time. */
function selectorTime(selector: string): EpochMs {
  const seconds = /@\{(\d+)\}$/.exec(selector)?.[1]
  return seconds === undefined ? 0 : Number(seconds) * 1000
}

/** A working tree's reflog, as `log -g --format=%H<US>%gs<US>%gd --date=unix` prints it, newest first. */
export function parseReflog(output: string): ReflogEntry[] {
  return output.split('\n').flatMap((line) => {
    const [hash, subject, selector] = line.split(FIELD)
    if (hash === undefined || !HASH.test(hash) || subject === undefined || selector === undefined) return []
    return [{ hash, subject, at: selectorTime(selector) }]
  })
}

/** The counts of a `--shortstat` line: `3 files changed, 10 insertions(+), 2 deletions(-)`, any part left out. */
function shortstat(line: string): { filesChanged: number; additions: number; deletions: number } {
  const count = (pattern: RegExp): number => Number(pattern.exec(line)?.[1] ?? 0)
  return {
    filesChanged: count(/(\d+) files? changed/),
    additions: count(/(\d+) insertions?\(\+\)/),
    deletions: count(/(\d+) deletions?\(-\)/),
  }
}

/**
 * Commits as `log --no-walk --format=<RS>%H<US>%P<US>%ct<US>%s --shortstat` prints them: each record its fields, then
 * its short stat (none for a commit that changed nothing).
 */
export function parseSummaries(output: string): CommitSummary[] {
  return output.split(RECORD).flatMap((record) => {
    const [header = '', ...rest] = record.split('\n')
    const [hash, parents, time, subject] = header.split(FIELD)
    if (hash === undefined || !HASH.test(hash) || parents === undefined || time === undefined) return []
    return [
      {
        hash,
        parents: parents.split(' ').filter((parent) => parent !== ''),
        committedAt: Number(time) * 1000,
        subject: subject ?? '',
        ...shortstat(rest.join(' ')),
      },
    ]
  })
}

/** A `--raw` status letter as the Changes tab tells it. */
function fileStatus(letter: string): CommitFileStatus {
  switch (letter) {
    case 'A':
    case 'C':
      return CommitFileStatus.Added
    case 'D':
      return CommitFileStatus.Deleted
    case 'R':
      return CommitFileStatus.Renamed
    default:
      return CommitFileStatus.Modified
  }
}

/** A numstat count: a number of lines, or null for a binary file's `-`. */
function lineCount(value: string): number | null {
  return value === '-' ? null : Number(value)
}

/**
 * A commit's files, as `show --format= -z --raw --numstat` prints them: first a raw entry for each file (`:modes shas
 * status`, then its path, or a rename's or copy's two), then a numstat entry for each, in the same order (its counts
 * and path, or its counts, then a rename's two paths).
 */
export function parseCommitFiles(output: string): CommitFile[] {
  const tokens = output.split('\0')
  const raw: { status: CommitFileStatus; path: string; oldPath: string | null }[] = []
  const counts: { additions: number | null; deletions: number | null }[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index] ?? ''
    if (token.startsWith(':')) {
      const letter = token.split(' ').at(-1)?.charAt(0) ?? 'M'
      const two = letter === 'R' || letter === 'C'
      const first = tokens[index + 1] ?? ''
      const second = two ? (tokens[index + 2] ?? '') : null
      index += two ? 2 : 1
      const status = fileStatus(letter)
      raw.push({
        status,
        path: second ?? first,
        oldPath: status === CommitFileStatus.Renamed ? first : null,
      })
      continue
    }
    const numstat = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(token)
    if (numstat === null) continue
    const [, added = '-', deleted = '-', path] = numstat
    // A rename's or copy's numstat has no path of its own: its two paths follow.
    if (path === '') index += 2
    counts.push({ additions: lineCount(added), deletions: lineCount(deleted) })
  }
  return raw.map((file, index) => ({ ...file, ...(counts[index] ?? { additions: null, deletions: null }) }))
}

/** Git over `run`: `execGit()` by default. */
export function createGit(run: GitRun = execGit()): Git {
  /** A command's output when it succeeded; null when it failed. */
  const attempt = async (args: readonly string[], cwd: string | null): Promise<GitOutput | null> => {
    const output = await run(args, cwd, MAX_OUTPUT_BYTES)
    return output.ok ? output : null
  }
  const gitDir = (commonDir: string): string => `--git-dir=${commonDir}`

  const summaries = async (commonDir: string, hashes: readonly string[]): Promise<CommitSummary[]> => {
    if (hashes.length === 0) return []
    const format = `--format=${RECORD}%H${FIELD}%P${FIELD}%ct${FIELD}%s`
    const output = await attempt(
      [gitDir(commonDir), 'log', '--no-walk=unsorted', format, '--shortstat', ...DIFF_ARGS, ...hashes, '--'],
      null,
    )
    if (output !== null) return parseSummaries(text(output))
    // One of them is gone, and git refuses the whole list for it: read the others one by one.
    if (hashes.length === 1) return []
    const each = await Promise.all(hashes.map((hash) => summaries(commonDir, [hash])))
    return each.flat()
  }

  return {
    async locate(dir) {
      const output = await attempt(
        ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'],
        dir,
      )
      const [worktreePath, ownDir, commonDir] = output === null ? [] : lines(output)
      if (worktreePath === undefined || ownDir === undefined || commonDir === undefined) return null
      return { worktreePath, gitDir: ownDir, commonDir }
    },

    async head(repo) {
      const [head, count] = await Promise.all([
        attempt(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], repo.worktreePath),
        attempt(['rev-list', '--walk-reflogs', '--count', 'HEAD'], repo.worktreePath),
      ])
      const hash = head === null ? undefined : lines(head)[0]
      const length = count === null ? 0 : Number(lines(count)[0] ?? 0)
      return { head: hash ?? null, reflogLength: Number.isSafeInteger(length) ? length : 0 }
    },

    async branch(repo) {
      const output = await attempt(['symbolic-ref', '-q', '--short', 'HEAD'], repo.worktreePath)
      return (output === null ? undefined : lines(output)[0]) ?? null
    },

    async reflog(repo, count) {
      if (count <= 0) return []
      const output = await attempt(
        ['log', '-g', `-n${String(count)}`, `--format=%H${FIELD}%gs${FIELD}%gd`, '--date=unix', 'HEAD', '--'],
        repo.worktreePath,
      )
      return output === null ? [] : parseReflog(text(output))
    },

    async resolveCommit(commonDir, name) {
      const output = await attempt([gitDir(commonDir), 'rev-parse', '-q', '--verify', `${name}^{commit}`], null)
      const hash = output === null ? undefined : lines(output)[0]
      return hash !== undefined && HASH.test(hash) ? hash : null
    },

    summaries,

    async files(commonDir, hash) {
      const output = await run(
        [gitDir(commonDir), 'show', '--format=', '-z', '--raw', '--numstat', ...DIFF_ARGS, hash, '--'],
        null,
        MAX_OUTPUT_BYTES,
      )
      if (!output.ok) throw new GitError(`Couldn't read the files of commit ${hash}`)
      return parseCommitFiles(text(output))
    },

    async fileAt(commonDir, hash, path, maxBytes) {
      const object = `${hash}:${path}`
      const size = await attempt([gitDir(commonDir), 'cat-file', '-s', object], null)
      const bytes = size === null ? undefined : Number(lines(size)[0])
      if (bytes === undefined || !Number.isSafeInteger(bytes)) return null
      const blob = await run([gitDir(commonDir), 'cat-file', 'blob', object], null, Math.max(1, maxBytes))
      if (!blob.ok && !blob.truncated) return null
      return { bytes: blob.stdout.subarray(0, maxBytes), size: bytes }
    },
  }
}
