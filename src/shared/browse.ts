/**
 * The Files tab's Browse tab (#398): the workspace's tree, a folder at a time, and finding its files by name or path.
 * Pure, so main (which lists and searches) and the renderer (which shows the matches) share it. Paths are relative to
 * the workspace root, POSIX, with `''` for the root itself.
 */

/** The most matches a search answers with; it says how many more there are past them. */
export const MAX_SEARCH_RESULTS = 200

/** The longest search a `files.search` takes, in characters. */
export const MAX_SEARCH_QUERY = 200

/** The most folders `files.watchFolders` watches for one task at a time. */
export const MAX_WATCHED_FOLDERS = 500

/** The names the tree and search never show, at any depth: git's own folder, and Glade's. */
export const HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git', '.glade'])

/** What an entry of a folder is. */
export enum FolderEntryKind {
  Folder = 'folder',
  File = 'file',
}

/** One entry of a folder, as the tree shows it. */
export interface FolderEntry {
  readonly name: string
  /** Relative to the workspace root: the folder's path and the name. */
  readonly path: string
  readonly kind: FolderEntryKind
  /** A file's size in bytes, as it was when the folder was listed. A folder has none, nor a file that went meanwhile. */
  readonly size?: number
}

/** What a search of the workspace's files found. */
export interface FileSearchResult {
  /** The first matches (at most `MAX_SEARCH_RESULTS`), best first: relative to the workspace root. */
  readonly paths: readonly string[]
  /** How many more files match past them. */
  readonly more: number
  /** The size of each of `paths` in bytes, by path. */
  readonly sizes: Readonly<Record<string, number>>
}

/** Where a search matches a path: the characters `start` up to `end`. */
export interface MatchRange {
  readonly start: number
  readonly end: number
}

/** How well a path matches: its file name starting with the search, its name holding it, or only its folders. */
export enum MatchRank {
  NameStart = 'name_start',
  Name = 'name',
  Path = 'path',
}

/** The ranks, best first. */
const RANK_ORDER: readonly MatchRank[] = [MatchRank.NameStart, MatchRank.Name, MatchRank.Path]

/** A path's match: where it is and how good it is. */
export interface PathMatch extends MatchRange {
  readonly rank: MatchRank
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * Orders names (or paths) as the tree and search list them: case and accents aside, with numbers by their value
 * (`file2` before `file10`); names that differ only in case keep a fixed order.
 */
export function compareNames(a: string, b: string): number {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0)
}

/** A folder's entries in the tree's order: its folders, then its files, each by name. */
export function sortEntries(entries: readonly FolderEntry[]): FolderEntry[] {
  return [...entries].sort((a, b) =>
    a.kind === b.kind ? compareNames(a.name, b.name) : a.kind === FolderEntryKind.Folder ? -1 : 1,
  )
}

/** The path of an entry named `name` in the folder at `folder` (`''` for the root). */
export function childPath(folder: string, name: string): string {
  return folder === '' ? name : `${folder}/${name}`
}

/** The folder a path is in (`''` for the root's own entries). */
export function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/** Whether a path passes through a name the tree never shows (`.git`, `.glade`). */
export function isHiddenPath(path: string): boolean {
  return path.split('/').some((part) => HIDDEN_NAMES.has(part))
}

/** A search as it's matched: trimmed, and without regard to case. Empty for no search. */
export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase()
}

/**
 * Where a search (from `normalizeQuery`) matches a path, without regard to case: in its file name if it can (the
 * first place there), or else the first place in the whole path. Null when it doesn't match, or there's no search.
 */
export function matchPath(path: string, query: string): PathMatch | null {
  if (query === '') return null
  const lower = path.toLowerCase()
  const nameStart = path.lastIndexOf('/') + 1
  const inName = lower.indexOf(query, nameStart)
  if (inName !== -1) {
    return {
      start: inName,
      end: inName + query.length,
      rank: inName === nameStart ? MatchRank.NameStart : MatchRank.Name,
    }
  }
  const anywhere = lower.indexOf(query)
  return anywhere === -1 ? null : { start: anywhere, end: anywhere + query.length, rank: MatchRank.Path }
}

/** The paths a search matches, best first: by `MatchRank`, then by path. */
export function rankMatches(paths: Iterable<string>, query: string): string[] {
  const matched: { path: string; rank: MatchRank }[] = []
  for (const path of paths) {
    const match = matchPath(path, query)
    if (match !== null) matched.push({ path, rank: match.rank })
  }
  matched.sort((a, b) => RANK_ORDER.indexOf(a.rank) - RANK_ORDER.indexOf(b.rank) || compareNames(a.path, b.path))
  return matched.map(({ path }) => path)
}
