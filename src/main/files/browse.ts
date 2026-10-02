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

/**
 * What an entry of a folder is to the tree: a folder or a file, following a symlink only to something inside the root;
 * null for anything else (a symlink out of the root or to nothing, a socket, a pipe).
 */
async function entryKind(rootPath: string, path: string, entry: Dirent): Promise<FolderEntryKind | null> {
  if (entry.isDirectory()) return FolderEntryKind.Folder
  if (entry.isFile()) return FolderEntryKind.File
  if (!entry.isSymbolicLink()) return null
  try {
    const real = await resolveWorkspaceFile(rootPath, path)
    if (real === null) return null
    const info = await stat(real)
    if (info.isDirectory()) return FolderEntryKind.Folder
    return info.isFile() ? FolderEntryKind.File : null
  } catch {
    // It leads outside the root (not followed), or went as it was looked at.
    return null
  }
}

/**
 * The entries of a folder of the workspace (`''` for the root), as the tree shows them: folders first, then files,
 * each by name, without what's hidden. Null when there's no folder there (any more). Throws a `CommandFailure`
 * (`outside_workspace`) for a path that a symlink takes outside the root.
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
  const listed: FolderEntry[] = []
  for (const entry of found) {
    if (ignored.has(entry.name)) continue
    const entryPath = childPath(path, entry.name)
    const kind = await entryKind(rootPath, entryPath, entry)
    if (kind !== null) listed.push({ name: entry.name, path: entryPath, kind })
  }
  return sortEntries(listed)
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
 * Whether a path a listing found is a file the viewer can open: a file, or a symlink to one inside the root. Not a
 * folder (an untracked repository inside the workspace, a submodule), nor a file git still tracks but that's gone.
 */
async function isOpenableFile(rootPath: string, root: string, path: string): Promise<boolean> {
  try {
    const info = await lstat(join(root, path))
    if (info.isFile()) return true
    if (!info.isSymbolicLink()) return false
    const real = await resolveWorkspaceFile(rootPath, path)
    return real !== null && (await stat(real)).isFile()
  } catch {
    return false
  }
}

/**
 * The workspace's files whose name or path holds `query`, without regard to case, best first (`rankMatches`): the
 * first `MAX_SEARCH_RESULTS`, and how many more. Hides what the tree hides. Outside a git repository it looks through
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
  if (wanted === '') return { paths: [], more: 0 }
  // A repository's untracked folder (another repository in it) comes back with a trailing `/`; a file listed twice
  // (in a merge, once for each side) counts once.
  const listed = (await git.files(root))?.filter((path) => !path.endsWith('/')) ?? (await walkFiles(root, walkLimit))
  const matches = rankMatches(new Set(listed.filter((path) => !isHiddenPath(path))), wanted)
  const paths: string[] = []
  let looked = 0
  for (const path of matches) {
    if (paths.length === MAX_SEARCH_RESULTS) break
    looked++
    if (await isOpenableFile(rootPath, root, path)) paths.push(path)
  }
  return { paths, more: matches.length - looked }
}
