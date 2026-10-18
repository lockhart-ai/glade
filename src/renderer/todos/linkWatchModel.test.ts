import { describe, expect, it } from 'vitest'
import type { EpochMs } from '../../shared/domain'
import { GithubChecksState, GithubLinkKind, GithubLinkState, type GithubLinkWatch } from '../../shared/githubWatch'
import {
  collapsedGroups,
  collapsedStateItem,
  expandedStateItems,
  linkStateWord,
  LinkTone,
  stateBucket,
  twoOrFewer,
} from './linkWatchModel'

const NOW: EpochMs = 1_000_000

/** A watched pull request, open with nothing yet to say of its checks or its review. */
function watch(fields: Partial<GithubLinkWatch> = {}): GithubLinkWatch {
  return {
    taskId: 't1',
    url: 'https://github.com/acme/api/pull/2600',
    kind: GithubLinkKind.PullRequest,
    state: GithubLinkState.Open,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    commentCount: 0,
    headOid: null,
    title: 'A pull request',
    watching: true,
    lastFetchedAt: NOW,
    ...fields,
  }
}

describe('linkStateWord', () => {
  it('says a pull request is open, in the merge queue, a draft, merged or closed', () => {
    expect(linkStateWord(watch())).toBe('Open')
    expect(linkStateWord(watch({ inMergeQueue: true }))).toBe('Merge queue')
    expect(linkStateWord(watch({ draft: true }))).toBe('Draft')
    expect(linkStateWord(watch({ state: GithubLinkState.Closed, merged: true }))).toBe('Merged')
    expect(linkStateWord(watch({ state: GithubLinkState.Closed }))).toBe('Closed')
  })

  it('says an issue is open or closed, and never merged, a draft or in the merge queue', () => {
    const issue = watch({ kind: GithubLinkKind.Issue, url: 'https://github.com/acme/api/issues/2600' })
    expect(linkStateWord(issue)).toBe('Open')
    expect(linkStateWord({ ...issue, state: GithubLinkState.Closed })).toBe('Closed')
    // `merged` and `draft` are only ever true for a pull request, so an issue ignores them.
    expect(linkStateWord({ ...issue, merged: true, draft: true })).toBe('Open')
  })
})

describe('expandedStateItems', () => {
  it('opens with the state word, medium weight, then nothing when there is nothing else', () => {
    expect(expandedStateItems(watch())).toEqual([{ tone: LinkTone.Open, icon: null, text: 'Open', headline: true }])
  })

  it('says the checks of the latest commit, by how they stand', () => {
    expect(expandedStateItems(watch({ checksState: GithubChecksState.Pending, checksSummary: '8/14' }))).toEqual([
      { tone: LinkTone.Open, icon: null, text: 'Open', headline: true },
      { tone: LinkTone.Active, icon: 'spinner', text: '8/14 checks', headline: false },
    ])
    expect(expandedStateItems(watch({ checksState: GithubChecksState.Success, checksSummary: '14/14' }))[1]).toEqual({
      tone: LinkTone.Open,
      icon: 'check',
      text: '14/14 checks',
      headline: false,
    })
    expect(expandedStateItems(watch({ checksState: GithubChecksState.Failure, checksSummary: '13/14' }))[1]).toEqual({
      tone: LinkTone.Alert,
      icon: 'cross',
      text: '13/14 checks',
      headline: false,
    })
  })

  it('says the latest review, by what it asked for', () => {
    expect(expandedStateItems(watch({ reviewState: 'APPROVED' }))[1]).toEqual({
      tone: LinkTone.Open,
      icon: 'check',
      text: 'Approved',
      headline: false,
    })
    expect(expandedStateItems(watch({ reviewState: 'CHANGES_REQUESTED' }))[1]).toEqual({
      tone: LinkTone.Alert,
      icon: 'cross',
      text: 'Changes requested',
      headline: false,
    })
    expect(expandedStateItems(watch({ reviewState: 'PENDING' }))[1]).toEqual({
      tone: LinkTone.Faint,
      icon: 'dots',
      text: 'Waiting',
      headline: false,
    })
  })

  it('counts the comments', () => {
    expect(expandedStateItems(watch({ commentCount: 3 }))[1]).toEqual({
      tone: LinkTone.Faint,
      icon: 'comment',
      text: '3',
      headline: false,
    })
    expect(expandedStateItems(watch())).toHaveLength(1)
  })

  it('says everything there is to say, in the order of the screen, and colours each part its own', () => {
    const full = watch({
      inMergeQueue: true,
      checksState: GithubChecksState.Success,
      checksSummary: '14/14',
      reviewState: 'APPROVED',
      commentCount: 3,
    })
    expect(expandedStateItems(full)).toEqual([
      { tone: LinkTone.Active, icon: null, text: 'Merge queue', headline: true },
      { tone: LinkTone.Open, icon: 'check', text: '14/14 checks', headline: false },
      { tone: LinkTone.Open, icon: 'check', text: 'Approved', headline: false },
      { tone: LinkTone.Faint, icon: 'comment', text: '3', headline: false },
    ])
  })
})

describe('collapsedStateItem', () => {
  it('says the one thing that matters most, failing checks first', () => {
    expect(collapsedStateItem(watch())).toEqual({ tone: LinkTone.Open, icon: null, text: 'Open', headline: false })
    expect(collapsedStateItem(watch({ checksState: GithubChecksState.Failure, checksSummary: '13/14' }))).toEqual({
      tone: LinkTone.Alert,
      icon: 'cross',
      text: '13/14',
      headline: false,
    })
  })

  it('puts a changes-requested review next, then the merge queue, then checks still running', () => {
    expect(collapsedStateItem(watch({ reviewState: 'CHANGES_REQUESTED' }))).toEqual({
      tone: LinkTone.Alert,
      icon: 'cross',
      text: 'Changes requested',
      headline: false,
    })
    expect(collapsedStateItem(watch({ inMergeQueue: true }))).toEqual({
      tone: LinkTone.Active,
      icon: null,
      text: 'Merge queue',
      headline: false,
    })
    expect(collapsedStateItem(watch({ checksState: GithubChecksState.Pending, checksSummary: '3/14' }))).toEqual({
      tone: LinkTone.Active,
      icon: 'spinner',
      text: '3/14',
      headline: false,
    })
  })

  it('counts the comments of something still open, but not of what has closed or merged', () => {
    expect(collapsedStateItem(watch({ commentCount: 4 }))).toEqual({
      tone: LinkTone.Faint,
      icon: 'comment',
      text: '4',
      headline: false,
    })
    expect(collapsedStateItem(watch({ commentCount: 4, state: GithubLinkState.Closed }))).toEqual({
      tone: LinkTone.Muted,
      icon: null,
      text: 'Closed',
      headline: false,
    })
  })

  it('says what a closed, merged or draft pull request is', () => {
    expect(collapsedStateItem(watch({ state: GithubLinkState.Closed, merged: true }))).toEqual({
      tone: LinkTone.Muted,
      icon: null,
      text: 'Merged',
      headline: false,
    })
    expect(collapsedStateItem(watch({ state: GithubLinkState.Closed }))).toEqual({
      tone: LinkTone.Muted,
      icon: null,
      text: 'Closed',
      headline: false,
    })
    expect(collapsedStateItem(watch({ draft: true }))).toEqual({
      tone: LinkTone.Muted,
      icon: null,
      text: 'Draft',
      headline: false,
    })
  })
})

describe('stateBucket and collapsedGroups', () => {
  it('buckets a link by the same telling, what needs someone first', () => {
    expect(stateBucket(watch())).toBe('open')
    expect(stateBucket(watch({ checksState: GithubChecksState.Failure, checksSummary: '5/8' }))).toBe('failing')
    expect(stateBucket(watch({ reviewState: 'CHANGES_REQUESTED' }))).toBe('failing')
    expect(stateBucket(watch({ checksState: GithubChecksState.Pending, checksSummary: '3/14' }))).toBe('running')
    expect(stateBucket(watch({ inMergeQueue: true }))).toBe('queued')
    expect(stateBucket(watch({ reviewState: 'PENDING' }))).toBe('waiting')
    expect(stateBucket(watch({ draft: true }))).toBe('draft')
    expect(stateBucket(watch({ state: GithubLinkState.Closed, merged: true }))).toBe('merged')
    expect(stateBucket(watch({ state: GithubLinkState.Closed }))).toBe('closed')
  })

  it('shows one count per state for more than two watched links, in the bucket order', () => {
    const watched = [
      watch({
        url: 'https://github.com/acme/api/pull/2733',
        checksState: GithubChecksState.Failure,
        checksSummary: '5/8',
      }),
      watch({ url: 'https://github.com/acme/api/pull/2667', inMergeQueue: true }),
      watch({ url: 'https://github.com/acme/api/issues/2655', kind: GithubLinkKind.Issue }),
      watch({ url: 'https://github.com/acme/api/issues/2531', kind: GithubLinkKind.Issue, commentCount: 4 }),
    ]
    expect(collapsedGroups(watched)).toEqual([
      { tone: LinkTone.Alert, icon: 'cross', text: '1 failing', pullRequest: true },
      { tone: LinkTone.Active, icon: null, text: '1 queued', pullRequest: true },
      { tone: LinkTone.Open, icon: null, text: '2 open', pullRequest: false },
    ])
  })

  it('counts merged and closed pull requests separately, each with a pull request icon', () => {
    const watched = Array.from({ length: 12 }, () => watch({ state: GithubLinkState.Closed, merged: true }))
    watched.push(watch({ state: GithubLinkState.Closed }), watch({ state: GithubLinkState.Closed }))
    expect(collapsedGroups(watched)).toEqual([
      { tone: LinkTone.Muted, icon: null, text: '12 merged', pullRequest: true },
      { tone: LinkTone.Muted, icon: null, text: '2 closed', pullRequest: true },
    ])
  })

  it('says nothing for a bucket with nothing in it', () => {
    expect(collapsedGroups([watch()])).toEqual([{ tone: LinkTone.Open, icon: null, text: '1 open', pullRequest: true }])
  })
})

describe('twoOrFewer', () => {
  it('shows each watched link at two or fewer, and one count per state past that', () => {
    expect(twoOrFewer([])).toBe(true)
    expect(twoOrFewer([watch(), watch({ draft: true })])).toBe(true)
    expect(twoOrFewer([watch(), watch({ draft: true }), watch({ inMergeQueue: true })])).toBe(false)
  })
})
