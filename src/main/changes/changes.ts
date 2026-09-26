/**
 * The Changes tab's commands: a task's commits' files, opening one in the Files tab, reading a file as a commit left it,
 * and whether the task's workspace is in a repository at all. What the tab lists is kept by `./tracker`; this reads
 * git for what it doesn't keep, through the repository's common git dir, so a commit made in a worktree can still be
 * read after the worktree is removed.
 */
import { realpath, stat } from 'node:fs/promises'
import { BridgeErrorCode } from '../../shared/bridge'
import { FileContentKind, type CommitFiles, type FileContent, type OpenFiles } from '../../shared/domain'
import {
  commitFileKey,
  MAX_COMMIT_FILES,
  MAX_FILE_BYTES,
  workspaceRelativePath,
  type CommitFileRef,
} from '../../shared/files'
import { CommandFailure } from '../bridge/errors'
import { getTaskCommit, type StoredTaskCommit } from '../db/repositories/task-commits'
import { fileContentOf, openTaskFile, resolveWorkspaceFile, workspaceRoot } from '../files/files'
import type { Git } from '../git/git'
import type { TaskServiceContext } from '../tasks/service'

/** What the Changes tab's commands need: the database and events, and git. */
export interface ChangesContext extends TaskServiceContext {
  readonly git: Git
}

/** One of a task's commits; undefined when the task has no such commit. */
function commitOf(context: TaskServiceContext, taskId: string, id: string): StoredTaskCommit | undefined {
  const commit = getTaskCommit(context.db, id)
  return commit?.taskId === taskId ? commit : undefined
}

function requireCommit(context: TaskServiceContext, taskId: string, id: string): StoredTaskCommit {
  const commit = commitOf(context, taskId, id)
  if (commit === undefined) throw new CommandFailure(BridgeErrorCode.NotFound, `Task ${taskId} has no commit ${id}`)
  return commit
}

/** `changes.files`: the files one of a task's commits changed, the first `MAX_COMMIT_FILES`, and how many in all. */
export async function commitFiles(context: ChangesContext, taskId: string, id: string): Promise<CommitFiles> {
  workspaceRoot(context, taskId)
  const commit = requireCommit(context, taskId, id)
  const files = await context.git.files(commit.gitDir, commit.hash)
  return { files: files.slice(0, MAX_COMMIT_FILES), total: files.length }
}

/**
 * The path, relative to the workspace root, of a file that's there now at `path` (absolute); null when there's no file
 * there, or it's outside the workspace.
 */
async function currentFile(rootPath: string, path: string): Promise<string | null> {
  let root: string
  try {
    root = await realpath(rootPath)
  } catch {
    return null
  }
  const relative = workspaceRelativePath(path, root)
  if (relative === null) return null
  try {
    const real = await resolveWorkspaceFile(rootPath, relative)
    return real !== null && (await stat(real)).isFile() ? relative : null
  } catch {
    // A symlink on the way leads outside the workspace: the file isn't the workspace's to show.
    return null
  }
}

/**
 * `changes.openFile`: opens a file one of a task's commits changed in its Files tab, and shows it: as it is now when
 * it's still at its path in the workspace, else as the commit left it (its commit file key). Broadcasts
 * `openFiles.changed`.
 */
export async function openCommitFile(
  context: ChangesContext,
  taskId: string,
  id: string,
  path: string,
): Promise<OpenFiles> {
  const root = workspaceRoot(context, taskId)
  const commit = requireCommit(context, taskId, id)
  const current = await currentFile(root, `${commit.repoPath}/${path}`)
  return openTaskFile(context, taskId, current ?? commitFileKey({ commitId: id, path }))
}

/**
 * A file as one of a task's commits left it, for the viewer (`files.read` with a commit file key): read from git, as
 * any file is read (`fileContentOf`). A file the commit deleted shows as it was before. Missing when the task has no
 * such commit, or its repository no longer has the file.
 */
export async function readCommitFile(
  context: ChangesContext,
  taskId: string,
  { commitId, path }: CommitFileRef,
): Promise<FileContent> {
  workspaceRoot(context, taskId)
  const commit = commitOf(context, taskId, commitId)
  if (commit === undefined) return { kind: FileContentKind.Missing }
  const { git } = context
  const blob =
    (await git.fileAt(commit.gitDir, commit.hash, path, MAX_FILE_BYTES)) ??
    (await git.fileAt(commit.gitDir, `${commit.hash}^`, path, MAX_FILE_BYTES))
  return blob === null ? { kind: FileContentKind.Missing } : fileContentOf(blob.bytes, blob.size)
}

/** `changes.repository`: whether the task's workspace root is in a git repository. */
export async function workspaceInRepository(context: ChangesContext, taskId: string): Promise<boolean> {
  return (await context.git.locate(workspaceRoot(context, taskId))) !== null
}
