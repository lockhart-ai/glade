// The Changes tab's commands (`./changes`) against real git repositories: a commit's files, opening one, reading one as
// the commit left it, and whether a workspace is a repository.
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BridgeErrorCode, EventType, type GladeEvent } from '../../shared/bridge'
import { CommitFileStatus, FileContentKind, type Task } from '../../shared/domain'
import { commitFileKey, MAX_COMMIT_FILES, MAX_FILE_LINES } from '../../shared/files'
import { CommandFailure } from '../bridge/errors'
import { listTaskCommits } from '../db/repositories/task-commits'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { appendToolCall } from '../db/repositories/tool-events'
import { createGit } from '../git/git'
import { openTestRepos, TEST_GIT_RUN, type TestRepos } from '../git/test-repos'
import { commitFiles, openCommitFile, readCommitFile, workspaceInRepository, type ChangesContext } from './changes'
import { createChangeTracker } from './tracker'

let database: TestDatabase
let repos: TestRepos
let api: string
let task: Task
let events: GladeEvent[]
let context: ChangesContext

// Each test runs many real git commands: slow while the whole suite runs at once.
vi.setConfig({ testTimeout: 30_000 })

beforeEach(() => {
  database = openTestDatabase()
  repos = openTestRepos()
  api = repos.repo('acme-api', { 'src/date.ts': 'export const header = 1\n', 'docs/upgrade.md': '# Upgrading\n' })
  task = sampleTask(database.db, sampleWorkspace(database.db, api).id)
  events = []
  context = { db: database.db, emit: (event) => events.push(event), git: createGit(TEST_GIT_RUN) }
})

afterEach(() => {
  repos.close()
  database.close()
})

let calls = 0

/** The task's agent runs a command that commits, as the tracker sees it. Answers the id of the newest commit. */
async function commit(command: string, cwd = api, taskId = task.id): Promise<string> {
  const tracker = createChangeTracker({ db: database.db, emit: () => undefined, git: context.git })
  calls += 1
  const toolUseId = `toolu_${String(calls)}`
  appendToolCall(database.db, { taskId, turn: 1, name: 'Bash', input: { command }, toolUseId, parentToolUseId: null })
  await tracker.bashStarting(taskId, { toolUseId, cwd, command })
  const output = repos.sh(command, cwd)
  await tracker.bashFinished(taskId, { toolUseId, command, output, cwd: api })
  const [newest] = listTaskCommits(database.db, taskId)
  if (newest === undefined) throw new Error('nothing was committed')
  return newest.id
}

describe('commitFiles', () => {
  it('lists the files a commit changed', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    const id = await commit('git commit -qam "Fix the UTC date test"')
    expect(await commitFiles(context, task.id, id)).toEqual({
      files: [{ path: 'src/date.ts', oldPath: null, status: CommitFileStatus.Modified, additions: 1, deletions: 1 }],
      total: 1,
    })
  })

  it('caps a huge commit’s list, and says how many there are in all', async () => {
    for (let index = 0; index < MAX_COMMIT_FILES + 42; index++) {
      repos.write(`acme-api/generated/file-${String(index).padStart(3, '0')}.ts`, `export const n = ${String(index)}\n`)
    }
    const id = await commit('git add -A && git commit -q -m "Generate the clients"')
    const { files, total } = await commitFiles(context, task.id, id)
    expect(files).toHaveLength(MAX_COMMIT_FILES)
    expect(total).toBe(MAX_COMMIT_FILES + 42)
    expect(files[0]).toEqual({
      path: 'generated/file-000.ts',
      oldPath: null,
      status: CommitFileStatus.Added,
      additions: 1,
      deletions: 0,
    })
    expect(listTaskCommits(database.db, task.id)[0]?.filesChanged).toBe(MAX_COMMIT_FILES + 42)
  })

  it('still reads a worktree’s commit after the worktree is removed', async () => {
    repos.sh('git worktree add -q -b docs/upgrade ../acme-api-docs', api)
    const worktree = join(repos.root, 'acme-api-docs')
    const id = await commit('git mv docs/upgrade.md docs/upgrading.md && git commit -q -m "Rename the guide"', worktree)
    repos.sh('git worktree remove --force ../acme-api-docs', api)
    expect((await commitFiles(context, task.id, id)).files).toEqual([
      {
        path: 'docs/upgrading.md',
        oldPath: 'docs/upgrade.md',
        status: CommitFileStatus.Renamed,
        additions: 0,
        deletions: 0,
      },
    ])
  })

  it('fails for a commit that isn’t the task’s, and one its repository no longer has', async () => {
    const other = sampleTask(database.db, task.workspaceId, 3_000)
    const id = await commit('git commit -q --allow-empty -m "Another task’s"', api, other.id)
    await expect(commitFiles(context, task.id, id)).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })
    await expect(commitFiles(context, task.id, 'nope')).rejects.toBeInstanceOf(CommandFailure)
    await expect(commitFiles(context, 'no-task', id)).rejects.toMatchObject({ code: BridgeErrorCode.NotFound })

    // A commit made on a branch that's since deleted, and the objects pruned.
    const dropped = await commit('git checkout -q -b spike && git commit -q --allow-empty -m "Spike"', api)
    repos.sh(
      'git checkout -q main && git branch -q -D spike && git reflog expire --expire=now --all && git gc -q --prune=now',
      api,
    )
    await expect(commitFiles(context, task.id, dropped)).rejects.toThrow(/Couldn't read the files/)
  })
})

describe('openCommitFile', () => {
  it('opens a file that’s still in the workspace as it is now, and shows it', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    const id = await commit('git commit -qam "Fix the UTC date test"')
    const openFiles = await openCommitFile(context, task.id, id, 'src/date.ts')
    expect(openFiles).toEqual({ taskId: task.id, paths: ['src/date.ts'], activePath: 'src/date.ts' })
    expect(events).toEqual([{ type: EventType.OpenFilesChanged, openFiles }])
  })

  it('opens one that’s gone from its path, or outside the workspace, as the commit left it', async () => {
    const deleted = await commit('git rm -q docs/upgrade.md && git commit -q -m "Drop the guide"')
    const key = commitFileKey({ commitId: deleted, path: 'docs/upgrade.md' })
    expect((await openCommitFile(context, task.id, deleted, 'docs/upgrade.md')).activePath).toBe(key)

    repos.sh('git worktree add -q -b docs ../acme-api-docs', api)
    const worktree = join(repos.root, 'acme-api-docs')
    const outside = await commit('printf "x\\n" > notes.md && git add notes.md && git commit -q -m "Notes"', worktree)
    expect((await openCommitFile(context, task.id, outside, 'notes.md')).activePath).toBe(
      commitFileKey({ commitId: outside, path: 'notes.md' }),
    )
  })

  it('opens a symlink that leads out of the workspace as the commit left it', async () => {
    repos.write('secret.txt', 'not the workspace’s\n')
    const id = await commit('ln -s ../secret.txt link.txt && git add link.txt && git commit -q -m "Link"')
    expect((await openCommitFile(context, task.id, id, 'link.txt')).activePath).toBe(
      commitFileKey({ commitId: id, path: 'link.txt' }),
    )
  })

  it('opens a file as the commit left it when the workspace’s folder is gone', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    const id = await commit('git commit -qam "Fix"')
    const gone = sampleTask(database.db, sampleWorkspace(database.db, join(repos.root, 'gone')).id, 4_000)
    database.db.prepare('UPDATE task_commits SET task_id = ?').run(gone.id)
    expect((await openCommitFile(context, gone.id, id, 'src/date.ts')).activePath).toBe(
      commitFileKey({ commitId: id, path: 'src/date.ts' }),
    )
  })

  it('fails for a commit that isn’t the task’s', async () => {
    await expect(openCommitFile(context, task.id, 'nope', 'src/date.ts')).rejects.toMatchObject({
      code: BridgeErrorCode.NotFound,
    })
  })
})

describe('readCommitFile', () => {
  it('reads a file as the commit left it, even after it changed since', async () => {
    repos.write('acme-api/src/date.ts', 'export const header = 2\n')
    const id = await commit('git commit -qam "Fix the UTC date test"')
    repos.write('acme-api/src/date.ts', 'export const header = 3\n')
    expect(await readCommitFile(context, task.id, { commitId: id, path: 'src/date.ts' })).toEqual({
      kind: FileContentKind.Text,
      text: 'export const header = 2\n',
      truncated: false,
      size: 24,
    })
  })

  it('reads a file the commit deleted as it was before, a binary one as binary, a long one cut short', async () => {
    const deleted = await commit('git rm -q docs/upgrade.md && git commit -q -m "Drop the guide"')
    expect(await readCommitFile(context, task.id, { commitId: deleted, path: 'docs/upgrade.md' })).toMatchObject({
      kind: FileContentKind.Text,
      text: '# Upgrading\n',
    })

    repos.write('acme-api/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    repos.write('acme-api/long.txt', 'line\n'.repeat(MAX_FILE_LINES + 10))
    const added = await commit('git add -A && git commit -q -m "Add the logo and a long file"')
    expect(await readCommitFile(context, task.id, { commitId: added, path: 'logo.png' })).toEqual({
      kind: FileContentKind.Binary,
      size: 6,
    })
    expect(await readCommitFile(context, task.id, { commitId: added, path: 'long.txt' })).toMatchObject({
      kind: FileContentKind.Text,
      truncated: true,
    })
  })

  it('reads nothing for a path the commit never had, or a commit that isn’t the task’s', async () => {
    const id = await commit('git commit -q --allow-empty -m "Nothing"')
    expect(await readCommitFile(context, task.id, { commitId: id, path: 'src/nowhere.ts' })).toEqual({
      kind: FileContentKind.Missing,
    })
    expect(await readCommitFile(context, task.id, { commitId: 'nope', path: 'src/date.ts' })).toEqual({
      kind: FileContentKind.Missing,
    })
  })
})

describe('workspaceInRepository', () => {
  it('says whether the task’s workspace root is in a repository', async () => {
    expect(await workspaceInRepository(context, task.id)).toBe(true)
    const plain = sampleTask(database.db, sampleWorkspace(database.db, repos.root).id, 4_000)
    expect(await workspaceInRepository(context, plain.id)).toBe(false)
  })

  it('reads git once for it', async () => {
    const locate = vi.spyOn(context.git, 'locate')
    await workspaceInRepository(context, task.id)
    expect(locate).toHaveBeenCalledExactlyOnceWith(api)
  })
})
