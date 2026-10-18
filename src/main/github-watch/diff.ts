/**
 * What changed about one watched link, from what a poll found and what was known of it before (#682): a line per
 * change worth waking the task for, each gated by its own setting, and whether the link is still worth polling.
 * Pure: no database, no network, so every case is a plain fixture.
 */
import { GithubChecksState, GithubLinkState, type GithubLinkWatch } from '../../shared/githubWatch'
import type { FetchedLinkState } from './query'

/** Which kinds of change wake a task, from Settings › GitHub watching. */
export interface WatchWakeSettings {
  readonly onStateChange: boolean
  readonly onChecksFinished: boolean
  readonly onReviewsComments: boolean
  readonly onNewCommits: boolean
}

/** A review's state, as GitHub's GraphQL enum has it, in words: `APPROVED` → `approved`. */
function reviewWords(state: string): string {
  return state.toLowerCase().replaceAll('_', ' ')
}

/** What changed of an issue or PR's own state: opened again, closed, merged, or entered or left the merge queue. */
function stateChange(previous: GithubLinkWatch, next: FetchedLinkState): string | null {
  if (previous.state !== next.state) {
    if (next.state === GithubLinkState.Closed) return next.merged ? 'merged' : 'closed'
    return 'reopened'
  }
  if (previous.inMergeQueue !== next.inMergeQueue) {
    return next.inMergeQueue ? 'entered the merge queue' : 'left the merge queue'
  }
  return null
}

/** Whether its checks just finished: were still running (or unknown) before, and have an answer now. */
function checksJustFinished(previous: GithubLinkWatch, next: FetchedLinkState): boolean {
  const wasUnfinished = previous.checksState === null || previous.checksState === GithubChecksState.Pending
  const nowFinished = next.checksState === GithubChecksState.Success || next.checksState === GithubChecksState.Failure
  return wasUnfinished && nowFinished
}

function checksLine(next: FetchedLinkState): string {
  const verdict = next.checksState === GithubChecksState.Success ? 'CI passed' : 'CI failed'
  return next.checksSummary === null ? verdict : `${verdict} (${next.checksSummary})`
}

/**
 * The changes worth telling the agent about, each a short clause (`wake.ts` joins them with "; " for one link's
 * line), gated by `settings`. Nothing to say for a link polled for the first time: there's nothing yet to compare it
 * against, so the first poll only ever establishes the baseline, silently.
 */
export function diffLinkState(
  previous: GithubLinkWatch | undefined,
  next: FetchedLinkState,
  settings: WatchWakeSettings,
): readonly string[] {
  if (previous === undefined) return []
  const lines: string[] = []
  if (settings.onStateChange) {
    const changed = stateChange(previous, next)
    if (changed !== null) lines.push(changed)
  }
  if (settings.onChecksFinished && checksJustFinished(previous, next)) lines.push(checksLine(next))
  if (settings.onReviewsComments) {
    const newComments = next.commentCount - previous.commentCount
    if (newComments > 0) lines.push(`${String(newComments)} new comment${newComments === 1 ? '' : 's'}`)
    if (next.reviewState !== null && next.reviewState !== previous.reviewState) {
      lines.push(`new review: ${reviewWords(next.reviewState)}`)
    }
  }
  if (settings.onNewCommits && next.headOid !== null && next.headOid !== previous.headOid) {
    lines.push('new commits pushed')
  }
  return lines
}

/** Whether a link is still worth polling: open, not yet closed or merged. */
export function stillWatching(next: FetchedLinkState): boolean {
  return next.state === GithubLinkState.Open
}
