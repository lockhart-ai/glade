/**
 * One poll of the GitHub link watcher (#682): every watched link, in one batched request, diffed against what was
 * known of it, written back, and the tasks it changed for told. `./watcher` wraps this in a self-rearming timer;
 * this is the one tick, testable against a real (throwaway) database with a fake fetch and a fake runner, never the
 * network.
 */
import type { Database } from 'better-sqlite3'
import type { Settings } from '../../shared/settings'
import type { AgentRunner } from '../agent/runner'
import type { Emit } from '../bridge/events'
import { emitGithubWatchChanged } from '../bridge/events'
import { GithubLinkState } from '../../shared/githubWatch'
import { getSettings } from '../db/repositories/settings'
import { putGithubLinkWatch } from '../db/repositories/github-link-watches'
import { diffLinkState, stillWatching, type WatchWakeSettings } from './diff'
import { fetchWatchBatch, type GraphqlBatchResult } from './graphql'
import { fetchWatchBatchRest, type RestBatchResult } from './rest-fallback'
import type { FetchedLinkState, WatchTarget } from './query'
import { watchCandidates } from './targets'
import type { GithubTokenCache } from './token'
import { linkChangeOf, wakeTasks, type LinkChange } from './wake'
import type { Logger } from '../logging/logger'

/** Which client a poll asked GitHub with. */
export type GithubPollSource = 'graphql' | 'rest'

/** What a watcher remembers between polls, so it logs a source only when it changes and warns about `gh` once. */
export interface GithubPollState {
  /** The source the last poll used, or null before the first one that asked GitHub anything. */
  lastSource: GithubPollSource | null
  /** Whether the missing-token warning has gone out; once, not on every poll (#718). */
  warnedNoToken: boolean
}

export interface PollOptions {
  readonly db: Database
  readonly emit: Emit
  readonly runner: Pick<AgentRunner, 'send' | 'queue'>
  readonly tokenCache: GithubTokenCache
  /** Where the poll's source, backoffs and missing token are logged; silent when left out. */
  readonly log?: Logger
  /** What to remember between polls, so a change is logged once; a fresh one when left out. */
  readonly state?: GithubPollState
  /** The GraphQL request: injectable so a test never reaches the network. */
  readonly fetchGraphql?: typeof fetchWatchBatch
  /** The REST fallback's requests: injectable, same reason. */
  readonly fetchRest?: typeof fetchWatchBatchRest
}

/** `Settings`' four toggles, as `diffLinkState` reads them. */
function wakeSettingsOf(settings: Settings): WatchWakeSettings {
  return {
    onStateChange: settings.githubWatchOnStateChange,
    onChecksFinished: settings.githubWatchOnChecksFinished,
    onReviewsComments: settings.githubWatchOnReviewsComments,
    onNewCommits: settings.githubWatchOnNewCommits,
  }
}

/** Asks GitHub about every target, with a token if one can be read, falling back to the unauthenticated REST API. */
async function fetchBatch(
  targets: readonly WatchTarget[],
  tokenCache: GithubTokenCache,
  fetchGraphql: typeof fetchWatchBatch,
  fetchRest: typeof fetchWatchBatchRest,
  log: Logger | undefined,
  state: GithubPollState,
): Promise<{ batch: GraphqlBatchResult | RestBatchResult; source: GithubPollSource }> {
  const token = await tokenCache.get()
  if (token === null) {
    if (!state.warnedNoToken) {
      log?.warn('github watch found no gh token, polling unauthenticated REST')
      state.warnedNoToken = true
    }
    return { batch: await fetchRest(targets), source: 'rest' }
  }
  const first = await fetchGraphql(token, targets)
  if (first.outcome !== 'unauthorized') return { batch: first, source: 'graphql' }
  // The token may have been revoked or expired since it was cached: read it again, once, before falling back.
  tokenCache.invalidate()
  const retried = await tokenCache.get()
  return retried === null
    ? { batch: await fetchRest(targets), source: 'rest' }
    : { batch: await fetchGraphql(retried, targets), source: 'graphql' }
}

/**
 * Runs one poll: asks GitHub about every live link — one never fetched, or still open in its stored state, whether
 * or not its todo is done (#738) — writes what it found, tells the windows of each link that changed, and wakes
 * every task one of its links changed for. A link whose todo is done keeps its state current but its changes never
 * wake anyone; a merged or closed link is left alone from then on. Answers the number of milliseconds `./watcher`
 * should wait before the next poll: the configured interval, or a backoff's wait when GitHub rate-limited this one.
 */
export async function pollGithubWatches(options: PollOptions): Promise<number> {
  const { db, emit, runner, tokenCache } = options
  const fetchGraphql = options.fetchGraphql ?? fetchWatchBatch
  const fetchRest = options.fetchRest ?? fetchWatchBatchRest
  const state = options.state ?? { lastSource: null, warnedNoToken: false }
  const settings = getSettings(db)
  const intervalMs = Math.max(settings.githubWatchPollSeconds, 1) * 1000

  // From the stored state, not the stored `watching` flag: rows the old stop rule left watching=false while still
  // open (#738) are polled again, and a merged or closed link — whatever its flag says — stops being polled.
  const toPoll = watchCandidates(db).filter(
    (candidate) => candidate.previous === undefined || candidate.previous.state === GithubLinkState.Open,
  )
  if (toPoll.length === 0) return intervalMs

  const { batch, source } = await fetchBatch(
    toPoll.map((candidate) => candidate.target),
    tokenCache,
    fetchGraphql,
    fetchRest,
    options.log,
    state,
  )
  if (state.lastSource !== source) {
    options.log?.info('github watch poll source', { source })
    state.lastSource = source
  }
  if (batch.outcome === 'backoff') {
    options.log?.info('github watch rate-limited, backing off', { waitMs: batch.waitMs })
    return batch.waitMs
  }
  if (batch.outcome === 'unauthorized') return intervalMs

  const wake = wakeSettingsOf(settings)
  const changes: LinkChange[] = []
  let quietRefreshes = 0
  for (const { target, previous, linkedAt, todoDone } of toPoll) {
    const next: FetchedLinkState | undefined = batch.fetched.get(target)
    if (next === undefined) continue
    const watch = putGithubLinkWatch(db, {
      taskId: target.taskId,
      url: target.url,
      kind: target.kind,
      state: next.state,
      merged: next.merged,
      draft: next.draft,
      inMergeQueue: next.inMergeQueue,
      checksState: next.checksState,
      checksSummary: next.checksSummary,
      reviewState: next.reviewState,
      commentCount: next.commentCount,
      headOid: next.headOid,
      title: next.title,
      watching: stillWatching(next),
    })
    emitGithubWatchChanged(emit, watch)
    if (todoDone) {
      quietRefreshes++
      continue
    }
    const lines = diffLinkState(previous, next, wake, linkedAt)
    if (lines.length > 0) changes.push(linkChangeOf(watch, target.number, lines))
  }
  if (quietRefreshes > 0) {
    options.log?.info('github watch refreshed links whose todo is done, without waking their tasks', {
      count: quietRefreshes,
    })
  }
  wakeTasks(runner, changes)
  return intervalMs
}
