/**
 * The GitHub link watcher's authenticated path (#682): one GraphQL request a poll, with the machine's `gh` token.
 * Building the query and parsing the response are pure (`./query`); this is the one place that calls `fetch`.
 */
import { backoffFor, rateLimitHeadersOf } from './backoff'
import { buildWatchQuery, parseWatchResponse, type FetchedLinkState, type WatchTarget } from './query'

const GRAPHQL_ENDPOINT = 'https://api.github.com/graphql'

export type FetchImpl = typeof fetch

/** What one poll's GraphQL request found. */
export type GraphqlBatchResult =
  | { readonly outcome: 'fetched'; readonly fetched: ReadonlyMap<WatchTarget, FetchedLinkState> }
  /** The token's no good any more: the caller re-reads it (`../github-watch/token`'s `invalidate`) and retries once. */
  | { readonly outcome: 'unauthorized' }
  /** Rate-limited: wait this long before the next poll. */
  | { readonly outcome: 'backoff'; readonly waitMs: number }

/**
 * Asks GitHub's GraphQL API about every target in one request, with `token`. Answers `fetched` with what it found
 * (a target GitHub had nothing to say of, gone or private to this token, is simply missing from the map), or
 * `unauthorized` on a 401, or `backoff` on a 403 or 429. `targets` empty answers `fetched` with nothing, asking
 * GitHub nothing.
 */
export async function fetchWatchBatch(
  token: string,
  targets: readonly WatchTarget[],
  fetchImpl: FetchImpl = fetch,
): Promise<GraphqlBatchResult> {
  if (targets.length === 0) return { outcome: 'fetched', fetched: new Map() }
  const response = await fetchImpl(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ query: buildWatchQuery(targets) }),
  })
  if (response.status === 401) return { outcome: 'unauthorized' }
  const waitMs = backoffFor(rateLimitHeadersOf(response))
  if (waitMs !== null) return { outcome: 'backoff', waitMs }
  const body: unknown = await response.json()
  return { outcome: 'fetched', fetched: parseWatchResponse(body, targets) }
}
