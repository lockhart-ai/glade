import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventType, type GladeEvent } from '../../shared/bridge'
import {
  AgentErrorKind,
  TaskActivity,
  TaskErrorSource,
  TaskState,
  type Task,
  type TaskError,
} from '../../shared/domain'
import { IDLE_LOGIN, LoginState } from '../../shared/login'
import { getTask, updateTask } from '../db/repositories/tasks'
import { openTestDatabase, sampleTask, sampleWorkspace, type TestDatabase } from '../db/repositories/test-database'
import { createMemoryLog } from '../logging/memory-sink'
import {
  claudeLogin,
  createLoginService,
  lastLine,
  LOGIN_ARGS,
  LoginOutcomeKind,
  retryIfLoggedOut,
  retryLoggedOutTasks,
  UNAVAILABLE_LOGIN,
  type LoginChild,
  type LoginOutcome,
  type LoginRun,
  type RunLogin,
  type SpawnLogin,
} from './login'

/** A child process that does what the test says: prints, exits, fails to start. */
class FakeChild extends EventEmitter implements LoginChild {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly killed: (NodeJS.Signals | undefined)[] = []

  kill(signal?: NodeJS.Signals): boolean {
    this.killed.push(signal)
    // As a real one does once it's killed: it closes with no exit code.
    setImmediate(() => this.emit('close', null))
    return true
  }

  /** Prints, then exits with `code`, once what it printed has been read. */
  exit(code: number, { stdout = '', stderr = '' }: { stdout?: string; stderr?: string } = {}): void {
    this.stdout.write(stdout)
    this.stderr.write(stderr)
    setImmediate(() => this.emit('close', code))
  }
}

interface Spawned {
  readonly command: string
  readonly args: readonly string[]
  readonly options: SpawnOptions
  readonly child: FakeChild
}

function fakeSpawn(): { spawn: SpawnLogin; spawned: Spawned[] } {
  const spawned: Spawned[] = []
  const spawn: SpawnLogin = (command, args, options) => {
    const child = new FakeChild()
    spawned.push({ command, args, options, child })
    return child
  }
  return { spawn, spawned }
}

const BINARY = '/Applications/Glade.app/Contents/Resources/app.asar.unpacked/claude'
const ENV = { PATH: '/usr/bin:/bin', HOME: '/Users/sam' }

/** Lets the login get as far as it can: its environment read and its process started. */
const started = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe('claudeLogin', () => {
  it('runs the bundled binary’s own `auth login` from your home folder, in the agents’ environment', async () => {
    const { spawn, spawned } = fakeSpawn()
    const run = claudeLogin({ executable: BINARY, env: Promise.resolve(ENV), cwd: '/Users/sam', spawn })()
    await started()

    expect(spawned).toHaveLength(1)
    expect(spawned[0]).toMatchObject({
      command: BINARY,
      args: ['auth', 'login'],
      options: { cwd: '/Users/sam', env: ENV, stdio: 'pipe' },
    })
    expect(LOGIN_ARGS).toEqual(['auth', 'login'])
    // A copy: Claude Code never changes the agents' own.
    expect(spawned[0]?.options.env).not.toBe(ENV)

    spawned[0]?.child.exit(0, { stdout: 'Opening browser to sign in…\nLogin successful.\n' })
    await expect(run.done).resolves.toEqual({ kind: LoginOutcomeKind.LoggedIn })
  })

  it('fails with the last thing it printed to its error output', async () => {
    const { spawn, spawned } = fakeSpawn()
    const run = claudeLogin({ executable: BINARY, env: Promise.resolve(ENV), cwd: '/Users/sam', spawn })()
    await started()

    spawned[0]?.child.exit(1, {
      stdout: 'Opening browser to sign in…\n',
      stderr: 'Login failed: The sign-in page timed out\n\n',
    })

    await expect(run.done).resolves.toEqual({
      kind: LoginOutcomeKind.Failed,
      message: 'Login failed: The sign-in page timed out',
    })
  })

  it('falls back on what it printed, then on its exit code, when it says nothing on its error output', async () => {
    const { spawn, spawned } = fakeSpawn()
    const login = claudeLogin({ executable: BINARY, env: Promise.resolve(ENV), cwd: '/Users/sam', spawn })
    const printed = login()
    const silent = login()
    await started()

    spawned[0]?.child.exit(1, { stdout: 'Invalid code. Please make sure the full code was copied.\n' })
    spawned[1]?.child.exit(2)

    await expect(printed.done).resolves.toEqual({
      kind: LoginOutcomeKind.Failed,
      message: 'Invalid code. Please make sure the full code was copied.',
    })
    await expect(silent.done).resolves.toEqual({
      kind: LoginOutcomeKind.Failed,
      message: 'Claude Code’s login exited with code 2.',
    })
  })

  it('fails when the process can’t start', async () => {
    const { spawn, spawned } = fakeSpawn()
    const run = claudeLogin({ executable: BINARY, env: Promise.resolve(ENV), cwd: '/Users/sam', spawn })()
    await started()

    spawned[0]?.child.emit('error', new Error('spawn EACCES'))

    await expect(run.done).resolves.toEqual({
      kind: LoginOutcomeKind.Failed,
      message: 'Claude Code’s login couldn’t start: spawn EACCES',
    })
  })

  it('fails at once, starting nothing, with no binary to run', async () => {
    const { spawn, spawned } = fakeSpawn()
    const run = claudeLogin({ executable: null, env: Promise.resolve(ENV), cwd: '/Users/sam', spawn })()

    await expect(run.done).resolves.toEqual({
      kind: LoginOutcomeKind.Failed,
      message: 'Glade couldn’t find Claude Code to log in with.',
    })
    expect(spawned).toEqual([])
  })

  it('kills the process when cancelled, and ends cancelled, once', async () => {
    const { spawn, spawned } = fakeSpawn()
    const run = claudeLogin({ executable: BINARY, env: Promise.resolve(ENV), cwd: '/Users/sam', spawn })()
    await started()

    run.cancel()
    run.cancel()

    await expect(run.done).resolves.toEqual({ kind: LoginOutcomeKind.Cancelled })
    expect(spawned[0]?.child.killed).toEqual(['SIGTERM'])
  })

  it('never starts the process when cancelled while the environment is still being read', async () => {
    const { spawn, spawned } = fakeSpawn()
    let ready: (env: typeof ENV) => void = () => undefined
    const env = new Promise<typeof ENV>((resolve) => {
      ready = resolve
    })
    const run = claudeLogin({ executable: BINARY, env, cwd: '/Users/sam', spawn })()

    run.cancel()
    ready(ENV)

    await expect(run.done).resolves.toEqual({ kind: LoginOutcomeKind.Cancelled })
    expect(spawned).toEqual([])
  })

  it('logs when it starts and ends, never what it prints, which carries the sign-in link', async () => {
    const log = createMemoryLog()
    const { spawn, spawned } = fakeSpawn()
    const run = claudeLogin({
      executable: BINARY,
      env: Promise.resolve(ENV),
      cwd: '/Users/sam',
      spawn,
      log: log.logger,
    })()
    await started()
    spawned[0]?.child.exit(0, {
      stdout: 'If the browser didn’t open, visit: https://claude.ai/oauth/authorize?code=secret\n',
    })
    await run.done

    expect(log.records.map(({ message }) => message)).toEqual(['login started', 'login ended'])
    expect(JSON.stringify(log.records)).not.toContain('secret')
  })

  it('logs a binary it can’t find, and a process that fails to start', async () => {
    const log = createMemoryLog()
    const { spawn, spawned } = fakeSpawn()
    await claudeLogin({ executable: null, env: Promise.resolve(ENV), cwd: '/', spawn, log: log.logger })().done
    const run = claudeLogin({ executable: BINARY, env: Promise.resolve(ENV), cwd: '/', spawn, log: log.logger })()
    await started()
    spawned[0]?.child.emit('error', new Error('spawn ENOENT'))
    await run.done

    expect(log.withMessage('login not started: no Claude Code binary')).toHaveLength(1)
    expect(log.withMessage('login failed to start')).toHaveLength(1)
  })
})

describe('lastLine', () => {
  it('finds the last line that says anything, trimmed', () => {
    expect(lastLine('one\n  two  \r\n\n   \n')).toBe('two')
    expect(lastLine('')).toBeNull()
    expect(lastLine('\n \n')).toBeNull()
  })

  it('cuts a long one short', () => {
    const line = lastLine('x'.repeat(400))
    expect(line).toHaveLength(300)
    expect(line?.endsWith('…')).toBe(true)
  })
})

describe('UNAVAILABLE_LOGIN', () => {
  it('fails at once, and cancelling it does nothing', async () => {
    const run = UNAVAILABLE_LOGIN()
    run.cancel()
    await expect(run.done).resolves.toEqual({
      kind: LoginOutcomeKind.Failed,
      message: 'Logging in isn’t available here.',
    })
  })
})

/** A login whose runs the test ends by hand. */
function manualLogin(): { run: RunLogin; runs: { run: LoginRun; end: (outcome: LoginOutcome) => void }[] } {
  const runs: { run: LoginRun; end: (outcome: LoginOutcome) => void; cancelled: boolean }[] = []
  const run: RunLogin = () => {
    let end: (outcome: LoginOutcome) => void = () => undefined
    const done = new Promise<LoginOutcome>((resolve) => {
      end = resolve
    })
    const entry = {
      run: {
        done,
        cancel: () => {
          entry.cancelled = true
          end({ kind: LoginOutcomeKind.Cancelled })
        },
      },
      end: (outcome: LoginOutcome) => {
        end(outcome)
      },
      cancelled: false,
    }
    runs.push(entry)
    return entry.run
  }
  return { run, runs }
}

describe('createLoginService', () => {
  const NOW = 1_790_000_000_000
  let events: GladeEvent[]
  let retried: string[]

  beforeEach(() => {
    events = []
    retried = []
  })

  function service(run: RunLogin) {
    return createLoginService({
      run,
      emit: (event) => events.push(event),
      retry: (taskId) => retried.push(taskId),
      now: () => NOW,
    })
  }

  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

  it('starts idle', () => {
    expect(service(manualLogin().run).status()).toEqual(IDLE_LOGIN)
  })

  it('waits while the login runs, then says you’re logged in and retries the task that asked', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    const waiting = { state: LoginState.Waiting, since: NOW, taskIds: ['task-1'] }
    expect(logins.start('task-1')).toEqual(waiting)
    expect(events).toEqual([{ type: EventType.LoginChanged, status: waiting }])

    login.runs[0]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()

    expect(logins.status()).toEqual({ state: LoginState.LoggedIn, at: NOW })
    expect(events.at(-1)).toEqual({ type: EventType.LoginChanged, status: { state: LoginState.LoggedIn, at: NOW } })
    expect(retried).toEqual(['task-1'])
  })

  it('runs one login at a time: a second Log in joins the first, and both tasks are retried', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    expect(logins.start('task-2')).toEqual({ state: LoginState.Waiting, since: NOW, taskIds: ['task-1', 'task-2'] })
    logins.start('task-1')
    logins.start(null)

    expect(login.runs).toHaveLength(1)
    // Said again only when a task joined.
    expect(events.map((event) => event.type === EventType.LoginChanged && event.status)).toEqual([
      { state: LoginState.Waiting, since: NOW, taskIds: ['task-1'] },
      { state: LoginState.Waiting, since: NOW, taskIds: ['task-1', 'task-2'] },
    ])
    login.runs[0]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()
    expect(retried).toEqual(['task-1', 'task-2'])
  })

  it('retries nothing from Settings, which names no task', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start(null)
    login.runs[0]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()

    expect(logins.status().state).toBe(LoginState.LoggedIn)
    expect(retried).toEqual([])
  })

  it('says why a login failed, retries nothing, and starts afresh on the next Log in', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    login.runs[0]?.end({ kind: LoginOutcomeKind.Failed, message: 'Login failed: timed out' })
    await flush()

    expect(logins.status()).toEqual({ state: LoginState.Failed, message: 'Login failed: timed out' })
    expect(retried).toEqual([])

    logins.start('task-2')
    login.runs[1]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()
    // Only the task that asked this time: the failed one's ask went with it.
    expect(retried).toEqual(['task-2'])
  })

  it('cancels the login running, at once, and ignores how it ends', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    expect(logins.cancel()).toEqual(IDLE_LOGIN)
    expect(events.at(-1)).toEqual({ type: EventType.LoginChanged, status: IDLE_LOGIN })
    await flush()

    expect(logins.status()).toEqual(IDLE_LOGIN)
    expect(retried).toEqual([])
    // Nothing more was said once it was cancelled.
    expect(events).toHaveLength(2)
  })

  it('does nothing to cancel with no login running', () => {
    const logins = service(manualLogin().run)
    expect(logins.cancel()).toEqual(IDLE_LOGIN)
    expect(events).toEqual([])
  })

  it('goes back to idle when the login process ends cancelled on its own', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    login.runs[0]?.end({ kind: LoginOutcomeKind.Cancelled })
    await flush()

    expect(logins.status()).toEqual(IDLE_LOGIN)
    expect(retried).toEqual([])
  })

  it('ignores a cancelled run ending after a new one started', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    logins.cancel()
    logins.start('task-2')
    // The first run's own end (cancelled) arrives late; the second is still waiting.
    await flush()
    expect(logins.status().state).toBe(LoginState.Waiting)

    login.runs[1]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()
    expect(retried).toEqual(['task-2'])
  })

  it('forgets a finished login once a task stops logged out again, so its card asks you to log in', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    login.runs[0]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()
    logins.loggedOut('task-1')

    expect(logins.status()).toEqual(IDLE_LOGIN)
    expect(events.at(-1)).toEqual({ type: EventType.LoginChanged, status: IDLE_LOGIN })

    logins.start('task-1')
    login.runs[1]?.end({ kind: LoginOutcomeKind.Failed, message: 'No.' })
    await flush()
    logins.loggedOut('task-2')
    expect(logins.status()).toEqual(IDLE_LOGIN)
  })

  it('keeps a login running or none at all as it is when a task stops logged out', () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.loggedOut('task-1')
    expect(events).toEqual([])

    logins.start('task-2')
    logins.loggedOut('task-1')
    expect(logins.status().state).toBe(LoginState.Waiting)
    expect(events).toHaveLength(1)
  })

  it('stops the login running when closed', async () => {
    const login = manualLogin()
    const logins = service(login.run)

    logins.start('task-1')
    logins.close()
    await flush()

    expect(retried).toEqual([])
    logins.close()
  })

  it('logs what happens, never the task’s contents', async () => {
    const log = createMemoryLog()
    const login = manualLogin()
    const logins = createLoginService({
      run: login.run,
      emit: () => undefined,
      retry: () => undefined,
      log: log.logger,
    })

    logins.start('task-1')
    login.runs[0]?.end({ kind: LoginOutcomeKind.Failed, message: 'Login failed: timed out' })
    await flush()
    logins.loggedOut('task-1')
    logins.start(null)
    logins.cancel()
    logins.start('task-1')
    login.runs[2]?.end({ kind: LoginOutcomeKind.LoggedIn })
    await flush()

    expect(log.records.map(({ message }) => message)).toEqual([
      'login failed',
      'a task stopped logged out since the last login',
      'login cancelled',
      'logged in',
    ])
  })

  it('stamps the time with the clock by default', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 5)
    const logins = createLoginService({ run: manualLogin().run, emit: () => undefined, retry: () => undefined })
    expect(logins.start(null)).toEqual({ state: LoginState.Waiting, since: NOW + 5, taskIds: [] })
    vi.restoreAllMocks()
    await flush()
  })
})

describe('retrying the tasks a lost login stopped', () => {
  let test: TestDatabase
  let workspaceId: string

  beforeEach(() => {
    test = openTestDatabase()
    workspaceId = sampleWorkspace(test.db).id
  })

  afterEach(() => {
    test.close()
  })

  const error = (kind: AgentErrorKind): TaskError => ({
    kind,
    source: TaskErrorSource.Api,
    status: null,
    code: 'authentication_failed',
    details: 'Not logged in · Please run /login',
    retries: 0,
    retryingMs: 0,
  })

  function stopped(kind = AgentErrorKind.LoggedOut, now = 1_000): Task {
    return updateTask(
      test.db,
      sampleTask(test.db, workspaceId, now).id,
      { activity: TaskActivity.Error, error: error(kind) },
      now,
    )
  }

  /** A runner whose retry sets the task working, as the real one does, or throws for the ids given. */
  function runner(refusing: readonly string[] = []) {
    return {
      retry: vi.fn((taskId: string): Task => {
        if (refusing.includes(taskId)) throw new Error('The agent is working')
        return updateTask(test.db, taskId, { activity: TaskActivity.Working, error: null })
      }),
    }
  }

  it('retries a task a lost login still stops', () => {
    const task = stopped()
    const retrying = runner()

    expect(retryIfLoggedOut({ db: test.db, runner: retrying }, task.id)).toMatchObject({
      id: task.id,
      activity: TaskActivity.Working,
    })
    expect(retrying.retry).toHaveBeenCalledExactlyOnceWith(task.id)
  })

  it('leaves alone a task that isn’t stopped logged out any more, is gone, or is done', () => {
    const working = updateTask(test.db, stopped().id, { activity: TaskActivity.Working })
    const otherError = stopped(AgentErrorKind.Permanent)
    const done = updateTask(test.db, stopped().id, { state: TaskState.Done })
    const retrying = runner()

    for (const id of [working.id, otherError.id, done.id, 'gone']) {
      expect(retryIfLoggedOut({ db: test.db, runner: retrying }, id)).toBeNull()
    }
    expect(retrying.retry).not.toHaveBeenCalled()
  })

  it('logs a retry that couldn’t start, and never throws', () => {
    const log = createMemoryLog()
    const task = stopped()

    expect(retryIfLoggedOut({ db: test.db, runner: runner([task.id]), log: log.logger }, task.id)).toBeNull()
    expect(log.withMessage("couldn't retry a task a lost login stopped")).toHaveLength(1)
    expect(getTask(test.db, task.id)?.activity).toBe(TaskActivity.Error)
  })

  it('retries all of them, oldest first, skipping one that can’t be, and answers with the ones retried', () => {
    const newer = stopped(AgentErrorKind.LoggedOut, 3_000)
    const older = stopped(AgentErrorKind.LoggedOut, 2_000)
    const busy = stopped(AgentErrorKind.LoggedOut, 2_500)
    stopped(AgentErrorKind.Transient, 1_000)
    const retrying = runner([busy.id])

    const retried = retryLoggedOutTasks({ db: test.db, runner: retrying })

    expect(retried.map(({ id }) => id)).toEqual([older.id, newer.id])
    expect(retrying.retry.mock.calls.map(([id]) => id)).toEqual([older.id, busy.id, newer.id])
  })

  it('retries none when none is stopped logged out', () => {
    stopped(AgentErrorKind.Transient)
    expect(retryLoggedOutTasks({ db: test.db, runner: runner() })).toEqual([])
  })
})
