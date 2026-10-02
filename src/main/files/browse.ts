/**
 * The Files tab's Browse tab (#398): a folder of a task's workspace, listed a level at a time, and its files found by
 * name or path. Only ever inside the workspace root, as reading a file is (`./files`): a folder is resolved against the
 * root's real path, and a symlink in it is listed only when it leads to a file or folder inside the root.
 *
 * What's hidden: `.git` and `.glade` always, at any depth, and, when the workspace is in a git repository, whatever git
 * ignores there (its `.gitignore` files, `.git/info/exclude` and your global excludes), asked of git itself
 * (`git check-ignore` for a folder, `git ls-files` for a search) rather than parsed here. A file git tracks is never
 * hidden, even if a rule would ignore it.
 */
import type { Dirent } from 'node:fs'
import { lstat, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  childPath,
  FolderEntryKind,
  HIDDEN_NAMES,
  isHiddenPath,
  MAX_SEARCH_RESULTS,
  normalizeQuery,
  rankMatches,
  sortEntries,
  type FileSearchResult,
  type FolderEntry,
} from '../../shared/browse'
import { BridgeErrorCode } from '../../shared/bridge'
import { CommandFailure } from '../bridge/errors'
import { execGit, type GitRun } from '../git/git'
import { resolveWorkspaceFile } from './files'

/** The most output a git listing may give, in bytes: far more than a large repository's file list. */
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * The most files a search looks through in a workspace that isn't a git repository (which has no ignore rules to keep
 * a `node_modules` out): past them, it stops looking.
 */
export const MAX_WALKED_FILES = 50_000

/** What the Browse tab asks of git. Each answers as if nothing is ignored when git can't say (no repository, no git). */
export interface WorkspaceGit {
  /** Which of the entries named in the folder `dir` (absolute) git ignores. */
  ignored(dir: string, names: readonly string[]): Promise<ReadonlySet<string>>
  /**
   * The files under `dir` (absolute) that git tracks or would add (`ls-files --cached --others --exclude-standard`),
   * relative to it; null when `dir` isn't in a repository.
   */
  files(dir: string): Promise<string[] | null>
}

/** The NUL-separated entries of a command's output. */
function entries(output: Buffer): string[] {
  return output
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry !== '')
}

/** Asks git, with `run` (the `git` on the PATH, with your config, by default). */
export function createWorkspaceGit(run: GitRun = execGit()): WorkspaceGit {
  return {
    async ignored(dir, names) {
      // The names go in on its input, NUL-separated, so any name (and any number of them) passes through as it is.
      const input = names.map((name) => `${name}\0`).join('')
      const output = await run(['check-ignore', '-z', '--stdin'], dir, MAX_GIT_OUTPUT_BYTES, input)
      // It exits 1 when none is ignored, and 128 outside a repository: either way, nothing to hide.
      return new Set(output.ok ? entries(output.stdout) : [])
    },

    async files(dir) {
      const output = await run(
        ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        dir,
        MAX_GIT_OUTPUT_BYTES,
      )
      return output.ok ? entries(output.stdout) : null
    },
  }
}

/** The real path of the workspace's root, or of a path in it, resolved; null when there's nothing there. */
async function realFolder(rootPath: string, path: string): Promise<string | null> {
  const real = await resolveWorkspaceFile(rootPath, path)
  if (real === null) return null
  return (await stat(real)).isDirectory() ? real : null
}

/** What an entry of a folder is to the tree: a folder, or a file and its size in bytes (none when it couldn't be read). */
type ListedKind =
  { readonly kind: FolderEntryKind.Folder } | { readonly kind: FolderEntryKind.File; readonly size?: number }

/** A file's size in bytes, or nothing when it went between the folder's listing and this look at it. */
async function fileSize(file: string): Promise<{ size?: number }> {
  try {
    return { size: (await stat(file)).size }
  } catch {
    return {}
  }
}

/**
 * What an entry of the folder at `real` is to the tree: a folder or a file (with its size, or its target's), following
 * a symlink only to something inside the root; null for anything else (a symlink out of the root or to nothing, a
 * socket, a pipe).
 */
async function entryKind(rootPath: string, real: string, path: string, entry: Dirent): Promise<ListedKind | null> {
  if (entry.isDirectory()) return { kind: FolderEntryKind.Folder }
  if (entry.isFile()) return { kind: FolderEntryKind.File, ...(await fileSize(join(real, entry.name))) }
  if (!entry.isSymbolicLink()) return null
  try {
    const target = await resolveWorkspaceFile(rootPath, path)
    if (target === null) return null
    const info = await stat(target)
    if (info.isDirectory()) return { kind: FolderEntryKind.Folder }
    return info.isFile() ? { kind: FolderEntryKind.File, size: info.size } : null
  } catch {
    // It leads outside the root (not followed), or went as it was looked at.
    return null
  }
}

/**
 * The entries of a folder of the workspace (`''` for the root), as the tree shows them: folders first, then files,
 * each by name, without what's hidden, each file with its size (one stat a file; a file that goes meanwhile is listed
 * without one, and the folder's watcher lists it again). Null when there's no folder there (any more). Throws a
 * `CommandFailure` (`outside_workspace`) for a path that a symlink takes outside the root.
 */
export async function listWorkspaceFolder(
  rootPath: string,
  path: string,
  git: WorkspaceGit,
): Promise<FolderEntry[] | null> {
  if (isHiddenPath(path)) return null
  const real = await realFolder(rootPath, path)
  if (real === null) return null
  const found = (await readdir(real, { withFileTypes: true })).filter(({ name }) => !HIDDEN_NAMES.has(name))
  const ignored =
    found.length === 0
      ? new Set<string>()
      : await git.ignored(
          real,
          found.map(({ name }) => name),
        )
  const listed = await Promise.all(
    found
      .filter(({ name }) => !ignored.has(name))
      .map(async (entry): Promise<FolderEntry | null> => {
        const entryPath = childPath(path, entry.name)
        const kind = await entryKind(rootPath, real, entryPath, entry)
        return kind === null ? null : { name: entry.name, path: entryPath, ...kind }
      }),
  )
  return sortEntries(listed.filter((entry) => entry !== null))
}

/**
 * The files under the root, relative to it, in a workspace that isn't a git repository: every file, but what's hidden,
 * without going into a symlinked folder, up to `limit` of them.
 */
async function walkFiles(root: string, limit: number): Promise<string[]> {
  const files: string[] = []
  const folders = ['']
  for (let folder = folders.shift(); folder !== undefined; folder = folders.shift()) {
    let found: Dirent[]
    try {
      found = await readdir(join(root, folder), { withFileTypes: true })
    } catch {
      // Gone, or not ours to read: nothing in it to find.
      continue
    }
    for (const entry of found) {
      if (HIDDEN_NAMES.has(entry.name)) continue
      const path = childPath(folder, entry.name)
      if (entry.isDirectory()) folders.push(path)
      // A symlink may be a file inside the root; whether it is, is looked at only if it matches.
      else if (entry.isFile() || entry.isSymbolicLink()) files.push(path)
      if (files.length >= limit) return files
    }
  }
  return files
}

/**
 * The size in bytes of a path a listing found, when it's a file the viewer can open: a file, or a symlink to one
 * inside the root (its target's size). Null for a folder (an untracked repository inside the workspace, a submodule),
 * or a file git still tracks but that's gone.
 */
async function openableFileSize(rootPath: string, root: string, path: string): Promise<number | null> {
  try {
    const info = await lstat(join(root, path))
    if (info.isFile()) return info.size
    if (!info.isSymbolicLink()) return null
    const real = await resolveWorkspaceFile(rootPath, path)
    if (real === null) return null
    const target = await stat(real)
    return target.isFile() ? target.size : null
  } catch {
    return null
  }
}

/**
 * The workspace's files whose name or path holds `query`, without regard to case, best first (`rankMatches`): the
 * first `MAX_SEARCH_RESULTS` with their sizes, and how many more. Hides what the tree hides. Outside a git repository it looks through
 * at most `walkLimit` files. Throws a `CommandFailure` (`not_found`) when the workspace's folder isn't there.
 */
export async function searchWorkspaceFiles(
  rootPath: string,
  query: string,
  git: WorkspaceGit,
  walkLimit: number = MAX_WALKED_FILES,
): Promise<FileSearchResult> {
  const root = await realFolder(rootPath, '')
  if (root === null) throw new CommandFailure(BridgeErrorCode.NotFound, `The workspace's folder isn't there`)
  const wanted = normalizeQuery(query)
  if (wanted === '') return { paths: [], more: 0, sizes: {} }
  // A repository's untracked folder (another repository in it) comes back with a trailing `/`; a file listed twice
  // (in a merge, once for each side) counts once.
  const listed = (await git.files(root))?.filter((path) => !path.endsWith('/')) ?? (await walkFiles(root, walkLimit))
  const matches = rankMatches(new Set(listed.filter((path) => !isHiddenPath(path))), wanted)
  const paths: string[] = []
  const sizes: Record<string, number> = {}
  let looked = 0
  for (const path of matches) {
    if (paths.length === MAX_SEARCH_RESULTS) break
    looked++
    const size = await openableFileSize(rootPath, root, path)
    if (size === null) continue
    paths.push(path)
    sizes[path] = size
  }
  return { paths, more: matches.length - looked, sizes }
}
