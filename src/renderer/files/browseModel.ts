/**
 * What the Files tab's Browse tab shows (#398), worked out from what it has loaded: the tree's rows, the folders to
 * watch and load, what a key does in the tree, and how a search's match is marked in a result.
 */
import { FolderEntryKind, matchPath, parentPath, type FolderEntry, type MatchRange } from '../../shared/browse'
import type { TextPart } from '../../shared/search'

/** The tree as loaded: the folders open, and each folder's entries, by path (`''` for the root). */
export interface BrowseTree {
  readonly expanded: ReadonlySet<string>
  readonly folders: ReadonlyMap<string, readonly FolderEntry[]>
}

/** One row of the tree: an entry, how deep it is (0 for the root's entries), and whether it's an open folder. */
export interface TreeRow {
  readonly entry: FolderEntry
  readonly depth: number
  readonly expanded: boolean
}

/** Whether an entry is a folder. */
export function isFolder(entry: FolderEntry): boolean {
  return entry.kind === FolderEntryKind.Folder
}

/** The tree's rows, top to bottom: the root's entries, with each open folder's under it once they've loaded. */
export function visibleRows({ expanded, folders }: BrowseTree): TreeRow[] {
  const rows: TreeRow[] = []
  const add = (folder: string, depth: number): void => {
    for (const entry of folders.get(folder) ?? []) {
      const open = isFolder(entry) && expanded.has(entry.path)
      rows.push({ entry, depth, expanded: open })
      if (open) add(entry.path, depth + 1)
    }
  }
  add('', 0)
  return rows
}

/** The folders the tree shows the entries of: the root, and every open folder that shows. What's watched. */
export function shownFolders(rows: readonly TreeRow[]): string[] {
  return ['', ...rows.filter(({ expanded }) => expanded).map(({ entry }) => entry.path)]
}

/** The folders the tree shows whose entries it hasn't loaded yet. */
export function unloadedFolders(tree: BrowseTree, rows: readonly TreeRow[]): string[] {
  return shownFolders(rows).filter((path) => !tree.folders.has(path))
}

/** The keys the tree answers. */
export enum TreeKey {
  Down = 'ArrowDown',
  Up = 'ArrowUp',
  Right = 'ArrowRight',
  Left = 'ArrowLeft',
  Enter = 'Enter',
  Home = 'Home',
  End = 'End',
}

const TREE_KEYS: ReadonlySet<string> = new Set(Object.values(TreeKey))

/** Whether the tree answers a key (pressed without modifiers). */
export function isTreeKey(key: string): key is TreeKey {
  return TREE_KEYS.has(key)
}

/** What a key in the tree does. */
export enum TreeActionKind {
  /** The focus moves to another row. */
  Focus = 'focus',
  /** ↑ on the top row: the focus goes up to the search field. */
  FocusSearch = 'focus_search',
  /** A folder opens or closes. */
  Toggle = 'toggle',
  /** A file opens in its tab. */
  Open = 'open',
}

export type TreeAction =
  | { readonly kind: TreeActionKind.Focus; readonly path: string }
  | { readonly kind: TreeActionKind.FocusSearch }
  | { readonly kind: TreeActionKind.Toggle; readonly path: string }
  | { readonly kind: TreeActionKind.Open; readonly path: string }

/**
 * What a key does with the focus on a row (the first row's, when it's on none that shows): ↑↓ move, → opens a folder
 * or goes into an open one, ← closes an open folder or goes up to the folder a row is in, ↩ opens a file or opens or
 * closes a folder, Home and End go to the first and last rows. Null when it does nothing there.
 */
export function treeKeyAction(rows: readonly TreeRow[], focused: string | null, key: TreeKey): TreeAction | null {
  const found = rows.findIndex(({ entry }) => entry.path === focused)
  const index = Math.max(found, 0)
  const row = rows[index]
  if (row === undefined) return null
  const focus = (at: number): TreeAction | null => {
    const target = rows[at]
    return target === undefined ? null : { kind: TreeActionKind.Focus, path: target.entry.path }
  }
  const { path } = row.entry
  switch (key) {
    case TreeKey.Down:
      return found === -1 ? focus(0) : focus(index + 1)
    case TreeKey.Up:
      return index === 0 ? { kind: TreeActionKind.FocusSearch } : focus(index - 1)
    case TreeKey.Home:
      return focus(0)
    case TreeKey.End:
      return focus(rows.length - 1)
    case TreeKey.Right:
      if (!isFolder(row.entry)) return null
      if (!row.expanded) return { kind: TreeActionKind.Toggle, path }
      return rows[index + 1]?.depth === row.depth + 1 ? focus(index + 1) : null
    case TreeKey.Left: {
      if (row.expanded) return { kind: TreeActionKind.Toggle, path }
      const parent = parentPath(path)
      return parent === '' ? null : { kind: TreeActionKind.Focus, path: parent }
    }
    case TreeKey.Enter:
      return isFolder(row.entry) ? { kind: TreeActionKind.Toggle, path } : { kind: TreeActionKind.Open, path }
  }
}

/** A search result's two parts, as its row shows them: the file's name, then the folder it's in. */
export interface ResultParts {
  readonly name: readonly TextPart[]
  /** Empty for a file at the root. */
  readonly folder: readonly TextPart[]
}

/** The parts of `text` (which starts at `offset` in the whole path), with what's in `range` marked. */
function markedParts(text: string, offset: number, range: MatchRange | null): TextPart[] {
  const start = range === null ? text.length : Math.min(Math.max(range.start - offset, 0), text.length)
  const end = range === null ? text.length : Math.min(Math.max(range.end - offset, 0), text.length)
  return [
    { text: text.slice(0, start), match: false },
    { text: text.slice(start, end), match: true },
    { text: text.slice(end), match: false },
  ].filter((part) => part.text !== '')
}

/** A search result's name and folder, with the search's match (from `normalizeQuery`) marked in whichever it's in. */
export function resultParts(path: string, query: string): ResultParts {
  const slash = path.lastIndexOf('/')
  const range = matchPath(path, query)
  return {
    name: markedParts(path.slice(slash + 1), slash + 1, range),
    folder: slash === -1 ? [] : markedParts(path.slice(0, slash), 0, range),
  }
}

/** The units a file's size shows in: each 1,000 of the one before, as Finder counts. */
export enum SizeUnit {
  Bytes = 'B',
  Kilobytes = 'KB',
  Megabytes = 'MB',
  Gigabytes = 'GB',
}

/** A file's size as its row shows it: the number, then its unit in a slot of its own, so the digits line up. */
export interface FormattedSize {
  readonly value: string
  readonly unit: SizeUnit
}

const LARGER_UNITS: readonly SizeUnit[] = [SizeUnit.Kilobytes, SizeUnit.Megabytes, SizeUnit.Gigabytes]

/**
 * A size in bytes as a row shows it: whole bytes under 1,000, then KB, MB and GB (1,000 of the one before), with one
 * decimal under 100 and none from there. A size that rounds up to 1,000 of a unit moves to the next (`1.0 MB`, never
 * `1000 KB`); past GB it stays in GB.
 */
export function formatSize(bytes: number): FormattedSize {
  if (bytes < 1000) return { value: String(bytes), unit: SizeUnit.Bytes }
  let amount = bytes
  let value = ''
  let unit = SizeUnit.Bytes
  for (const larger of LARGER_UNITS) {
    amount /= 1000
    unit = larger
    const tenths = Math.round(amount * 10)
    value = tenths < 1000 ? (tenths / 10).toFixed(1) : String(Math.round(amount))
    if (Math.round(amount) < 1000) break
  }
  return { value, unit }
}

/** How many characters of a long name's end stay in view, before its extension. */
export const NAME_TAIL_LENGTH = 6

/** The longest ending that counts as an extension, with its dot: past it, a name has none. */
export const MAX_EXTENSION_LENGTH = 12

/**
 * A name in the three parts its row shows: the start, which gives way with an ellipsis when the row is too narrow;
 * the end of it, which stays; and a file's extension, dimmed, which stays too. Together they're the name.
 */
export interface NameParts {
  readonly head: string
  /** The last `NAME_TAIL_LENGTH` characters before the extension; empty for a name too short to need them. */
  readonly tail: string
  /** With its dot; empty for a folder, a dotfile (`.gitignore`) and a name without one. */
  readonly extension: string
}

/**
 * Splits a name so it truncates in the middle (#431): `test_burst_window…lients.py` rather than `test_burst_wind…`.
 * A file's extension is what follows its last dot, unless that dot starts or ends the name or what follows is longer
 * than `MAX_EXTENSION_LENGTH`; a folder has none. Split by character, so an emoji is never cut in two.
 */
export function nameParts(name: string, kind: FolderEntryKind): NameParts {
  const dot = name.lastIndexOf('.')
  const hasExtension =
    kind === FolderEntryKind.File && dot > 0 && dot < name.length - 1 && name.length - dot <= MAX_EXTENSION_LENGTH
  const extension = hasExtension ? name.slice(dot) : ''
  const stem = Array.from(name.slice(0, name.length - extension.length))
  const tailLength = stem.length > NAME_TAIL_LENGTH * 2 ? NAME_TAIL_LENGTH : 0
  return {
    head: stem.slice(0, stem.length - tailLength).join(''),
    tail: stem.slice(stem.length - tailLength).join(''),
    extension,
  }
}

/** Whether a folder is on the way down to the selected row: one of the folders it's in. */
export function isOnSelectedPath(folder: string, selected: string | null): boolean {
  return selected?.startsWith(`${folder}/`) ?? false
}

/**
 * A row's indent guides, one for each folder it's in, outermost first: whether each is lit, as the guide of a folder
 * on the way down to the selected row is.
 */
export function rowGuides(path: string, selected: string | null): boolean[] {
  const parts = path.split('/')
  return parts.slice(0, -1).map((_, index) => isOnSelectedPath(parts.slice(0, index + 1).join('/'), selected))
}
