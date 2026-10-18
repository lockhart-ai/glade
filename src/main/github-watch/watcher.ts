/**
 * The GitHub link watcher's self-rearming timer (#682): polls once as soon as it starts, then again after however
 * long the poll itself says to wait (the configured interval, or a backoff). `./poller` does the actual work; this
 * is only the scheduling, so a test can swap in a `poll` that resolves at once and drive the timer with fake ones.
 */
import type { Database } from 'better-sqlite3'
import type { AgentRunner } from '../agent/runner'
import type { Emit } from '../bridge/events'
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'
import { MIN_BACKOFF_MS } from './backoff'
import { pollGithubWatches, type GithubPollState, type PollOptions } from './poller'
import { createGithubTokenCache, readGhToken, type GithubTokenCache } from './token'

export interface GithubWatcherOptions {
  readonly db: Database
  readonly emit: Emit
  readonly runner: Pick<AgentRunner, 'send' | 'queue'>
  /**
   * The agents' login environment (`app.ts`'s `agentEnv`), resolved once at startup: it has `gh` on its PATH, where
   * the app's own environment may not (#718). Read before the first token read.
   */
  readonly env: Promise<Environment>
  /** The machine's `gh` token, cached across polls. One of its own, read in `env`, by default. */
  readonly tokenCache?: GithubTokenCache
  /** One poll (`./poller`'s `pollGithubWatches` by default), injectable so a test never reaches the network. */
  readonly poll?: (options: PollOptions) => Promise<number>
  readonly log?: Logger
}

export interface GithubWatcher {
  /** Polls once now, then keeps polling on its own. Calling it again while running does nothing. */
  start(): void
  /** Stops polling. The app is quitting, or the test is done; nothing more runs after this. */
  close(): void
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Wraps one poll (`pollGithubWatches` by default) in a timer that reschedules itself with whatever the poll says to
 * wait: the interval from Settings › GitHub watching normally, or a backoff's wait when GitHub rate-limited it. A
 * poll that throws (a bug, a network error neither client caught) is logged and retried after `MIN_BACKOFF_MS`,
 * rather than stopping the watcher for good.
 */
export function createGithubWatcher(options: GithubWatcherOptions): GithubWatcher {
  const tokenCache = options.tokenCache ?? createGithubTokenCache(() => options.env.then((own) => readGhToken(own)))
  const poll = options.poll ?? pollGithubWatches
  const log = options.log ?? SILENT_LOGGER
  // Kept across the watcher's polls, so a source is logged only when it changes and `gh` is warned about once (#718).
  const pollState: GithubPollState = { lastSource: null, warnedNoToken: false }
  let timer: ReturnType<typeof setTimeout> | null = null
  let started = false
  let closed = false

  const schedule = (delayMs: number): void => {
    if (closed) return
    timer = setTimeout(() => {
      void tick()
    }, delayMs)
    timer.unref()
  }

  const tick = async (): Promise<void> => {
    timer = null
    if (closed) return
    let waitMs = MIN_BACKOFF_MS
    try {
      waitMs = await poll({
        db: options.db,
        emit: options.emit,
        runner: options.runner,
        tokenCache,
        log,
        state: pollState,
      })
    } catch (error) {
      log.warn('github watch poll failed', { error: describe(error) })
    }
    schedule(waitMs)
  }

  return {
    start() {
      if (started || closed) return
      started = true
      schedule(0)
    },
    close() {
      closed = true
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}
