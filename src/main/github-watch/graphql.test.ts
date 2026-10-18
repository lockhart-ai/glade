import { expect, it, vi } from 'vitest'
import { GithubLinkKind, GithubLinkState } from '../../shared/githubWatch'
import { fetchWatchBatch, type FetchImpl } from './graphql'
import type { WatchTarget } from './query'

const PR: WatchTarget = {
  taskId: 't1',
  url: 'https://github.com/acme/api/pull/412',
  owner: 'acme',
  repo: 'api',
  number: 412,
  kind: GithubLinkKind.PullRequest,
}

function fakeFetch(status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): FetchImpl {
  return vi.fn<FetchImpl>().mockResolvedValue({
    status,
    headers: { get: (name: string) => headers[name] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response)
}

it('answers fetched with nothing, and asks GitHub nothing, when there are no targets', async () => {
  const fetchImpl = vi.fn() as unknown as FetchImpl

  const result = await fetchWatchBatch('ghs_token', [], fetchImpl)

  expect(result).toEqual({ outcome: 'fetched', fetched: new Map() })
  expect(fetchImpl).not.toHaveBeenCalled()
})

it('posts one query with the token, and parses what it answers', async () => {
  const body = {
    data: {
      l0: {
        pullRequest: {
          title: 'Port the chat cases',
          state: 'OPEN',
          merged: false,
          mergedAt: null,
          closedAt: null,
          isDraft: false,
          mergeQueueEntry: null,
          comments: { totalCount: 0 },
          reviews: { nodes: [] },
          commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: null } }] },
        },
      },
    },
  }
  const fetchImpl = fakeFetch(200, body)

  const result = await fetchWatchBatch('ghs_token', [PR], fetchImpl)

  expect(result.outcome).toBe('fetched')
  expect(result.outcome === 'fetched' && result.fetched.get(PR)?.state).toBe(GithubLinkState.Open)
  const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
  expect(url).toBe('https://api.github.com/graphql')
  expect(init.method).toBe('POST')
  expect((init.headers as Record<string, string>).Authorization).toBe('bearer ghs_token')
  const requestBody = JSON.parse(init.body as string) as { query: string }
  expect(requestBody.query).toContain('pullRequest(number: 412)')
  // The merge and close times a first fetch compares against the link's creation (#728).
  expect(requestBody.query).toContain('mergedAt')
  expect(requestBody.query).toContain('closedAt')
})

it('reports unauthorized on a 401, without touching the body', async () => {
  const fetchImpl = fakeFetch(401, {})

  expect(await fetchWatchBatch('ghs_bad', [PR], fetchImpl)).toEqual({ outcome: 'unauthorized' })
})

it('reports a backoff on a 403 or 429, reading the headers', async () => {
  const fetchImpl = fakeFetch(429, {}, { 'retry-after': '90' })

  expect(await fetchWatchBatch('ghs_token', [PR], fetchImpl)).toEqual({ outcome: 'backoff', waitMs: 90_000 })
})
