/**
 * The GitHub link watcher's GraphQL query (#682): one request a poll, aliasing every watched link's repository so
 * every issue and PR across every repo is read in one round trip. Built and parsed with no network: `fetchWatchBatch`
 * (`./graphql`) is the only thing that calls out.
 */
import { z } from 'zod'
import { GithubChecksState, GithubLinkKind, GithubLinkState } from '../../shared/githubWatch'

/** One link to ask the GraphQL query about. */
export interface WatchTarget {
  readonly taskId: string
  readonly url: string
  readonly owner: string
  readonly repo: string
  readonly number: number
  readonly kind: GithubLinkKind
}

/** A target's alias in the query (and so in the response): `l0`, `l1`, … in the order given. */
export function aliasOf(index: number): string {
  return `l${String(index)}`
}

/** A string as a GraphQL string literal: `JSON.stringify` escapes the same characters GraphQL's grammar does. */
function literal(value: string): string {
  return JSON.stringify(value)
}

const PULL_REQUEST_FIELDS = `
  title
  state
  merged
  isDraft
  mergeQueueEntry { id }
  comments { totalCount }
  reviews(last: 1) { nodes { state } }
  commits(last: 1) {
    nodes {
      commit {
        oid
        statusCheckRollup {
          state
          contexts(first: 100) {
            totalCount
            nodes {
              __typename
              ... on CheckRun { conclusion }
              ... on StatusContext { state }
            }
          }
        }
      }
    }
  }
`

const ISSUE_FIELDS = `
  title
  state
  comments { totalCount }
`

/** One target's query fragment, aliased. */
function targetQuery(target: WatchTarget, alias: string): string {
  const selection = target.kind === GithubLinkKind.PullRequest ? 'pullRequest' : 'issue'
  const fields = target.kind === GithubLinkKind.PullRequest ? PULL_REQUEST_FIELDS : ISSUE_FIELDS
  return `${alias}: repository(owner: ${literal(target.owner)}, name: ${literal(target.repo)}) {
    ${selection}(number: ${String(target.number)}) { ${fields} }
  }`
}

/** The one GraphQL query for every target, each repository aliased so none collides with another. */
export function buildWatchQuery(targets: readonly WatchTarget[]): string {
  return `query {\n${targets.map((target, index) => targetQuery(target, aliasOf(index))).join('\n')}\n}`
}

const checkContextSchema = z.object({
  __typename: z.string(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
})

/** A context is "successful" by a `CheckRun`'s conclusion or a `StatusContext`'s state; anything else counts against it. */
const SUCCESSFUL_CONTEXT_VALUES: ReadonlySet<string> = new Set(['SUCCESS', 'NEUTRAL', 'SKIPPED'])

function contextSucceeded(context: z.infer<typeof checkContextSchema>): boolean {
  const value = context.conclusion ?? context.state
  return value !== null && value !== undefined && SUCCESSFUL_CONTEXT_VALUES.has(value)
}

const rollupSchema = z
  .object({
    state: z.string(),
    contexts: z.object({ totalCount: z.number(), nodes: z.array(checkContextSchema) }),
  })
  .nullable()

const pullRequestSchema = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  merged: z.boolean(),
  isDraft: z.boolean(),
  mergeQueueEntry: z.object({ id: z.string() }).nullable(),
  comments: z.object({ totalCount: z.number() }),
  reviews: z.object({ nodes: z.array(z.object({ state: z.string() })) }),
  commits: z.object({
    nodes: z.array(z.object({ commit: z.object({ oid: z.string(), statusCheckRollup: rollupSchema }) })),
  }),
})

const issueSchema = z.object({
  title: z.string(),
  state: z.enum(['OPEN', 'CLOSED']),
  comments: z.object({ totalCount: z.number() }),
})

const responseSchema = z.object({
  data: z.record(
    z.string(),
    z
      .object({ pullRequest: pullRequestSchema.nullable().optional(), issue: issueSchema.nullable().optional() })
      .nullable(),
  ),
  errors: z.array(z.object({ message: z.string() })).optional(),
})

/** What a poll found of one link, normalised the same way whether it came from GraphQL or the REST fallback. */
export interface FetchedLinkState {
  readonly state: GithubLinkState
  readonly merged: boolean
  readonly draft: boolean
  readonly inMergeQueue: boolean
  readonly checksState: GithubChecksState | null
  readonly checksSummary: string | null
  readonly reviewState: string | null
  readonly commentCount: number
  readonly headOid: string | null
  readonly title: string
}

/** A rollup's state, as GitHub's enum names it, to ours; null for anything not recognised (new to the schema). */
function checksStateOf(rollup: z.infer<typeof rollupSchema>): GithubChecksState | null {
  if (rollup === null) return null
  switch (rollup.state) {
    case 'SUCCESS':
      return GithubChecksState.Success
    case 'FAILURE':
    case 'ERROR':
      return GithubChecksState.Failure
    default:
      return GithubChecksState.Pending
  }
}

function checksSummaryOf(rollup: z.infer<typeof rollupSchema>): string | null {
  if (rollup === null || rollup.contexts.totalCount === 0) return null
  const succeeded = rollup.contexts.nodes.filter(contextSucceeded).length
  return `${String(succeeded)}/${String(rollup.contexts.totalCount)}`
}

function fetchedFromPullRequest(pr: z.infer<typeof pullRequestSchema>): FetchedLinkState {
  const rollup = pr.commits.nodes[0]?.commit.statusCheckRollup ?? null
  return {
    state: pr.state === 'OPEN' ? GithubLinkState.Open : GithubLinkState.Closed,
    merged: pr.merged,
    draft: pr.isDraft,
    inMergeQueue: pr.mergeQueueEntry !== null,
    checksState: checksStateOf(rollup),
    checksSummary: checksSummaryOf(rollup),
    reviewState: pr.reviews.nodes[0]?.state ?? null,
    commentCount: pr.comments.totalCount,
    headOid: pr.commits.nodes[0]?.commit.oid ?? null,
    title: pr.title,
  }
}

function fetchedFromIssue(issue: z.infer<typeof issueSchema>): FetchedLinkState {
  return {
    state: issue.state === 'OPEN' ? GithubLinkState.Open : GithubLinkState.Closed,
    merged: false,
    draft: false,
    inMergeQueue: false,
    checksState: null,
    checksSummary: null,
    reviewState: null,
    commentCount: issue.comments.totalCount,
    headOid: null,
    title: issue.title,
  }
}

/**
 * The response's `data`, by target: undefined for one GitHub answered nothing for (the repo, issue or PR is gone, or
 * private to a token that can't see it). Throws when the body isn't shaped like a GraphQL response at all.
 */
export function parseWatchResponse(
  body: unknown,
  targets: readonly WatchTarget[],
): ReadonlyMap<WatchTarget, FetchedLinkState> {
  const parsed = responseSchema.parse(body)
  const fetched = new Map<WatchTarget, FetchedLinkState>()
  targets.forEach((target, index) => {
    const entry = parsed.data[aliasOf(index)]
    if (entry === null || entry === undefined) return
    if (entry.pullRequest !== null && entry.pullRequest !== undefined) {
      fetched.set(target, fetchedFromPullRequest(entry.pullRequest))
    } else if (entry.issue !== null && entry.issue !== undefined) {
      fetched.set(target, fetchedFromIssue(entry.issue))
    }
  })
  return fetched
}
