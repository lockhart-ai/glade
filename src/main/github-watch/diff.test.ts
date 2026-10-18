import { expect, it } from 'vitest'
import { GithubChecksState, GithubLinkKind, GithubLinkState, type GithubLinkWatch } from '../../shared/githubWatch'
import { diffLinkState, stillWatching, type WatchWakeSettings } from './diff'
import type { FetchedLinkState } from './query'

const ALL_ON: WatchWakeSettings = {
  onStateChange: true,
  onChecksFinished: true,
  onReviewsComments: true,
  onNewCommits: true,
}

const PREVIOUS: GithubLinkWatch = {
  taskId: 't1',
  url: 'https://github.com/acme/api/pull/412',
  kind: GithubLinkKind.PullRequest,
  state: GithubLinkState.Open,
  merged: false,
  draft: false,
  inMergeQueue: false,
  checksState: GithubChecksState.Pending,
  checksSummary: null,
  reviewState: null,
  commentCount: 0,
  headOid: 'abc123',
  title: 'Port the chat cases',
  watching: true,
  lastFetchedAt: 1,
}

const UNCHANGED: FetchedLinkState = {
  state: PREVIOUS.state,
  merged: PREVIOUS.merged,
  draft: PREVIOUS.draft,
  inMergeQueue: PREVIOUS.inMergeQueue,
  checksState: PREVIOUS.checksState,
  checksSummary: PREVIOUS.checksSummary,
  reviewState: PREVIOUS.reviewState,
  commentCount: PREVIOUS.commentCount,
  headOid: PREVIOUS.headOid,
  title: PREVIOUS.title,
}

it('says nothing for a link polled for the first time, whatever it finds', () => {
  expect(diffLinkState(undefined, { ...UNCHANGED, state: GithubLinkState.Closed, merged: true }, ALL_ON)).toEqual([])
})

it('says nothing when nothing changed', () => {
  expect(diffLinkState(PREVIOUS, UNCHANGED, ALL_ON)).toEqual([])
})

it('reports merged, closed and reopened, gated by onStateChange', () => {
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, state: GithubLinkState.Closed, merged: true }, ALL_ON)).toEqual([
    'merged',
  ])
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, state: GithubLinkState.Closed, merged: false }, ALL_ON)).toEqual([
    'closed',
  ])
  const closed = { ...PREVIOUS, state: GithubLinkState.Closed }
  expect(diffLinkState(closed, { ...UNCHANGED, state: GithubLinkState.Open }, ALL_ON)).toEqual(['reopened'])
  expect(
    diffLinkState(
      PREVIOUS,
      { ...UNCHANGED, state: GithubLinkState.Closed, merged: true },
      { ...ALL_ON, onStateChange: false },
    ),
  ).toEqual([])
})

it('reports entering and leaving the merge queue', () => {
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, inMergeQueue: true }, ALL_ON)).toEqual(['entered the merge queue'])
  const queued = { ...PREVIOUS, inMergeQueue: true }
  expect(diffLinkState(queued, { ...UNCHANGED, inMergeQueue: false }, ALL_ON)).toEqual(['left the merge queue'])
})

it('reports CI finishing, gated by onChecksFinished, but not while still pending or already reported', () => {
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, checksState: GithubChecksState.Success }, ALL_ON)).toEqual([
    'CI passed',
  ])
  expect(
    diffLinkState(PREVIOUS, { ...UNCHANGED, checksState: GithubChecksState.Failure, checksSummary: '13/14' }, ALL_ON),
  ).toEqual(['CI failed (13/14)'])
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, checksState: GithubChecksState.Pending }, ALL_ON)).toEqual([])
  const alreadyGreen = { ...PREVIOUS, checksState: GithubChecksState.Success }
  expect(diffLinkState(alreadyGreen, { ...UNCHANGED, checksState: GithubChecksState.Success }, ALL_ON)).toEqual([])
  expect(
    diffLinkState(
      PREVIOUS,
      { ...UNCHANGED, checksState: GithubChecksState.Success },
      { ...ALL_ON, onChecksFinished: false },
    ),
  ).toEqual([])
})

it('reports new comments, pluralised, and a new review, gated by onReviewsComments', () => {
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, commentCount: 1 }, ALL_ON)).toEqual(['1 new comment'])
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, commentCount: 3 }, ALL_ON)).toEqual(['3 new comments'])
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, reviewState: 'CHANGES_REQUESTED' }, ALL_ON)).toEqual([
    'new review: changes requested',
  ])
  const reviewed = { ...PREVIOUS, reviewState: 'APPROVED' }
  // The same review again says nothing new.
  expect(diffLinkState(reviewed, { ...UNCHANGED, reviewState: 'APPROVED' }, ALL_ON)).toEqual([])
  expect(
    diffLinkState(
      PREVIOUS,
      { ...UNCHANGED, commentCount: 1, reviewState: 'APPROVED' },
      { ...ALL_ON, onReviewsComments: false },
    ),
  ).toEqual([])
})

it('reports new commits, gated by onNewCommits', () => {
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, headOid: 'def456' }, ALL_ON)).toEqual(['new commits pushed'])
  expect(diffLinkState(PREVIOUS, { ...UNCHANGED, headOid: 'def456' }, { ...ALL_ON, onNewCommits: false })).toEqual([])
})

it('joins every kind of change that applies at once, in order', () => {
  expect(
    diffLinkState(
      PREVIOUS,
      {
        ...UNCHANGED,
        checksState: GithubChecksState.Failure,
        checksSummary: '13/14',
        commentCount: 2,
      },
      ALL_ON,
    ),
  ).toEqual(['CI failed (13/14)', '2 new comments'])
})

it('is still watching an open link, and stops for a closed or merged one', () => {
  expect(stillWatching({ ...UNCHANGED, state: GithubLinkState.Open })).toBe(true)
  expect(stillWatching({ ...UNCHANGED, state: GithubLinkState.Closed, merged: false })).toBe(false)
  expect(stillWatching({ ...UNCHANGED, state: GithubLinkState.Closed, merged: true })).toBe(false)
})
