/**
 * What changed about one watched link, from what a poll found and what was known of it before (#682): a line per
 * change worth waking the task for, each gated by its own setting, and whether the link is still worth polling.
 * Pure: no database, no network, so every case is a plain fixture.
 */
import type { EpochMs } from '../../shared/domain'
import { GithubChecksState, GithubLinkState, PrMergeable, type GithubLinkWatch } from '../../shared/githubWatch'
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

/**
 * What changed of a PR's mergeability between two polls that both have answers to compare (#771): GitHub now
 * conflicting where it could merge before, or the other way. Only for a PR still open — a closed or merged one is
 * never reported as conflicting. An UNKNOWN answer (`next`) is never one of the two values here, and leaves the
 * previous one standing (`mergeableKept`), so it can neither be reported nor flap a report that was already made.
 */
function mergeableChange(previous: GithubLinkWatch, next: FetchedLinkState): string | null {
  if (next.state !== GithubLinkState.Open) return null
  if (previous.mergeable === PrMergeable.Mergeable && next.mergeable === PrMergeable.Conflicting) {
    return 'has merge conflicts'
  }
  if (previous.mergeable === PrMergeable.Conflicting && next.mergeable === PrMergeable.Mergeable) {
    return 'merge conflicts resolved'
  }
  return null
}

/**
 * What to record of a poll's mergeability answer: an answer at all, unless it's UNKNOWN or there is none — GitHub
 * works mergeability out lazily, so either only says it has nothing to add, and the last known answer stands (#771).
 */
export function mergeableKept(previous: GithubLinkWatch | undefined, next: FetchedLinkState): PrMergeable | null {
  if (next.mergeable === null || next.mergeable === PrMergeable.Unknown) return previous?.mergeable ?? null
  return next.mergeable
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
 * line), gated by `settings`. For a link polled for the first time there's nothing yet to compare the poll against,
 * so only one thing is ever said (#728): a merge or close GitHub itself recorded after the link was added to the
 * task (`linkedAt`, the artifact's creation time) — one that predates the link stays silent, same as everything
 * else about the first poll, which only ever establishes the baseline.
 */
export function diffLinkState(
  previous: GithubLinkWatch | undefined,
  next: FetchedLinkState,
  settings: WatchWakeSettings,
  linkedAt: EpochMs,
): readonly string[] {
  if (previous === undefined) {
    if (!settings.onStateChange || next.state !== GithubLinkState.Closed) return []
    const happenedAt = next.merged ? next.mergedAt : next.closedAt
    if (happenedAt === null || happenedAt <= linkedAt) return []
    return [next.merged ? 'merged' : 'closed']
  }
  const lines: string[] = []
  if (settings.onStateChange) {
    const changed = stateChange(previous, next)
    if (changed !== null) lines.push(changed)
    const mergeable = mergeableChange(previous, next)
    if (mergeable !== null) lines.push(mergeable)
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
