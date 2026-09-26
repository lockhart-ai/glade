/**
 * What the Changes tab says about a task's commits and their files (`docs/design/html/24-changes.html`). Pure, so it's
 * tested on its own.
 */
import {
  CommitFileStatus,
  ToolEventKind,
  type CommitFile,
  type EpochMs,
  type TaskCommit,
  type ToolEvent,
} from '../../shared/domain'
import { subagentName } from '../subagents/subagentsModel'
import { formatAgo } from '../task-header/headerModel'

/** How many characters of a hash the tab shows, as git's short hashes are. */
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

/**
 * The line under a commit's message: its branch (or `detached`), when it was made, and `merge` for a merge commit:
 * `main · 12m ago`, `fix/date-test · just now · merge`.
 */
export function commitMeta(commit: TaskCommit, now: EpochMs): string {
  const parts = [commit.branch ?? 'detached', formatAgo(commit.committedAt, now)]
  if (commit.merge) parts.push('merge')
  return parts.join(' · ')
}

/**
 * Who made a commit, when a subagent did: the subagent's name, from its `Agent` call in the tool log (a subagent the
 * log hasn't got says `Subagent`). Null when the task's own agent made it.
 */
export function madeBy(commit: TaskCommit, events: readonly ToolEvent[]): string | null {
  const { subagentToolUseId } = commit
  if (subagentToolUseId === null) return null
  const call = events.find((event) => event.kind === ToolEventKind.ToolCall && event.toolUseId === subagentToolUseId)
  return call?.kind === ToolEventKind.ToolCall ? subagentName(call) : 'Subagent'
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
