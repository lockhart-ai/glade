/**
 * The machine's `gh` token (#682, #718): read once at startup with `gh auth token`, kept in memory only (never logged,
 * never written to disk), and read again on a 401 from the GraphQL request that used it. No other `gh auth` call is
 * ever made. Without a working `gh`, or while it's logged out, there's no token: the poller falls back to slow, unauthenticated
 * REST polling of public links (`./rest-fallback`).
 */
import { execFile } from 'node:child_process'
import type { Environment } from '../login-env'

/** How long `gh auth token` gets before it's given up on. */
export const GH_TOKEN_TIMEOUT_MS = 5_000

/** Runs `gh auth token` in `env` and answers with the token, trimmed, or null when it couldn't be read (no `gh`, logged out). */
export type ReadGhToken = (env: Environment) => Promise<string | null>

/**
 * `gh auth token` with `execFile`: no shell, a timeout, and never logged, success or failure. `env` is the agents'
 * login environment (`./login-env`), not the app's own: an app opened from Finder has launchd's PATH, which has no
 * `gh` (#718).
 */
export const readGhToken: ReadGhToken = (env) =>
  new Promise((resolve) => {
    execFile('gh', ['auth', 'token'], { env, timeout: GH_TOKEN_TIMEOUT_MS, encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? stdout.trim() || null : null)
    })
  })

export interface GithubTokenCache {
  /** The token now, reading it fresh the first time and after `invalidate`. Null when it can't be read. */
  get(): Promise<string | null>
  /** Forgets the cached token, so the next `get` reads it again: call once a request answers 401 with it. */
  invalidate(): void
}

/** Reads the token now: `readGhToken` on the login environment the watcher resolved, or a test's fake. */
export type ReadToken = () => Promise<string | null>

/**
 * Keeps the token read once, across a poller's ticks, until `invalidate` says it may have changed (a 401) or
 * reading it failed last time (tried again next tick, not cached as null forever: a login or a fresh `gh` might fix
 * it). Concurrent `get` calls while the first read is in flight share it, rather than each running `gh` again.
 */
export function createGithubTokenCache(read: ReadToken): GithubTokenCache {
  let cached: string | null = null
  let pending: Promise<string | null> | null = null

  return {
    get(): Promise<string | null> {
      if (cached !== null) return Promise.resolve(cached)
      pending ??= read().finally(() => {
        pending = null
      })
      return pending.then((token) => {
        cached = token
        return token
      })
    },
    invalidate(): void {
      cached = null
    },
  }
}
