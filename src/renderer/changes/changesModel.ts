/**
 * What a commit's tile says about the commit and its files (`../todos/tiles/CommitTile`). Pure, so it's tested on its
 * own.
 */
import { CommitFileStatus, type CommitFile, type TaskCommit } from '../../shared/domain'

/** How many characters of a hash a tile shows, as git's short hashes are. */
export const SHORT_HASH_LENGTH = 7

/** A commit's hash as the tab shows it: `a1b2c3d`. */
export function shortHash(hash: string): string {
  return hash.slice(0, SHORT_HASH_LENGTH)
}

const NUMBER = new Intl.NumberFormat('en-US')

/** Lines added, as the tab shows them: `+12`, `+1,204`. */
export function additionsLabel(lines: number): string {
  return `+${NUMBER.format(lines)}`
}

/** Lines removed, as the tab shows them, with a true minus sign: `−3`. */
export function deletionsLabel(lines: number): string {
  return `−${NUMBER.format(lines)}`
}

/** The branch a commit was made on, as it's shown: its name, or `detached` for one made on a detached HEAD. */
export function branchLabel({ branch }: Pick<TaskCommit, 'branch'>): string {
  return branch ?? 'detached'
}

/** What a merge commit is marked with. */
export const MERGE_LABEL = 'merge'

/** What a subagent the tool log hasn't got is called, where something says which subagent made it. */
export const UNKNOWN_SUBAGENT = 'Subagent'

/** The tooltip of the tag that says which subagent made a commit. */
export function madeByTitle(name: string): string {
  return `Made by the subagent “${name}”`
}

/** The letter a file's status shows as, as `git status --short` has them: A, M, D, R. */
export function statusLetter(status: CommitFileStatus): string {
  switch (status) {
    case CommitFileStatus.Added:
      return 'A'
    case CommitFileStatus.Modified:
      return 'M'
    case CommitFileStatus.Deleted:
      return 'D'
    case CommitFileStatus.Renamed:
      return 'R'
  }
}

/** A file's status in words, for its letter's label: `Added`, `Modified`, `Deleted`, `Renamed`. */
export function statusName(status: CommitFileStatus): string {
  switch (status) {
    case CommitFileStatus.Added:
      return 'Added'
    case CommitFileStatus.Modified:
      return 'Modified'
    case CommitFileStatus.Deleted:
      return 'Deleted'
    case CommitFileStatus.Renamed:
      return 'Renamed'
  }
}

/** A file's path as its row shows it: a renamed one's from and to, `src/a.ts → src/b.ts`. */
export function filePathLabel(file: CommitFile): string {
  return file.oldPath === null ? file.path : `${file.oldPath} → ${file.path}`
}

/** What the end of a capped file list says: `and 412 more files`, `and 1 more file`. */
export function moreFilesLabel(shown: number, total: number): string | null {
  const more = total - shown
  if (more <= 0) return null
  return `and ${NUMBER.format(more)} more ${more === 1 ? 'file' : 'files'}`
}
