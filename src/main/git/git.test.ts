import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CommitFileStatus } from '../../shared/domain'
import {
  createGit,
  execGit,
  parseCommitFiles,
  parseReflog,
  parseSummaries,
  type Git,
  type GitRun,
  type RepoLocation,
} from './git'
import { openTestRepos, TEST_GIT_RUN, type TestRepos } from './test-repos'

let repos: TestRepos
let git: Git

// Each test runs many real git commands: slow while the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  repos = openTestRepos()
  git = createGit(TEST_GIT_RUN)
})

afterEach(() => {
  repos.close()
})

/** The repository a folder is in, which the test knows it has. */
async function located(dir: string): Promise<RepoLocation> {
  const repo = await git.locate(dir)
  if (repo === null) throw new Error(`${dir} isn't in a repository`)
  return repo
}

const HASH = /^[0-9a-f]{40}$/

describe('locate', () => {
  it('finds a folder’s repository from anywhere inside it, and a worktree’s own and shared git dirs', async () => {
    const api = repos.repo('acme-api', { 'src/date.ts': 'export {}\n' })
    expect(await git.locate(join(api, 'src'))).toEqual({
      worktreePath: api,
      gitDir: join(api, '.git'),
      commonDir: join(api, '.git'),
    })

    repos.sh('git worktree add -q -b docs ../acme-api-docs', api)
    expect(await git.locate(join(repos.root, 'acme-api-docs'))).toEqual({
      worktreePath: join(repos.root, 'acme-api-docs'),
      gitDir: join(api, '.git', 'worktrees', 'acme-api-docs'),
      commonDir: join(api, '.git'),
    })
  })

  it('finds none for a folder outside any repository, one that isn’t there, or when git can’t run', async () => {
    expect(await git.locate(repos.root)).toBeNull()
    expect(await git.locate(join(repos.root, 'nowhere'))).toBeNull()
    const noGit = createGit(execGit({ PATH: '/nonexistent' }))
    repos.repo('acme-api')
    expect(await noGit.locate(join(repos.root, 'acme-api'))).toBeNull()
  })
})

describe('head and reflog', () => {
  it('say where HEAD is and how it moved, newest first, each move timed to the second', async () => {
    const api = repos.repo('acme-api')
    const repo = await located(api)
    const before = await git.head(repo)
    expect(before.reflogLength).toBe(1)
    expect(before.head).toMatch(HASH)

    const started = Math.floor(Date.now() / 1000) * 1000
    repos.write('acme-api/a.txt', 'a\n')
    repos.sh('git add a.txt && git commit -q -m "Add a" && git checkout -q -b feature', api)
    const after = await git.head(repo)
    expect(after.reflogLength).toBe(3)
    const moves = await git.reflog(repo, 3)
    expect(moves.map(({ subject }) => subject)).toEqual([
      'checkout: moving from main to feature',
      'commit: Add a',
      'commit (initial): Start the Acme API',
    ])
    expect(moves[0]?.hash).toBe(after.head)
    expect(moves[0]?.at).toBeGreaterThanOrEqual(started)
    expect(await git.reflog(repo, 0)).toEqual([])
    expect(await git.branch(repo)).toBe('feature')

    repos.sh('git checkout -q --detach', api)
    expect(await git.branch(repo)).toBeNull()
  })

  it('says a repository without a commit has no HEAD and no moves', async () => {
    repos.sh('mkdir empty && cd empty && git init -q -b main')
    const repo = await located(join(repos.root, 'empty'))
    expect(await git.head(repo)).toEqual({ head: null, reflogLength: 0 })
    expect(await git.reflog(repo, 5)).toEqual([])
    expect(await git.branch(repo)).toBe('main')
  })
})

describe('commits', () => {
  it('resolves a short hash to the full one, and nothing for a name the repository doesn’t have', async () => {
    const api = repos.repo('acme-api')
    const { commonDir, worktreePath } = await located(api)
    const full = repos.sh('git rev-parse HEAD', worktreePath).trim()
    expect(await git.resolveCommit(commonDir, full.slice(0, 7))).toBe(full)
    expect(await git.resolveCommit(commonDir, 'deadbee')).toBeNull()
  })

  it('summarises commits in the order asked: parents, time, message’s first line and lines changed', async () => {
    const api = repos.repo('acme-api', { 'src/date.ts': 'one\ntwo\n' })
    repos.write('acme-api/src/date.ts', 'one\nthree\nfour\n')
    repos.sh('git commit -q -am "Fix the date test" -m "It built its date in local time."', api)
    repos.sh('git commit -q --allow-empty -m "Nothing"', api)
    const { commonDir } = await located(api)
    const [empty, fix, first] = repos.sh('git rev-list HEAD', api).trim().split('\n')
    const summaries = await git.summaries(commonDir, [fix ?? '', first ?? '', empty ?? ''])
    expect(
      summaries.map(({ subject, parents, filesChanged, additions, deletions }) => ({
        subject,
        parents: parents.length,
        filesChanged,
        additions,
        deletions,
      })),
    ).toEqual([
      { subject: 'Fix the date test', parents: 1, filesChanged: 1, additions: 2, deletions: 1 },
      { subject: 'Start the Acme API', parents: 0, filesChanged: 1, additions: 2, deletions: 0 },
      { subject: 'Nothing', parents: 1, filesChanged: 0, additions: 0, deletions: 0 },
    ])
    expect(summaries[0]?.committedAt).toBeGreaterThan(0)
    expect(await git.summaries(commonDir, [])).toEqual([])
  })

  it('still summarises the others when one of them is gone', async () => {
    const api = repos.repo('acme-api')
    const { commonDir } = await located(api)
    const head = repos.sh('git rev-parse HEAD', api).trim()
    const gone = 'f'.repeat(40)
    expect((await git.summaries(commonDir, [gone, head])).map(({ hash }) => hash)).toEqual([head])
    expect(await git.summaries(commonDir, [gone])).toEqual([])
  })
})

describe('files', () => {
  it('lists a commit’s files: added, modified, deleted, renamed (with where from) and binary', async () => {
    const api = repos.repo('acme-api', {
      'docs/upgrade.md': '# Upgrading\n\nRead the release notes first.\nThen the migrations.\n',
      'src/date.ts': 'one\n',
      'old.txt': 'gone\n',
    })
    repos.sh('git mv docs/upgrade.md docs/upgrading.md && printf "More.\\n" >> docs/upgrading.md', api)
    repos.write('acme-api/src/date.ts', 'two\nthree\n')
    repos.write('acme-api/docs/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]))
    repos.sh('git rm -q old.txt && git add -A && git commit -q -m "Change everything"', api)
    const { commonDir } = await located(api)
    const head = repos.sh('git rev-parse HEAD', api).trim()
    expect(await git.files(commonDir, head)).toEqual([
      { path: 'docs/logo.png', oldPath: null, status: CommitFileStatus.Added, additions: null, deletions: null },
      {
        path: 'docs/upgrading.md',
        oldPath: 'docs/upgrade.md',
        status: CommitFileStatus.Renamed,
        additions: 1,
        deletions: 0,
      },
      { path: 'old.txt', oldPath: null, status: CommitFileStatus.Deleted, additions: 0, deletions: 1 },
      { path: 'src/date.ts', oldPath: null, status: CommitFileStatus.Modified, additions: 2, deletions: 1 },
    ])
  })

  it('lists a merge commit’s files against its first parent: what the merge brought in', async () => {
    const api = repos.repo('acme-api')
    repos.sh('git checkout -q -b docs && printf "x\\n" > docs.md && git add docs.md && git commit -q -m "Docs"', api)
    repos.sh('git checkout -q main && printf "y\\n" > main.md && git add main.md && git commit -q -m "Main"', api)
    repos.sh('git merge -q --no-ff -m "Merge the docs" docs', api)
    const { commonDir } = await located(api)
    const merge = repos.sh('git rev-parse HEAD', api).trim()
    expect((await git.files(commonDir, merge)).map(({ path }) => path)).toEqual(['docs.md'])
    const [summary] = await git.summaries(commonDir, [merge])
    expect(summary).toMatchObject({ subject: 'Merge the docs', filesChanged: 1, additions: 1, deletions: 0 })
    expect(summary?.parents).toHaveLength(2)
  })

  it('fails for a commit the repository doesn’t have', async () => {
    const api = repos.repo('acme-api')
    const { commonDir } = await located(api)
    await expect(git.files(commonDir, 'f'.repeat(40))).rejects.toThrow(/Couldn't read the files/)
  })

  it('reads a file as a commit left it, up to what’s asked, with its whole size; none for a path it hasn’t', async () => {
    const api = repos.repo('acme-api', { 'src/date.ts': 'export const header = 1\n' })
    const { commonDir } = await located(api)
    const head = repos.sh('git rev-parse HEAD', api).trim()
    const whole = await git.fileAt(commonDir, head, 'src/date.ts', 1024)
    expect(whole?.bytes.toString()).toBe('export const header = 1\n')
    expect(whole?.size).toBe(24)
    const part = await git.fileAt(commonDir, head, 'src/date.ts', 6)
    expect(part?.bytes.toString()).toBe('export')
    expect(part?.size).toBe(24)
    expect(await git.fileAt(commonDir, head, 'src/missing.ts', 1024)).toBeNull()
    expect(await git.fileAt(commonDir, `${head}^`, 'src/date.ts', 1024)).toBeNull()
  })

  it('reads nothing when git can’t read the blob, even once it knows its size', async () => {
    let calls = 0
    const flaky: GitRun = async (args, cwd, maxBytes) => {
      calls += 1
      return calls === 1 ? TEST_GIT_RUN(args, cwd, maxBytes) : { ok: false, stdout: Buffer.from(''), truncated: false }
    }
    const api = repos.repo('acme-api')
    const { commonDir } = await located(api)
    const head = repos.sh('git rev-parse HEAD', api).trim()
    expect(await createGit(flaky).fileAt(commonDir, head, 'README.md', 1024)).toBeNull()
  })
})

describe('the parsers', () => {
  it('skip reflog lines and commit records that aren’t whole', () => {
    const hash = 'a'.repeat(40)
    expect(parseReflog(`${hash}\x1fcommit: A\x1fHEAD@{12}\nnot a line\n${hash}\x1fonly two`)).toEqual([
      { hash, subject: 'commit: A', at: 12_000 },
    ])
    expect(parseReflog(`${hash}\x1fcommit: A\x1fHEAD@{soon}`)).toEqual([{ hash, subject: 'commit: A', at: 0 }])
    expect(parseSummaries(`\x1e${hash}\x1f\x1f7\n\x1enot a hash\x1f\x1f1\n\x1e${hash}`)).toEqual([
      { hash, parents: [], committedAt: 7000, subject: '', filesChanged: 0, additions: 0, deletions: 0 },
    ])
  })

  it('reads a copy as added, a type change as modified, and a file whose lines it can’t count as binary', () => {
    const raw = ':100644 100644 aaa bbb C75\0a.txt\0b.txt\0:100644 120000 aaa bbb T\0link\0:100644 100644 a b M\0x\0'
    expect(parseCommitFiles(`${raw}1\t0\t\0a.txt\0b.txt\0`)).toEqual([
      { path: 'b.txt', oldPath: null, status: CommitFileStatus.Added, additions: 1, deletions: 0 },
      { path: 'link', oldPath: null, status: CommitFileStatus.Modified, additions: null, deletions: null },
      { path: 'x', oldPath: null, status: CommitFileStatus.Modified, additions: null, deletions: null },
    ])
  })
})

describe('execGit', () => {
  it('reads what git prints, up to the most it’s allowed, and says when it was cut short', async () => {
    const api = repos.repo('acme-api', { 'big.txt': 'x'.repeat(4096) })
    const whole = await TEST_GIT_RUN(['cat-file', 'blob', 'HEAD:big.txt'], api, 1 << 20)
    expect(whole).toMatchObject({ ok: true, truncated: false })
    expect(whole.stdout).toHaveLength(4096)
    const cut = await TEST_GIT_RUN(['cat-file', 'blob', 'HEAD:big.txt'], api, 100)
    expect(cut).toMatchObject({ ok: false, truncated: true })
    expect(cut.stdout.length).toBeLessThanOrEqual(4096)
    const failed = await TEST_GIT_RUN(['rev-parse', '--verify', 'nowhere'], api, 100)
    expect(failed).toMatchObject({ ok: false, truncated: false })
    // With no folder, it runs where Glade runs.
    expect((await TEST_GIT_RUN(['--version'], null, 100)).ok).toBe(true)
  })
})
