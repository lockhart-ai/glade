/**
 * The GitHub link watcher (#682): what main keeps of each GitHub pull request or issue a task has linked (its last
 * state fetched, kept current by polling), and what it tells the windows when one changes. Nothing draws this yet;
 * #683 builds the richer link rows that will.
 */
import type { EpochMs } from './domain'

/** What a watched link is, from its URL (`recogniseLink` in `./artifactLinks`). */
export enum GithubLinkKind {
  Issue = 'issue',
  PullRequest = 'pull_request',
}

/** Whether the issue or PR is still open. A merged PR is also closed; `merged` says which. */
export enum GithubLinkState {
  Open = 'open',
  Closed = 'closed',
}

/** How its latest commit's checks stand, from `statusCheckRollup`; null when it has none (an issue, or no checks yet). */
export enum GithubChecksState {
  Success = 'success',
  Failure = 'failure',
  Pending = 'pending',
}

/**
 * Whether GitHub can merge a pull request as it stands, as its APIs name the answer (`mergeable` in GraphQL and REST;
 * the REST fallback also reads `mergeable_state`). GitHub works the answer out lazily, so a poll often gets UNKNOWN.
 * Only ever answered for a pull request.
 */
export enum PrMergeable {
  Mergeable = 'MERGEABLE',
  Conflicting = 'CONFLICTING',
  Unknown = 'UNKNOWN',
}

/**
 * What the GitHub link watcher last knew of one of a task's linked issues or PRs: everything it polls for, and
 * whether it's still being polled (`watching` turns to 0 once the link closed or merged, whichever came first;
 * the row stays, so the last state it saw keeps showing). A link whose todo is done keeps being polled (#738).
 */
export interface GithubLinkWatch {
  readonly taskId: string
  readonly url: string
  readonly kind: GithubLinkKind
  readonly state: GithubLinkState
  /** Only ever true for a pull request. */
  readonly merged: boolean
  /** Only ever true for a pull request. */
  readonly draft: boolean
  readonly inMergeQueue: boolean
  readonly checksState: GithubChecksState | null
  /** E.g. `13/14`; null when there's nothing to summarise (no checks, or none yet reporting). */
  readonly checksSummary: string | null
  /** The latest review's state (`APPROVED`, `CHANGES_REQUESTED`, …), as GitHub's GraphQL API names it; null for none. */
  readonly reviewState: string | null
  /**
   * The last mergeability answer the watcher has of the PR: `MERGEABLE` or `CONFLICTING`, whatever the newest poll
   * said, an UNKNOWN answer keeping the one before it (#771). Null when GitHub hasn't answered one yet, or for an
   * issue, which has no mergeability. Only ever one of the two for a pull request.
   */
  readonly mergeable: PrMergeable | null
  readonly commentCount: number
  /** Its latest commit's SHA; null for an issue, or a PR with none yet seen. */
  readonly headOid: string | null
  /** GitHub's own title, which may differ from the artifact's own (you may have renamed that). */
  readonly title: string
  readonly watching: boolean
  readonly lastFetchedAt: EpochMs
}
