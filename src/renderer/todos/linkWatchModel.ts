/**
 * What a task's watched GitHub links (#682) show in the Todos tab (#683): the state line of an expanded link's tile
 * (its state, its checks, its review and its comment count, each with its colour), the one thing a collapsed todo's
 * line says of one link, and the counts a collapsed todo with more than two watched links shows instead. Pure, so
 * it's tested on its own; the views in `LinkStateViews` draw what this returns.
 *
 * Colours are the settled screen's (A5): teal for open and for a passed check or an approved review, the text-safe
 * blue for checks running or a PR in the merge queue, muted grey for merged, closed or draft, pink only for a failed
 * check or a changes-requested review, and faint for comments, a review still waiting and anything else pending.
 */
import { GithubChecksState, GithubLinkKind, GithubLinkState, type GithubLinkWatch } from '../../shared/githubWatch'

/** The tone an item of a link's state wears, as the CSS classes in `LinkState.module.css` name them. */
export enum LinkTone {
  /** Teal: open, a passed check, an approved review. */
  Open = 'open',
  /** The text-safe blue: checks running, a PR in the merge queue. */
  Active = 'active',
  /** Muted grey: merged, closed, draft. */
  Muted = 'muted',
  /** Pink, only for what needs someone: a failed check, a changes-requested review. */
  Alert = 'alert',
  /** Faint: a comment count, a review still waiting. */
  Faint = 'faint',
}

/** The small icon before a state item's text; null for a state's dot alone. */
export type LinkStateIcon = 'check' | 'cross' | 'spinner' | 'dots' | 'comment'

/** One item of a watched link's state: what it says, in what colour, before what small icon. */
export interface LinkStateItem {
  readonly tone: LinkTone
  readonly icon: LinkStateIcon | null
  readonly text: string
  /**
   * Whether it leads the line: the state word is medium weight, and the rest of the line qualifies it. At most one
   * item of a line has this.
   */
  readonly headline: boolean
}

/** The state word an expanded tile opens its line with: what the PR or issue is, as the screen draws it. */
export function linkStateWord(watch: GithubLinkWatch): string {
  if (watch.kind === GithubLinkKind.PullRequest) {
    if (watch.merged) return 'Merged'
    if (watch.draft) return 'Draft'
  }
  if (watch.inMergeQueue) return 'Merge queue'
  return watch.state === GithubLinkState.Open ? 'Open' : 'Closed'
}

/** The tone the state word wears. */
function stateTone(watch: GithubLinkWatch): LinkTone {
  if (watch.kind === GithubLinkKind.PullRequest && (watch.merged || watch.draft)) return LinkTone.Muted
  if (watch.inMergeQueue) return LinkTone.Active
  return watch.state === GithubLinkState.Open ? LinkTone.Open : LinkTone.Muted
}

/** The state item: a dot and the word, medium weight, first on the line. */
function stateItem(watch: GithubLinkWatch): LinkStateItem {
  return { tone: stateTone(watch), icon: null, text: linkStateWord(watch), headline: true }
}

/** The checks item, when the PR's latest commit has checks that report anything: how many stand, and how. */
function checksItem(watch: GithubLinkWatch): LinkStateItem | null {
  if (watch.checksState === null || watch.checksSummary === null) return null
  const text = `${watch.checksSummary} checks`
  switch (watch.checksState) {
    case GithubChecksState.Pending:
      return { tone: LinkTone.Active, icon: 'spinner', text, headline: false }
    case GithubChecksState.Success:
      return { tone: LinkTone.Open, icon: 'check', text, headline: false }
    case GithubChecksState.Failure:
      return { tone: LinkTone.Alert, icon: 'cross', text, headline: false }
  }
}

/** The review item, when the PR has one: approved, changes requested, or a review still waiting. */
function reviewItem(watch: GithubLinkWatch): LinkStateItem | null {
  switch (watch.reviewState) {
    case 'APPROVED':
      return { tone: LinkTone.Open, icon: 'check', text: 'Approved', headline: false }
    case 'CHANGES_REQUESTED':
      return { tone: LinkTone.Alert, icon: 'cross', text: 'Changes requested', headline: false }
    case null:
      return null
    default:
      return { tone: LinkTone.Faint, icon: 'dots', text: 'Waiting', headline: false }
  }
}

/** The comments item, when the PR or issue has any: how many, faint, with the comment icon. */
function commentsItem(watch: GithubLinkWatch): LinkStateItem | null {
  return watch.commentCount > 0
    ? { tone: LinkTone.Faint, icon: 'comment', text: String(watch.commentCount), headline: false }
    : null
}

/**
 * An expanded link tile's state line, in the order the screen draws it: the state, then its checks, its review and
 * its comment count. Only what there is to say: an issue has no checks to show, a PR with none yet shows no item.
 */
export function expandedStateItems(watch: GithubLinkWatch): LinkStateItem[] {
  return [stateItem(watch), checksItem(watch), reviewItem(watch), commentsItem(watch)].filter(
    (item): item is LinkStateItem => item !== null,
  )
}

/**
 * The one thing a collapsed todo's line says of a watched link, the most telling it has: a failed check first, then
 * a changes-requested review, the merge queue, checks still running, comments (on something still open), and only
 * then what it is (merged, closed, draft, open). (Calls made without Jared: the order below the first two tiers and
 * the draft's place follow the mockup's examples, which show none of these together.)
 */
export function collapsedStateItem(watch: GithubLinkWatch): LinkStateItem {
  const checks = checksItem(watch)
  if (checks?.tone === LinkTone.Alert)
    return { tone: checks.tone, icon: checks.icon, text: watch.checksSummary ?? '', headline: false }
  const review = reviewItem(watch)
  if (review?.tone === LinkTone.Alert) return review
  if (watch.inMergeQueue) return { tone: LinkTone.Active, icon: null, text: 'Merge queue', headline: false }
  if (checks?.tone === LinkTone.Active)
    return { tone: checks.tone, icon: checks.icon, text: watch.checksSummary ?? '', headline: false }
  const comments = commentsItem(watch)
  if (comments !== null && watch.state === GithubLinkState.Open) return comments
  if (watch.kind === GithubLinkKind.PullRequest && watch.merged) {
    return { tone: LinkTone.Muted, icon: null, text: 'Merged', headline: false }
  }
  if (watch.state === GithubLinkState.Closed)
    return { tone: LinkTone.Muted, icon: null, text: 'Closed', headline: false }
  if (watch.kind === GithubLinkKind.PullRequest && watch.draft) {
    return { tone: LinkTone.Muted, icon: null, text: 'Draft', headline: false }
  }
  return { tone: LinkTone.Open, icon: null, text: 'Open', headline: false }
}

/**
 * Which bucket of a collapsed todo's grouped counts a watched link falls in, and in what order the buckets show:
 * what needs someone first (a failed check or a changes-requested review, then checks running, the merge queue, a
 * review waiting), then what things are (draft, open, merged, closed).
 */
export type LinkStateBucket = 'failing' | 'running' | 'queued' | 'waiting' | 'draft' | 'open' | 'merged' | 'closed'

/** A watched link's bucket, by the same telling as `collapsedStateItem` reads it. */
export function stateBucket(watch: GithubLinkWatch): LinkStateBucket {
  if (watch.checksState === GithubChecksState.Failure) return 'failing'
  if (watch.reviewState === 'CHANGES_REQUESTED') return 'failing'
  if (watch.checksState === GithubChecksState.Pending) return 'running'
  if (watch.inMergeQueue) return 'queued'
  if (watch.reviewState !== null) return 'waiting'
  if (watch.kind === GithubLinkKind.PullRequest && watch.merged) return 'merged'
  if (watch.kind === GithubLinkKind.PullRequest && watch.draft) return 'draft'
  return watch.state === GithubLinkState.Open ? 'open' : 'closed'
}

/** The order the buckets show in, what needs someone before what things are. */
const BUCKET_ORDER: readonly LinkStateBucket[] = [
  'failing',
  'running',
  'queued',
  'waiting',
  'draft',
  'open',
  'merged',
  'closed',
]

/** The tone and small icon of each bucket's count, as the screen draws them. */
const BUCKETS: Readonly<Record<LinkStateBucket, { tone: LinkTone; icon: LinkStateIcon | null; word: string }>> = {
  failing: { tone: LinkTone.Alert, icon: 'cross', word: 'failing' },
  running: { tone: LinkTone.Active, icon: 'spinner', word: 'running' },
  queued: { tone: LinkTone.Active, icon: null, word: 'queued' },
  waiting: { tone: LinkTone.Faint, icon: 'dots', word: 'waiting' },
  draft: { tone: LinkTone.Muted, icon: null, word: 'draft' },
  open: { tone: LinkTone.Open, icon: null, word: 'open' },
  merged: { tone: LinkTone.Muted, icon: null, word: 'merged' },
  closed: { tone: LinkTone.Muted, icon: null, word: 'closed' },
}

/** One count of a collapsed todo's grouped line: how many links stand so, in what colour, before what icon. */
export interface LinkStateGroup {
  readonly tone: LinkTone
  readonly icon: LinkStateIcon | null
  /** E.g. `1 failing`, `12 merged`. */
  readonly text: string
  /** Whether a pull request stands so (the group shows a pull request's icon when any of its links is one). */
  readonly pullRequest: boolean
}

/**
 * A collapsed todo with more than two watched links shows one count per state instead of each link: `1 failing ·
 * 1 queued · 2 open`, `12 merged · 2 closed`. Buckets with nothing in them show nothing.
 */
export function collapsedGroups(watches: readonly GithubLinkWatch[]): LinkStateGroup[] {
  const byBucket = new Map<LinkStateBucket, GithubLinkWatch[]>()
  for (const watch of watches) {
    const bucket = stateBucket(watch)
    const inBucket = byBucket.get(bucket)
    if (inBucket === undefined) byBucket.set(bucket, [watch])
    else inBucket.push(watch)
  }
  return BUCKET_ORDER.flatMap((bucket) => {
    const inBucket = byBucket.get(bucket)
    if (inBucket === undefined) return []
    const { tone, icon, word } = BUCKETS[bucket]
    return [
      {
        tone,
        icon,
        text: `${String(inBucket.length)} ${word}`,
        pullRequest: inBucket.some(({ kind }) => kind === GithubLinkKind.PullRequest),
      },
    ]
  })
}

/** Whether a collapsed todo shows each of its watched links (`twoOrFewer`) or one count per state instead. */
export function twoOrFewer(watches: readonly GithubLinkWatch[]): boolean {
  return watches.length <= 2
}
