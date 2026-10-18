import { expect, it } from 'vitest'
import { backoffFor, MIN_BACKOFF_MS, rateLimitHeadersOf } from './backoff'

const NOW = 1_000_000

it('is nothing for a response that was not rate-limited', () => {
  expect(backoffFor({ status: 200, retryAfterSeconds: null, rateLimitResetAt: null }, NOW)).toBeNull()
  expect(backoffFor({ status: 404, retryAfterSeconds: 30, rateLimitResetAt: null }, NOW)).toBeNull()
})

it('honours retry-after, never less than the minimum', () => {
  expect(backoffFor({ status: 429, retryAfterSeconds: 90, rateLimitResetAt: null }, NOW)).toBe(90_000)
  expect(backoffFor({ status: 403, retryAfterSeconds: 5, rateLimitResetAt: null }, NOW)).toBe(MIN_BACKOFF_MS)
})

it('falls back to the rate limit reset when there is no retry-after, never less than the minimum', () => {
  expect(
    backoffFor({ status: 403, retryAfterSeconds: null, rateLimitResetAt: Math.floor(NOW / 1000) + 120 }, NOW),
  ).toBe(120_000)
  expect(backoffFor({ status: 403, retryAfterSeconds: null, rateLimitResetAt: Math.floor(NOW / 1000) + 5 }, NOW)).toBe(
    MIN_BACKOFF_MS,
  )
})

it('falls back to the minimum when the reset has already passed or neither header is given', () => {
  expect(backoffFor({ status: 429, retryAfterSeconds: null, rateLimitResetAt: Math.floor(NOW / 1000) - 10 }, NOW)).toBe(
    MIN_BACKOFF_MS,
  )
  expect(backoffFor({ status: 429, retryAfterSeconds: null, rateLimitResetAt: null }, NOW)).toBe(MIN_BACKOFF_MS)
})

function response(status: number, headers: Readonly<Record<string, string>>) {
  return { status, headers: { get: (name: string) => headers[name] ?? null } }
}

it('reads the headers off a response, falling back to null for one that is missing or not a number', () => {
  expect(rateLimitHeadersOf(response(429, { 'retry-after': '30', 'x-ratelimit-reset': '1700000000' }))).toEqual({
    status: 429,
    retryAfterSeconds: 30,
    rateLimitResetAt: 1_700_000_000,
  })
  expect(rateLimitHeadersOf(response(403, {}))).toEqual({
    status: 403,
    retryAfterSeconds: null,
    rateLimitResetAt: null,
  })
  expect(rateLimitHeadersOf(response(403, { 'retry-after': 'soon' }))).toEqual({
    status: 403,
    retryAfterSeconds: null,
    rateLimitResetAt: null,
  })
})
