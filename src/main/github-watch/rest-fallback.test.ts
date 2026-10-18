import { expect, it, vi } from 'vitest'
import { GithubLinkKind, GithubLinkState } from '../../shared/githubWatch'
import type { FetchImpl } from './graphql'
import { fetchWatchBatchRest } from './rest-fallback'
import type { WatchTarget } from './query'

const PR: WatchTarget = {
  taskId: 't1',
  url: 'https://github.com/acme/api/pull/412',
  owner: 'acme',
  repo: 'api',
  number: 412,
  kind: GithubLinkKind.PullRequest,
}
const ISSUE: WatchTarget = {
  taskId: 't1',
  url: 'https://github.com/acme/api/issues/7',
  owner: 'acme',
  repo: 'api',
  number: 7,
  kind: GithubLinkKind.Issue,
}

function response(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  }
}

it('reads a pull request’s public fields, with no checks, review or merge-queue data', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(
    response(200, {
      title: 'Port the chat cases',
      state: 'open',
      merged: false,
      draft: false,
      comments: 2,
      head: { sha: 'abc123' },
    }),
  ) as unknown as FetchImpl

  const result = await fetchWatchBatchRest([PR], fetchImpl)

  expect(result).toEqual({
    outcome: 'fetched',
    fetched: new Map([
      [
        PR,
        {
          state: GithubLinkState.Open,
          merged: false,
          draft: false,
          inMergeQueue: false,
          checksState: null,
          checksSummary: null,
          reviewState: null,
          commentCount: 2,
          headOid: 'abc123',
          title: 'Port the chat cases',
        },
      ],
    ]),
  })
  expect(fetchImpl).toHaveBeenCalledWith(
    'https://api.github.com/repos/acme/api/pulls/412',
    expect.objectContaining({ headers: { Accept: 'application/vnd.github+json' } }),
  )
})

it('reads an issue’s public fields', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValue(
      response(200, { title: 'Flaky login test', state: 'closed', comments: 1 }),
    ) as unknown as FetchImpl

  const result = await fetchWatchBatchRest([ISSUE], fetchImpl)

  expect(result.fetched.get(ISSUE)).toMatchObject({ state: GithubLinkState.Closed, commentCount: 1, headOid: null })
  expect(fetchImpl).toHaveBeenCalledWith('https://api.github.com/repos/acme/api/issues/7', expect.anything())
})

it('leaves out a link that is gone or private (404), asking nothing further for it', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(404, { message: 'Not Found' })) as unknown as FetchImpl

  const result = await fetchWatchBatchRest([PR], fetchImpl)

  expect(result).toEqual({ outcome: 'fetched', fetched: new Map() })
})

it('stops at the first rate limit, keeping what it already fetched', async () => {
  const fetchImpl = vi
    .fn()
    .mockResolvedValueOnce(response(200, { title: 'Flaky login test', state: 'open', comments: 0 }))
    .mockResolvedValueOnce(response(403, {}, { 'retry-after': '120' })) as unknown as FetchImpl

  const result = await fetchWatchBatchRest([ISSUE, PR], fetchImpl)

  expect(result.outcome).toBe('backoff')
  expect(result.outcome === 'backoff' && result.waitMs).toBe(120_000)
  expect(result.fetched.has(ISSUE)).toBe(true)
  expect(result.fetched.has(PR)).toBe(false)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
})

it('skips a response that does not parse as the shape expected, without throwing', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(response(200, { oops: true })) as unknown as FetchImpl

  expect(await fetchWatchBatchRest([PR], fetchImpl)).toEqual({ outcome: 'fetched', fetched: new Map() })
})
