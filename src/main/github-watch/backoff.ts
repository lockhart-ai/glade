/**
 * Backing off GitHub's rate limits (#682): on a 403 or 429, from either the GraphQL endpoint (with a token) or the
 * REST one (without), read how long to wait before trying again, from whichever header it gave, and nothing else.
 */

/** A response's status and the headers that say when to try again, read generically so neither client repeats this. */
export interface RateLimitHeaders {
  readonly status: number
  /** Seconds to wait, from a `retry-after` header; the surest signal, when it's there. */
  readonly retryAfterSeconds: number | null
  /** When the limit resets, as `x-ratelimit-reset` gives it: whole seconds since the epoch. */
  readonly rateLimitResetAt: number | null
}

/** The least to back off on a 403 or 429 with neither header: GitHub's own minimum for a secondary rate limit. */
export const MIN_BACKOFF_MS = 60_000

/**
 * How long to wait before the next poll, in milliseconds, from a response's status and headers: null when the
 * response wasn't rate-limited (not 403 or 429), so there's nothing to back off for. `retry-after` wins when it's
 * given; otherwise `x-ratelimit-reset` if it's still in the future; otherwise `MIN_BACKOFF_MS`.
 */
export function backoffFor(headers: RateLimitHeaders, now: number = Date.now()): number | null {
  if (headers.status !== 403 && headers.status !== 429) return null
  if (headers.retryAfterSeconds !== null) return Math.max(headers.retryAfterSeconds * 1000, MIN_BACKOFF_MS)
  if (headers.rateLimitResetAt !== null) {
    const untilReset = headers.rateLimitResetAt * 1000 - now
    if (untilReset > 0) return Math.max(untilReset, MIN_BACKOFF_MS)
  }
  return MIN_BACKOFF_MS
}

/** Reads `RateLimitHeaders` off a fetch `Response`-like object: whatever has `status` and `headers.get`. */
export function rateLimitHeadersOf(response: { status: number; headers: { get(name: string): string | null } }) {
  const retryAfter = response.headers.get('retry-after')
  const reset = response.headers.get('x-ratelimit-reset')
  const retryAfterSeconds = retryAfter === null ? null : Number.parseInt(retryAfter, 10)
  const rateLimitResetAt = reset === null ? null : Number.parseInt(reset, 10)
  return {
    status: response.status,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : null,
    rateLimitResetAt: Number.isFinite(rateLimitResetAt) ? rateLimitResetAt : null,
  } satisfies RateLimitHeaders
}
