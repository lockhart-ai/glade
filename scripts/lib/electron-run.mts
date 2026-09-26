// Runs Electron as a child process for the tools that launch it (`render-design`, `screenshot`), so that a hung
// Electron can't hang the tool. A hidden Electron window that never paints (inside a command sandbox, or while the Mac
// sleeps) leaves Electron idle forever, and it ignores the SIGTERM `spawnSync`'s timeout sends, so the tool never
// exited and left the Electron behind. Here the child is SIGKILLed when it runs out of time or makes no progress for
// too long, or when the tool itself is interrupted, along with every helper process it started (it runs in its own
// process group, all of which is killed once it's done), and each run gets its own throwaway data folder, so a hung
// instance can't hold locks the next one needs. The folder is removed once that whole group is gone. Plain functions
// over a child process, so they can be unit tested with a stub child instead of Electron.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Readable, Writable } from 'node:stream'

/**
 * What a child prints before each step it waits on, to say which one it's on. `runElectron` keeps these lines to
 * itself, and names the last one if the child is stopped.
 */
export const STEP_PREFIX = '[step] '

/** A step line for the child to print: `[step] 21-settings: waiting for fonts`. */
export function stepLine(step: string): string {
  return `${STEP_PREFIX}${step}`
}

/** How long a child that has exited has to close its output before the run stops reading it. */
export const CLOSE_GRACE_MS = 2000

/** The signals that interrupt the tool; each stops the child first. */
export const INTERRUPTS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** Stops the run when the child prints no progress line for a while. */
export interface StallWatch {
  /** How long the child may go without a progress line, from its start, before it's stopped. */
  readonly ms: number
  /** A line of the child's output that counts as progress, such as `Rendered …`. */
  readonly progress: RegExp
}

/** Where the run's output goes, and where it hears interrupts from; the tool's own by default. */
export interface RunIo {
  readonly stdout: Writable
  readonly stderr: Writable
  /** Emits `SIGINT`, `SIGTERM` and `SIGHUP` when the tool is interrupted. */
  readonly interrupts: NodeJS.EventEmitter
}

export interface ElectronRunOptions {
  /** The tool's name, which starts its messages: `render-design`. */
  readonly tool: string
  /** The Electron binary, or a stub in tests. */
  readonly command: string
  readonly args: readonly string[]
  readonly cwd: string
  /** The child's environment, given the run's throwaway data folder (a fresh folder in the temp folder). */
  readonly env: (userData: string) => NodeJS.ProcessEnv
  /** How long the whole run may take before the child is stopped. */
  readonly timeoutMs: number
  /** Stops the child sooner when it makes no progress; without one, only `timeoutMs` stops it. */
  readonly stall?: StallWatch
  readonly io?: RunIo
}

/** Why the run stopped the child. */
export type StopReason = 'timeout' | 'stall' | 'interrupt'

/** How a run ended. */
export type ElectronRunResult =
  /** The child exited by itself (or was killed by something else): its exit code, or its signal. */
  | { readonly kind: 'exited'; readonly code: number | null; readonly signal: NodeJS.Signals | null }
  /** The run SIGKILLed the child. `step` is the last step it said it was on, if any. */
  | { readonly kind: 'stopped'; readonly reason: StopReason; readonly step: string | undefined }
  /** The child couldn't be started at all. */
  | { readonly kind: 'failed'; readonly message: string }

/**
 * Runs the child to the end with a throwaway data folder, passing its output through (all but its step lines), and
 * SIGKILLs it if it runs past `timeoutMs`, goes `stall.ms` without a progress line, or the tool is interrupted. The
 * data folder is removed once the child and every helper it started have exited, however it ended.
 */
export async function runElectron(options: ElectronRunOptions): Promise<ElectronRunResult> {
  const io = options.io ?? { stdout: process.stdout, stderr: process.stderr, interrupts: process }
  const userData = mkdtempSync(join(tmpdir(), `glade-${options.tool}-`))
  let group: number | undefined
  try {
    const supervised = await superviseChild(options, io, userData)
    group = supervised.group
    return supervised.result
  } finally {
    await removeDataFolder(userData, group)
  }
}

/** How long the run waits for the child's killed process group to be gone before it removes the data folder anyway. */
export const GROUP_EXIT_MS = 2000

/** How often the run looks for the child's process group while it waits for it to be gone. */
export const GROUP_POLL_MS = 20

/**
 * How many more times removing the data folder is tried, `RM_RETRY_MS` apart, when it fails because something was
 * still writing into it (`ENOTEMPTY`, `EBUSY`, `EPERM`).
 */
export const RM_RETRIES = 10
export const RM_RETRY_MS = 50

/**
 * Removes the run's data folder. The child's process group has been SIGKILLed by now, but its helpers (Electron's GPU
 * and renderer processes) can still be dying, and one can write a cache file into the folder as `rm` empties it, so
 * this waits for the group to be gone first, and retries the removal if it still fails.
 */
async function removeDataFolder(userData: string, group: number | undefined): Promise<void> {
  if (group !== undefined) {
    await waitUntilGone({
      alive: () => groupAlive(group),
      timeoutMs: GROUP_EXIT_MS,
      intervalMs: GROUP_POLL_MS,
    })
  }
  rmSync(userData, { recursive: true, force: true, maxRetries: RM_RETRIES, retryDelay: RM_RETRY_MS })
}

/**
 * Whether any process is still running in a process group. On macOS one that's dead but not yet reaped (a zombie,
 * which can't write anything) doesn't count: signalling a group of only those fails.
 */
export function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0)
    return true
  } catch {
    return false
  }
}

/** What `waitUntilGone` waits on. */
export interface GoneWatch {
  /** Whether what it waits on is still there. */
  readonly alive: () => boolean
  /** How long to wait at most. */
  readonly timeoutMs: number
  /** How long to wait between looks. */
  readonly intervalMs: number
}

/** Waits until `alive` says it's gone, or `timeoutMs` has passed; whether it went. */
export async function waitUntilGone(watch: GoneWatch): Promise<boolean> {
  const deadline = Date.now() + watch.timeoutMs
  while (watch.alive()) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, watch.intervalMs))
  }
  return true
}

/** How `superviseChild` ended: the run's result, and the child's process group, if it was started. */
interface Supervised {
  readonly result: ElectronRunResult
  readonly group: number | undefined
}

function superviseChild(options: ElectronRunOptions, io: RunIo, userData: string): Promise<Supervised> {
  return new Promise((resolve) => {
    const child = spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env(userData),
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group, so its helpers (GPU, renderer) can be killed with it. The tool forwards interrupts,
      // which a terminal would otherwise send the whole foreground group.
      detached: true,
    })
    let step: string | undefined
    let stopped: StopReason | undefined
    let exited: { code: number | null; signal: NodeJS.Signals | null } | undefined
    let settled = false
    const timers: NodeJS.Timeout[] = []

    /** SIGKILLs the child's process group: the child and every helper it started that's still running. */
    const killGroup = (): void => {
      if (child.pid === undefined) return
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Nothing left in the group.
      }
    }
    const stop = (reason: StopReason): void => {
      if (stopped !== undefined || exited !== undefined) return
      stopped = reason
      killGroup()
    }
    const onInterrupt = (): void => {
      stop('interrupt')
    }
    const settle = (result: ElectronRunResult): void => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      for (const signal of INTERRUPTS) io.interrupts.off(signal, onInterrupt)
      // The child ran in a process group of its own, whose id is its pid.
      resolve({ result, group: child.pid })
    }
    const finish = (): void => {
      // Only once the child has exited: its output closing first doesn't mean it's gone.
      if (exited === undefined) return
      settle(stopped === undefined ? { kind: 'exited', ...exited } : { kind: 'stopped', reason: stopped, step })
    }

    let stallTimer: NodeJS.Timeout | undefined
    const watchForStall = (): void => {
      if (options.stall === undefined) return
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stop('stall')
      }, options.stall.ms)
      timers.push(stallTimer)
    }
    timers.push(
      setTimeout(() => {
        stop('timeout')
      }, options.timeoutMs),
    )
    watchForStall()
    for (const signal of INTERRUPTS) io.interrupts.on(signal, onInterrupt)

    let open = 2
    const pipe = (input: Readable, output: Writable): void => {
      const lines = createInterface({ input, crlfDelay: Infinity })
      lines.on('line', (line) => {
        if (line.startsWith(STEP_PREFIX)) {
          step = line.slice(STEP_PREFIX.length)
          return
        }
        output.write(`${line}\n`)
        if (options.stall?.progress.test(line) === true) watchForStall()
      })
      lines.on('close', () => {
        open--
        if (open === 0) finish()
      })
    }
    pipe(child.stdout, io.stdout)
    pipe(child.stderr, io.stderr)

    child.on('error', (error) => {
      // Raised when the child can't be spawned; it never runs, so it never exits.
      if (child.pid === undefined) settle({ kind: 'failed', message: error.message })
    })
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      // A helper can outlive the child (one that's wedged doesn't notice it's gone), so none is left behind.
      killGroup()
      if (open === 0) {
        finish()
        return
      }
      // A process the child started can hold its output open after it's gone; stop waiting for it after a moment.
      timers.push(
        setTimeout(() => {
          child.stdout.destroy()
          child.stderr.destroy()
          finish()
        }, CLOSE_GRACE_MS),
      )
    })
  })
}

/** A duration for a message: `60 s`, or `5 minutes` from 2 minutes on. */
export function describeDuration(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds >= 120 && seconds % 60 === 0 ? `${String(seconds / 60)} minutes` : `${String(seconds)} s`
}

/** What to try when Electron never finishes. */
export const HANG_HINT =
  "Electron's hidden windows don't paint inside a command sandbox or while the Mac sleeps. If you're in a command " +
  'sandbox, run it outside the sandbox (and in the background).'

/** What to print about how a run ended, or nothing when the child exited by itself. */
export function runFailureMessage(options: ElectronRunOptions, result: ElectronRunResult): string | undefined {
  switch (result.kind) {
    case 'exited':
      return undefined
    case 'failed':
      return `${options.tool}: couldn't start Electron: ${result.message}`
    case 'stopped': {
      const where =
        result.step === undefined ? 'It never said what it was waiting on.' : `It was stuck on: ${result.step}.`
      switch (result.reason) {
        case 'interrupt':
          return `${options.tool}: interrupted, so Electron was stopped. ${where}`
        case 'timeout':
          return `${options.tool}: Electron didn't finish in ${describeDuration(options.timeoutMs)}, so it was stopped. ${where}\n${HANG_HINT}`
        case 'stall': {
          const ms = options.stall?.ms ?? options.timeoutMs
          return `${options.tool}: nothing finished in ${describeDuration(ms)}, so Electron was stopped. ${where}\n${HANG_HINT}`
        }
      }
    }
  }
}

/** The tool's exit code for how the run ended: the child's own when it exited, 1 otherwise. */
export function runExitCode(result: ElectronRunResult): number {
  return result.kind === 'exited' ? (result.code ?? 1) : 1
}

/** What `exitWhenOrphaned` watches: the process's parent now, and how to leave. */
export interface OrphanWatch {
  /** The parent's process id when the child started. */
  readonly parent: number
  /** The parent's process id now (`process.ppid`): another once the parent is gone. */
  readonly currentParent: () => number
  readonly exit: () => void
  readonly intervalMs: number
}

/**
 * Exits the child once the tool that started it is gone, so a tool killed outright (which can't stop its child) leaves
 * no Electron behind. Returns the timer, which doesn't keep the process alive.
 */
export function exitWhenOrphaned(watch: OrphanWatch): NodeJS.Timeout {
  const timer = setInterval(() => {
    if (watch.currentParent() !== watch.parent) {
      clearInterval(timer)
      watch.exit()
    }
  }, watch.intervalMs)
  timer.unref()
  return timer
}

/** What `exitOnErrors` watches: the child's output streams and its process, and how to report and leave. */
export interface ErrorExit {
  /** `process.stdout` and `process.stderr`: writing to one after the tool is gone fails with EPIPE. */
  readonly streams: readonly NodeJS.EventEmitter[]
  /** `process`, which emits `uncaughtException`. */
  readonly errors: NodeJS.EventEmitter
  /** Tells about an uncaught error: the tool is still there to read it. */
  readonly report: (error: Error) => void
  /** Exits after an uncaught error. */
  readonly exit: () => void
  /** Leaves at once when the output is broken: the tool is gone, so there's no one to tell. */
  readonly abandon: () => void
}

/**
 * Exits the child on an uncaught error, or once its output is broken, instead of letting Electron show its "A
 * JavaScript error occurred in the main process" dialog. That dialog is modal: it stops the child's timers (so
 * `exitWhenOrphaned` never fires) and waits for a click that never comes. A tool killed outright left its Electron
 * exactly so: its next line of output failed with EPIPE, and it sat in the dialog for good.
 */
export function exitOnErrors(watch: ErrorExit): void {
  for (const stream of watch.streams) stream.on('error', watch.abandon)
  watch.errors.on('uncaughtException', (error: Error) => {
    watch.report(error)
    watch.exit()
  })
}
