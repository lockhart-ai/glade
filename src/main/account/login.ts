/**
 * Logging in to Claude from Glade (#409, `src/shared/login.ts`).
 *
 * - **The login** is Claude Code's own: the bundled binary's `claude auth login` (`docs/sdk-notes.md` §1, "Logging
 *   in"), run from main with no terminal. It opens Anthropic's sign-in page in the browser, waits on a localhost port
 *   for the page to hand the login back, saves it where Claude Code keeps it (the macOS Keychain), prints "Login
 *   successful." and exits 0; it exits 1 when it fails. Glade never sees the credential, only whether it worked: so
 *   sign-in completes through Anthropic's own flow, in the unmodified binary, as `docs/decisions.md` has it.
 * - **The service** runs one login at a time and says how it's going (`login.changed`). Once you're logged in, it
 *   retries the tasks whose Log in was clicked, if a lost login still stops them; the others wait for their own Retry
 *   or Retry all, since a retry starts a turn the user didn't ask for. A task stopping logged out again afterwards puts
 *   it back to idle, so its card asks you to log in rather than saying you are.
 *
 * Nothing here is kept in SQLite: a login is a running process, which doesn't outlive the app any more than a shell
 * does. A relaunch starts idle, and the tasks it stopped still show their cards.
 */
import type { Database } from 'better-sqlite3'
import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process'
import { EventType } from '../../shared/bridge'
import type { EpochMs, Task } from '../../shared/domain'
import { isStoppedLoggedOut } from '../../shared/taskError'
import { IDLE_LOGIN, LoginState, type LoginStatus } from '../../shared/login'
import type { AgentRunner } from '../agent/runner'
import type { Emit } from '../bridge/events'
import { getTask, listLoggedOutTasks } from '../db/repositories/tasks'
import type { Environment } from '../login-env'
import { SILENT_LOGGER, type Logger } from '../logging/logger'

/** How one run of the login ended. */
export enum LoginOutcomeKind {
  LoggedIn = 'logged_in',
  Failed = 'failed',
  /** Stopped before it finished (`LoginRun.cancel`). */
  Cancelled = 'cancelled',
}

export type LoginOutcome =
  | { readonly kind: LoginOutcomeKind.LoggedIn }
  | { readonly kind: LoginOutcomeKind.Failed; readonly message: string }
  | { readonly kind: LoginOutcomeKind.Cancelled }

/** One run of the login, under way. */
export interface LoginRun {
  /** Resolves once it ends: logged in, failed (and why), or cancelled. Never rejects. */
  readonly done: Promise<LoginOutcome>
  /** Stops it if it's still running: it ends cancelled. Does nothing once it has ended. */
  cancel(): void
}

/** Starts a run of the login: Claude Code's in the app, a fake in tests and the test modes. */
export type RunLogin = () => LoginRun

/** The parts of a child process the login reads: Node's `ChildProcess`, or a fake in tests. */
export interface LoginChild {
  readonly stdout: NodeJS.ReadableStream | null
  readonly stderr: NodeJS.ReadableStream | null
  on(event: 'error', listener: (error: Error) => void): this
  on(event: 'close', listener: (code: number | null) => void): this
  kill(signal?: NodeJS.Signals): boolean
}

/** Starts a process: Node's `spawn`, or a fake in tests. */
export type SpawnLogin = (command: string, args: readonly string[], options: SpawnOptions) => LoginChild

/** What the bundled binary is asked to run: its `auth login`, which signs in with a Claude subscription by default. */
export const LOGIN_ARGS: readonly string[] = ['auth', 'login']

/** The longest a failure's message is kept to, for the card. */
const MESSAGE_LIMIT = 300

/** How much of the login's output is kept, to say why it failed: the end of it. */
const OUTPUT_LIMIT = 4_000

export interface ClaudeLoginOptions {
  /** Claude Code's native binary (`claudeCodeBinary`); null where there's none, when every run fails saying so. */
  readonly executable: string | null
  /** The environment it runs in: the agents' own (`resolveLoginEnv`), so it signs in where they look. */
  readonly env: Promise<Environment>
  /** The folder it runs in: your home folder. */
  readonly cwd: string
  readonly spawn?: SpawnLogin
  /** Where its start and end are logged; never its output, which carries the sign-in page's one-time link. */
  readonly log?: Logger
}

/** The last line of `output` that says anything, cut to `MESSAGE_LIMIT`; null for none. */
export function lastLine(output: string): string | null {
  const line = output
    .split(/\r?\n/)
    .map((text) => text.trim())
    .findLast((text) => text !== '')
  if (line === undefined) return null
  return line.length > MESSAGE_LIMIT ? `${line.slice(0, MESSAGE_LIMIT - 1)}…` : line
}

/** Keeps the end of what a stream prints, up to `OUTPUT_LIMIT` characters. */
function tail(stream: NodeJS.ReadableStream | null): () => string {
  let text = ''
  stream?.on('data', (chunk: Buffer | string) => {
    text = (text + chunk.toString()).slice(-OUTPUT_LIMIT)
  })
  return () => text
}

/** Runs Claude Code's own login (`claude auth login`) from its bundled binary (see the module comment). */
export function claudeLogin({
  executable,
  env,
  cwd,
  spawn = nodeSpawn,
  log = SILENT_LOGGER,
}: ClaudeLoginOptions): RunLogin {
  return () => {
    let cancelled = false
    let child: LoginChild | null = null
    const done = env.then(
      (environment) =>
        new Promise<LoginOutcome>((resolve) => {
          if (cancelled) {
            resolve({ kind: LoginOutcomeKind.Cancelled })
            return
          }
          if (executable === null) {
            log.warn('login not started: no Claude Code binary')
            resolve({ kind: LoginOutcomeKind.Failed, message: 'Glade couldn’t find Claude Code to log in with.' })
            return
          }
          log.info('login started', { executable })
          // A copy, since the environment is the agents' own; stdin stays open, as Claude Code reads a pasted code from
          // it, though nothing is ever written there.
          const started = spawn(executable, LOGIN_ARGS, { cwd, env: { ...environment }, stdio: 'pipe' })
          child = started
          const stdout = tail(started.stdout)
          const stderr = tail(started.stderr)
          started.on('error', (error) => {
            log.error('login failed to start', { error })
            resolve({ kind: LoginOutcomeKind.Failed, message: `Claude Code’s login couldn’t start: ${error.message}` })
          })
          started.on('close', (code) => {
            log.info('login ended', { code, cancelled })
            if (cancelled) resolve({ kind: LoginOutcomeKind.Cancelled })
            else if (code === 0) resolve({ kind: LoginOutcomeKind.LoggedIn })
            else {
              const message =
                lastLine(stderr()) ?? lastLine(stdout()) ?? `Claude Code’s login exited with code ${String(code)}.`
              resolve({ kind: LoginOutcomeKind.Failed, message })
            }
          })
        }),
    )
    return {
      done,
      cancel: () => {
        if (cancelled) return
        cancelled = true
        child?.kill('SIGTERM')
      },
    }
  }
}

/** What logging in says where there's no way to: every run fails at once. Unit tests' default. */
export const UNAVAILABLE_LOGIN: RunLogin = () => ({
  done: Promise.resolve({ kind: LoginOutcomeKind.Failed, message: 'Logging in isn’t available here.' }),
  cancel: () => undefined,
})

/** What the login service does once you've logged in, and how it tells the windows. */
export interface LoginServiceOptions {
  readonly run: RunLogin
  readonly emit: Emit
  /** Retries a task, if a lost login still stops it; never throws. */
  readonly retry: (taskId: string) => void
  readonly now?: () => EpochMs
  readonly log?: Logger
}

export interface LoginService {
  /** Where logging in stands. */
  status(): LoginStatus
  /**
   * Starts a login, or joins the one running: `taskId`, if given, is retried once you're logged in. Answers with the
   * status, waiting.
   */
  start(taskId: string | null): LoginStatus
  /** Stops the login running, if there is one, and answers with the status, idle. */
  cancel(): LoginStatus
  /** A task just stopped logged out: a login that finished before it no longer counts. */
  loggedOut(taskId: string): void
  /** Stops the login running, e.g. when the app quits. */
  close(): void
}

/** Runs one login at a time for the windows, and retries the tasks that asked for it (see the module comment). */
export function createLoginService({
  run: runLogin,
  emit,
  retry,
  now = Date.now,
  log = SILENT_LOGGER,
}: LoginServiceOptions): LoginService {
  let status: LoginStatus = IDLE_LOGIN
  /** The run going on now; null for none. A run that isn't this one any more (it was cancelled) is ignored. */
  let current: LoginRun | null = null
  /** The tasks to retry once the run going on now logs you in. */
  let waiting = new Set<string>()

  const change = (next: LoginStatus): void => {
    status = next
    emit({ type: EventType.LoginChanged, status })
  }

  const finished = (run: LoginRun, outcome: LoginOutcome): void => {
    if (run !== current) return
    current = null
    const tasks = [...waiting]
    waiting = new Set()
    switch (outcome.kind) {
      case LoginOutcomeKind.LoggedIn:
        log.info('logged in', { retrying: tasks.length })
        change({ state: LoginState.LoggedIn, at: now() })
        for (const taskId of tasks) retry(taskId)
        return
      case LoginOutcomeKind.Failed:
        log.warn('login failed', { message: outcome.message })
        change({ state: LoginState.Failed, message: outcome.message })
        return
      case LoginOutcomeKind.Cancelled:
        change(IDLE_LOGIN)
        return
    }
  }

  const stop = (): void => {
    const run = current
    current = null
    waiting = new Set()
    run?.cancel()
  }

  return {
    status: () => status,

    start(taskId) {
      const joining = taskId !== null && !waiting.has(taskId)
      if (taskId !== null) waiting.add(taskId)
      if (current !== null) {
        if (joining && status.state === LoginState.Waiting) change({ ...status, taskIds: [...waiting] })
        return status
      }
      const run = runLogin()
      current = run
      change({ state: LoginState.Waiting, since: now(), taskIds: [...waiting] })
      void run.done.then((outcome) => {
        finished(run, outcome)
      })
      return status
    },

    cancel() {
      if (current === null) return status
      log.info('login cancelled')
      stop()
      change(IDLE_LOGIN)
      return status
    },

    loggedOut(taskId) {
      if (status.state !== LoginState.LoggedIn && status.state !== LoginState.Failed) return
      log.info('a task stopped logged out since the last login', { taskId })
      change(IDLE_LOGIN)
    },

    close() {
      stop()
    },
  }
}

/** What retrying the tasks a lost login stopped needs. */
export interface LoggedOutRetryContext {
  readonly db: Database
  readonly runner: Pick<AgentRunner, 'retry'>
  readonly log?: Logger
}

/**
 * Retries a task if a lost login still stops it, as its Retry does; answers with it, working, or null when it isn't
 * (it was retried already, or deleted) or the retry couldn't start, which is logged. Never throws.
 */
export function retryIfLoggedOut(
  { db, runner, log = SILENT_LOGGER }: LoggedOutRetryContext,
  taskId: string,
): Task | null {
  if (!isStoppedLoggedOut(getTask(db, taskId))) return null
  try {
    return runner.retry(taskId)
  } catch (error) {
    log.warn("couldn't retry a task a lost login stopped", { taskId, error })
    return null
  }
}

/** Retries every task a lost login stopped (Retry all), oldest first; answers with the ones retried. */
export function retryLoggedOutTasks(context: LoggedOutRetryContext): Task[] {
  return listLoggedOutTasks(context.db).flatMap((task) => retryIfLoggedOut(context, task.id) ?? [])
}
