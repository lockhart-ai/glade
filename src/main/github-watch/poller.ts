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
import { getSettings } from '../db/repositories/settings'
import { putGithubLinkWatch } from '../db/repositories/github-link-watches'
import { diffLinkState, stillWatching, type WatchWakeSettings } from './diff'
import { fetchWatchBatch, type GraphqlBatchResult } from './graphql'
import { fetchWatchBatchRest, type RestBatchResult } from './rest-fallback'
import type { FetchedLinkState, WatchTarget } from './query'
import { watchCandidates, type WatchCandidate } from './targets'
import type { GithubTokenCache } from './token'
import { linkChangeOf, wakeTasks, type LinkChange } from './wake'

export interface PollOptions {
  readonly db: Database
  readonly emit: Emit
  readonly runner: Pick<AgentRunner, 'send' | 'queue'>
  readonly tokenCache: GithubTokenCache
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

/** Stops watching a link whose todo is done, without asking GitHub about it again. */
function stopDoneLinks(db: Database, emit: Emit, candidates: readonly WatchCandidate[]): void {
  for (const { previous, todoDone } of candidates) {
    if (!todoDone || previous?.watching !== true) continue
    const stopped = putGithubLinkWatch(db, { ...previous, watching: false })
    emitGithubWatchChanged(emit, stopped)
  }
}

/** Asks GitHub about every target, with a token if one can be read, falling back to the unauthenticated REST API. */
async function fetchBatch(
  targets: readonly WatchTarget[],
  tokenCache: GithubTokenCache,
  fetchGraphql: typeof fetchWatchBatch,
  fetchRest: typeof fetchWatchBatchRest,
): Promise<GraphqlBatchResult | RestBatchResult> {
  const token = await tokenCache.get()
  if (token === null) return fetchRest(targets)
  const first = await fetchGraphql(token, targets)
  if (first.outcome !== 'unauthorized') return first
  // The token may have been revoked or expired since it was cached: read it again, once, before falling back.
  tokenCache.invalidate()
  const retried = await tokenCache.get()
  return retried === null ? fetchRest(targets) : fetchGraphql(retried, targets)
}

/**
 * Runs one poll: stops any link whose todo just finished, asks GitHub about the rest, writes what it found, tells
 * the windows of each link that changed, and wakes every task one of its links changed for. Answers the number of
 * milliseconds `./watcher` should wait before the next poll: the configured interval, or a backoff's wait when
 * GitHub rate-limited this one.
 */
export async function pollGithubWatches(options: PollOptions): Promise<number> {
  const { db, emit, runner, tokenCache } = options
  const fetchGraphql = options.fetchGraphql ?? fetchWatchBatch
  const fetchRest = options.fetchRest ?? fetchWatchBatchRest
  const settings = getSettings(db)
  const intervalMs = Math.max(settings.githubWatchPollSeconds, 1) * 1000

  const candidates = watchCandidates(db)
  stopDoneLinks(db, emit, candidates)
  const toPoll = candidates.filter((candidate) => !candidate.todoDone)
  if (toPoll.length === 0) return intervalMs

  const batch = await fetchBatch(
    toPoll.map((candidate) => candidate.target),
    tokenCache,
    fetchGraphql,
    fetchRest,
  )
  if (batch.outcome === 'backoff') return batch.waitMs
  if (batch.outcome === 'unauthorized') return intervalMs

  const wake = wakeSettingsOf(settings)
  const changes: LinkChange[] = []
  for (const { target, previous } of toPoll) {
    const next: FetchedLinkState | undefined = batch.fetched.get(target)
    if (next === undefined) continue
    const watch = putGithubLinkWatch(db, {
      taskId: target.taskId,
      url: target.url,
      kind: target.kind,
      ...next,
      watching: stillWatching(next),
    })
    emitGithubWatchChanged(emit, watch)
    const lines = diffLinkState(previous, next, wake)
    if (lines.length > 0) changes.push(linkChangeOf(watch, target.number, lines))
  }
  wakeTasks(runner, changes)
  return intervalMs
}
