/**
 * The GitHub link watcher's fallback path, without a `gh` token (#682): slow, unauthenticated REST polling of public
 * links only (the spike found conditional requests still cost the unauthenticated 60/hour, so there's no cheaper
 * way). One request per link, stopping at the first rate limit rather than spending the rest of the budget on one
 * poll. A private repo, or one that's gone, answers 404 and is simply left out: nothing to show for it without a
 * token, same as GraphQL leaving a target out it can't see.
 */
import { z } from 'zod'
import { GithubLinkKind, GithubLinkState } from '../../shared/githubWatch'
import { backoffFor, rateLimitHeadersOf } from './backoff'
import { epochMsOf, type FetchedLinkState, type WatchTarget } from './query'
import type { FetchImpl } from './graphql'

const restStateSchema = z.enum(['open', 'closed'])

const issueResponseSchema = z.object({
  title: z.string(),
  state: restStateSchema,
  closed_at: z.string().nullable(),
  comments: z.number(),
})

const pullRequestResponseSchema = z.object({
  title: z.string(),
  state: restStateSchema,
  merged: z.boolean(),
  merged_at: z.string().nullable(),
  closed_at: z.string().nullable(),
  draft: z.boolean(),
  comments: z.number(),
  head: z.object({ sha: z.string() }),
})

/** The REST fallback reads no checks, reviews or merge-queue membership: those cost extra requests it can't spare. */
function fetchedFromIssue(issue: z.infer<typeof issueResponseSchema>): FetchedLinkState {
  return {
    state: issue.state === 'open' ? GithubLinkState.Open : GithubLinkState.Closed,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    commentCount: issue.comments,
    headOid: null,
    title: issue.title,
    mergedAt: null,
    closedAt: epochMsOf(issue.closed_at),
  }
}

function fetchedFromPullRequest(pr: z.infer<typeof pullRequestResponseSchema>): FetchedLinkState {
  return {
    state: pr.state === 'open' ? GithubLinkState.Open : GithubLinkState.Closed,
    merged: pr.merged,
    draft: pr.draft,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    commentCount: pr.comments,
    headOid: pr.head.sha,
    title: pr.title,
    mergedAt: epochMsOf(pr.merged_at),
    closedAt: epochMsOf(pr.closed_at),
  }
}

function restUrl(target: WatchTarget): string {
  const kind = target.kind === GithubLinkKind.PullRequest ? 'pulls' : 'issues'
  return `https://api.github.com/repos/${target.owner}/${target.repo}/${kind}/${String(target.number)}`
}

export type RestBatchResult =
  | { readonly outcome: 'fetched'; readonly fetched: ReadonlyMap<WatchTarget, FetchedLinkState> }
  | {
      readonly outcome: 'backoff'
      readonly waitMs: number
      readonly fetched: ReadonlyMap<WatchTarget, FetchedLinkState>
    }

/**
 * Asks GitHub's REST API about each target in turn, unauthenticated. Stops at the first rate limit, keeping what it
 * already fetched; otherwise answers `fetched` with everything it could read (a 404, or any other non-2xx, just
 * leaves that one target out).
 */
export async function fetchWatchBatchRest(
  targets: readonly WatchTarget[],
  fetchImpl: FetchImpl = fetch,
): Promise<RestBatchResult> {
  const fetched = new Map<WatchTarget, FetchedLinkState>()
  for (const target of targets) {
    const response = await fetchImpl(restUrl(target), { headers: { Accept: 'application/vnd.github+json' } })
    const waitMs = backoffFor(rateLimitHeadersOf(response))
    if (waitMs !== null) return { outcome: 'backoff', waitMs, fetched }
    if (!response.ok) continue
    const body: unknown = await response.json()
    if (target.kind === GithubLinkKind.PullRequest) {
      const parsed = pullRequestResponseSchema.safeParse(body)
      if (parsed.success) fetched.set(target, fetchedFromPullRequest(parsed.data))
    } else {
      const parsed = issueResponseSchema.safeParse(body)
      if (parsed.success) fetched.set(target, fetchedFromIssue(parsed.data))
    }
  }
  return { outcome: 'fetched', fetched }
}
