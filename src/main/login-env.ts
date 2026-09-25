/**
 * The user's login shell environment, for the agent sessions to run in.
 *
 * An app opened from Finder or the Dock inherits launchd's environment, not the user's shell profile: its PATH is the
 * bare `/usr/bin:/bin:/usr/sbin:/sbin`, without Homebrew, nvm, pnpm, `~/.local/bin` and the rest. So, once at startup,
 * Glade asks the login shell for its environment, as VS Code does: it runs `$SHELL -ilc` with a command that prints
 * `env` between two markers, and reads what's between them. A shell that's missing, fails, or takes longer than the
 * timeout leaves Glade on its own environment, and says so in the log.
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { CONSOLE_LOGGER } from './logging/logger'

/** A process's environment: every variable set, by name. */
export type Environment = Readonly<Record<string, string>>

/** How long the login shell gets to print its environment before Glade gives up on it. */
export const LOGIN_ENV_TIMEOUT_MS = 10_000

/**
 * What the probe's shell sets for itself, which says nothing about the user's environment: `_` is the probe's own
 * command, `PWD` and `OLDPWD` the folder it ran in (not the agent's), `SHLVL` how deep it was nested.
 */
const PROBE_VARIABLES: ReadonlySet<string> = new Set(['_', 'PWD', 'OLDPWD', 'SHLVL'])

/** Where the resolver reports what it found. */
export interface LoginEnvLog {
  info(message: string): void
  warn(message: string): void
}

export interface LoginEnvOptions {
  /** The login shell to ask, `$SHELL`. With none, Glade keeps its own environment. */
  readonly shell: string | undefined
  /** Glade's own environment: what the shell starts with, and what's left when it can't be read. */
  readonly base: NodeJS.ProcessEnv
  /** The folder the shell runs in: the user's home. */
  readonly cwd: string
  readonly timeoutMs?: number
  readonly log?: LoginEnvLog
}

export enum LoginEnvSource {
  /** Read from the login shell. */
  Shell = 'shell',
  /** Glade's own environment, since the login shell's couldn't be read. */
  Fallback = 'fallback',
}

/** The environment the agent sessions run in, and where it came from. */
export type LoginEnv =
  | { readonly source: LoginEnvSource.Shell; readonly env: Environment }
  | { readonly source: LoginEnvSource.Fallback; readonly env: Environment; readonly reason: string }

/** `env`'s variables that are set. */
export function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const defined: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value
  return defined
}

/** Quotes `text` as one word for a POSIX shell, or fish. */
function quote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`
}

/**
 * The command the shell runs: the environment, NUL-separated so a value can hold newlines, between two markers, so
 * whatever the profile prints before or after it is ignored.
 */
export function probeCommand(marker: string): string {
  const print = `printf '%s' ${quote(marker)}`
  return `${print}; /usr/bin/env -0; ${print}`
}

/**
 * The environment the probe printed, read from the shell's whole output, or `null` if its output doesn't have both
 * markers yet. Anything outside the markers is the profile's own output and is ignored, as are the probe's own
 * variables (`PROBE_VARIABLES`).
 */
export function parseProbeOutput(output: string, marker: string): Record<string, string> | null {
  const start = output.indexOf(marker)
  if (start === -1) return null
  const end = output.indexOf(marker, start + marker.length)
  if (end === -1) return null
  const env: Record<string, string> = {}
  for (const entry of output.slice(start + marker.length, end).split('\0')) {
    const equals = entry.indexOf('=')
    // An entry with no name (or none at all, after the last NUL) isn't a variable.
    if (equals <= 0) continue
    const key = entry.slice(0, equals)
    if (!PROBE_VARIABLES.has(key)) env[key] = entry.slice(equals + 1)
  }
  return env
}

/** How the probe ended, before its result is made. */
type ProbeOutcome =
  { readonly ok: true; readonly env: Record<string, string> } | { readonly ok: false; readonly reason: string }

/**
 * Kills the process group a detached shell leads, so a hung profile's children go too. It may be gone already, when
 * the shell has exited and only something it started in a group of its own holds its output open.
 */
function killGroup(pid: number | undefined): void {
  // No pid means it never started: there's nothing to kill, and `kill(-0)` would kill Glade's own group.
  if (pid === undefined) return
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // Already gone.
  }
}

/** Runs `shell -ilc <probe>` and reads its environment, or says why it couldn't. Never rejects. */
function probe(shell: string, { base, cwd, timeoutMs = LOGIN_ENV_TIMEOUT_MS }: LoginEnvOptions): Promise<ProbeOutcome> {
  const marker = `__GLADE_ENV_${randomUUID()}__`
  return new Promise((resolve) => {
    let output = ''
    let settled = false
    // Its own process group, with no terminal: an interactive shell can't take the terminal, and a timeout can kill
    // whatever the profile started along with it.
    const child = spawn(shell, ['-ilc', probeCommand(marker)], {
      cwd,
      env: base,
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const settle = (outcome: ProbeOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // Nothing more is read from it, and Glade doesn't wait on it to quit.
      child.stdout.destroy()
      child.unref()
      resolve(outcome)
    }
    const timer = setTimeout(() => {
      settle({ ok: false, reason: `it took longer than ${String(timeoutMs)} ms` })
      killGroup(child.pid)
    }, timeoutMs)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      output += chunk
      // Done as soon as the environment is out: the profile may leave something running that holds the pipe open.
      const env = parseProbeOutput(output, marker)
      if (env !== null) settle({ ok: true, env })
    })
    child.on('error', (error) => {
      settle({ ok: false, reason: error.message })
    })
    child.on('close', (code, signal) => {
      const ended = signal === null ? `exited with code ${String(code)}` : `was killed by ${signal}`
      settle({ ok: false, reason: `it ${ended} without printing its environment` })
    })
  })
}

/**
 * The environment for the agent sessions: Glade's own, with the login shell's over it, or Glade's own alone when the
 * shell's can't be read (logged). Never rejects.
 */
export async function resolveLoginEnv(options: LoginEnvOptions): Promise<LoginEnv> {
  const { shell, base, log = CONSOLE_LOGGER } = options
  const own = definedEnv(base)
  const outcome: ProbeOutcome =
    shell === undefined || shell === '' ? { ok: false, reason: '$SHELL is not set' } : await probe(shell, options)
  if (!outcome.ok) {
    log.warn(`Couldn't read the login shell's environment (${outcome.reason}); agents run with Glade's own.`)
    return { source: LoginEnvSource.Fallback, env: own, reason: outcome.reason }
  }
  log.info(`Agents run with the login shell's environment (${String(shell)}).`)
  return { source: LoginEnvSource.Shell, env: { ...own, ...outcome.env } }
}
