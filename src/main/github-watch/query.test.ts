import { expect, it } from 'vitest'
import { GithubChecksState, GithubLinkKind, GithubLinkState } from '../../shared/githubWatch'
import { aliasOf, buildWatchQuery, parseWatchResponse, type WatchTarget } from './query'

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

function pullRequestResponse(overrides: Record<string, unknown> = {}) {
  return {
    title: 'Port the chat cases',
    state: 'OPEN',
    merged: false,
    mergedAt: null,
    closedAt: null,
    isDraft: false,
    mergeQueueEntry: null,
    comments: { totalCount: 2 },
    reviews: { nodes: [{ state: 'APPROVED' }] },
    commits: {
      nodes: [
        {
          commit: {
            oid: 'abc123',
            statusCheckRollup: {
              state: 'FAILURE',
              contexts: {
                totalCount: 14,
                nodes: [
                  { __typename: 'CheckRun', conclusion: 'SUCCESS' },
                  { __typename: 'CheckRun', conclusion: 'FAILURE' },
                ],
              },
            },
          },
        },
      ],
    },
    ...overrides,
  }
}

const issueResponse = (overrides: Record<string, unknown> = {}) => ({
  title: 'Flaky login test',
  state: 'OPEN',
  closedAt: null,
  comments: { totalCount: 1 },
  ...overrides,
})

it('aliases each target in order, l0, l1, …', () => {
  expect(aliasOf(0)).toBe('l0')
  expect(aliasOf(1)).toBe('l1')
})

it('builds one query aliasing every target’s repository, a pull request or an issue by its kind', () => {
  const query = buildWatchQuery([PR, ISSUE])

  expect(query).toContain('l0: repository(owner: "acme", name: "api") {')
  expect(query).toContain('pullRequest(number: 412)')
  expect(query).toContain('l1: repository(owner: "acme", name: "api") {')
  expect(query).toContain('issue(number: 7)')
})

it('escapes an owner or repo name as a GraphQL string literal', () => {
  const query = buildWatchQuery([{ ...PR, owner: 'ac"me', repo: 'a\\pi' }])
  expect(query).toContain('owner: "ac\\"me"')
  expect(query).toContain('name: "a\\\\pi"')
})

it('parses a pull request’s fields, the checks summary counting successes over the total', () => {
  const body = { data: { l0: { pullRequest: pullRequestResponse() } } }

  const fetched = parseWatchResponse(body, [PR])

  expect(fetched.get(PR)).toEqual({
    state: GithubLinkState.Open,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: GithubChecksState.Failure,
    checksSummary: '1/14',
    reviewState: 'APPROVED',
    commentCount: 2,
    headOid: 'abc123',
    title: 'Port the chat cases',
    mergedAt: null,
    closedAt: null,
  })
})

it('reads a closed, merged, draft PR in the merge queue, with the times GitHub recorded for it', () => {
  const body = {
    data: {
      l0: {
        pullRequest: pullRequestResponse({
          state: 'CLOSED',
          merged: true,
          mergedAt: '2026-10-18T17:38:00Z',
          closedAt: '2026-10-18T17:38:01Z',
          isDraft: true,
          mergeQueueEntry: { id: 'q1' },
        }),
      },
    },
  }

  const fetched = parseWatchResponse(body, [PR])

  expect(fetched.get(PR)).toMatchObject({
    state: GithubLinkState.Closed,
    merged: true,
    draft: true,
    inMergeQueue: true,
    mergedAt: new Date('2026-10-18T17:38:00Z').getTime(),
    closedAt: new Date('2026-10-18T17:38:01Z').getTime(),
  })
})

it('parses an issue’s fields, with none of a PR’s', () => {
  const body = { data: { l0: { issue: issueResponse() } } }

  const fetched = parseWatchResponse(body, [ISSUE])

  expect(fetched.get(ISSUE)).toEqual({
    state: GithubLinkState.Open,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    commentCount: 1,
    headOid: null,
    title: 'Flaky login test',
    mergedAt: null,
    closedAt: null,
  })
})

it('reads a closed issue’s close time, and none of a merge time', () => {
  const body = { data: { l0: { issue: issueResponse({ state: 'CLOSED', closedAt: '2026-10-18T17:38:00Z' }) } } }

  expect(parseWatchResponse(body, [ISSUE]).get(ISSUE)).toMatchObject({
    state: GithubLinkState.Closed,
    mergedAt: null,
    closedAt: new Date('2026-10-18T17:38:00Z').getTime(),
  })
})

it('treats a timestamp that does not parse as a date as unknown, leaving a first fetch silent', () => {
  const body = {
    data: {
      l0: {
        pullRequest: pullRequestResponse({ state: 'CLOSED', merged: true, mergedAt: 'not a date', closedAt: null }),
      },
    },
  }

  expect(parseWatchResponse(body, [PR]).get(PR)).toMatchObject({ mergedAt: null, closedAt: null })
})

it('has no checks state or summary for a PR with no checks reporting yet', () => {
  const body = {
    data: {
      l0: {
        pullRequest: pullRequestResponse({
          commits: { nodes: [{ commit: { oid: 'abc123', statusCheckRollup: null } }] },
        }),
      },
    },
  }

  expect(parseWatchResponse(body, [PR]).get(PR)).toMatchObject({ checksState: null, checksSummary: null })
})

it('reads success and pending rollup states, and treats an unknown one as pending', () => {
  const withState = (state: string) =>
    parseWatchResponse(
      {
        data: {
          l0: {
            pullRequest: pullRequestResponse({
              commits: {
                nodes: [
                  { commit: { oid: 'abc123', statusCheckRollup: { state, contexts: { totalCount: 0, nodes: [] } } } },
                ],
              },
            }),
          },
        },
      },
      [PR],
    ).get(PR)?.checksState

  expect(withState('SUCCESS')).toBe(GithubChecksState.Success)
  expect(withState('PENDING')).toBe(GithubChecksState.Pending)
  expect(withState('EXPECTED')).toBe(GithubChecksState.Pending)
})

it('leaves out a target GitHub answered with nothing (gone, or private to this token)', () => {
  const body = { data: { l0: null } }

  expect(parseWatchResponse(body, [PR]).has(PR)).toBe(false)
})

it('throws on a body that is not shaped like a GraphQL response', () => {
  expect(() => parseWatchResponse({ oops: true }, [PR])).toThrow()
})
