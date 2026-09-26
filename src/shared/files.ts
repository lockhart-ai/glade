/**
 * Files in a task's workspace, as the Files tab and `files.*` commands see them: paths relative to the workspace root,
 * and the open file tabs. Pure, so main and the renderer share it (the renderer has no `node:path`). Paths are POSIX:
 * Glade runs on macOS.
 */
import type { OpenFiles } from './domain'

/**
 * The most of a file the viewer reads, in bytes. A larger file shows its first part, with a notice, so the viewer stays
 * responsive however large the file is.
 */
export const MAX_FILE_BYTES = 512 * 1024

/** The most lines the viewer shows; a longer file shows its first lines, with a notice. */
export const MAX_FILE_LINES = 5000

/** A path with `.` and `..` resolved and repeated or trailing slashes removed. `..` above an absolute root stays at it. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length > 0 && parts.at(-1) !== '..') parts.pop()
      else if (!absolute) parts.push(part)
      continue
    }
    parts.push(part)
  }
  const joined = parts.join('/')
  return absolute ? `/${joined}` : joined
}

/**
 * A file's path relative to the workspace root, from a path that's absolute or relative to the root (as a tool's input
 * may give it). Null when it's outside the root, or is the root itself. Only the text is compared: symlinks aren't
 * followed (main checks those before reading a file).
 */
export function workspaceRelativePath(path: string, rootPath: string): string | null {
  const root = normalizePath(rootPath)
  const full = normalizePath(path.startsWith('/') ? path : `${root}/${path}`)
  const prefix = root === '/' ? '/' : `${root}/`
  if (!full.startsWith(prefix)) return null
  const relative = full.slice(prefix.length)
  return relative === '' ? null : relative
}

/** Whether `path` is one the Files tab can hold: relative, normalized, inside the root and not the root itself. */
export function isWorkspaceRelativePath(path: string): boolean {
  return (
    path !== '' && !path.startsWith('/') && normalizePath(path) === path && path !== '..' && !path.startsWith('../')
  )
}

/** A task with no files open. */
export function noOpenFiles(taskId: string): OpenFiles {
  return { taskId, paths: [], activePath: null }
}

/** The files with `path` open and showing: a new tab at the end, or the tab it already has. */
export function withOpenedFile(openFiles: OpenFiles, path: string): OpenFiles {
  const paths = openFiles.paths.includes(path) ? openFiles.paths : [...openFiles.paths, path]
  return { ...openFiles, paths, activePath: path }
}

/**
 * The files with `path`'s tab closed. Closing the tab showing shows the one after it, or the one before when it was
 * last, as a browser does.
 */
export function withClosedFile(openFiles: OpenFiles, path: string): OpenFiles {
  const index = openFiles.paths.indexOf(path)
  if (index === -1) return openFiles
  const paths = openFiles.paths.filter((open) => open !== path)
  const activePath = openFiles.activePath === path ? (paths[index] ?? paths[index - 1] ?? null) : openFiles.activePath
  return { ...openFiles, paths, activePath }
}

/** The most files an expanded commit lists in the Changes tab; a larger one ends with "and N more". */
export const MAX_COMMIT_FILES = 100

/**
 * What a commit file's key starts with. A path relative to the workspace root never starts with `/`, so a key is never
 * taken for one.
 */
const COMMIT_FILE_PREFIX = '/commit/'

/** A file as one of a task's commits left it, open read-only in the Files tab. */
export interface CommitFileRef {
  /** The commit's id, as the task has it (`TaskCommit.id`). */
  readonly commitId: string
  /** Relative to the top of the commit's repository. */
  readonly path: string
}

/**
 * The key a commit's file is open under in the Files tab: `/commit/<commit id>/<path>`. The Changes tab opens a file
 * this way when it's no longer at its path in the workspace (deleted since, its worktree removed).
 */
export function commitFileKey({ commitId, path }: CommitFileRef): string {
  return `${COMMIT_FILE_PREFIX}${commitId}/${path}`
}

/** The commit's file an open file's key names; null for a path in the workspace, or a key that isn't well formed. */
export function parseCommitFileKey(key: string): CommitFileRef | null {
  if (!key.startsWith(COMMIT_FILE_PREFIX)) return null
  const rest = key.slice(COMMIT_FILE_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const path = rest.slice(slash + 1)
  return isWorkspaceRelativePath(path) ? { commitId: rest.slice(0, slash), path } : null
}

/** A file's name: the last part of its path. */
export function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}
