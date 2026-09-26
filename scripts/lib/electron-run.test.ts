import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CLOSE_GRACE_MS,
  describeDuration,
  type ElectronRunOptions,
  type ElectronRunResult,
  exitOnErrors,
  exitWhenOrphaned,
  groupAlive,
  HANG_HINT,
  INTERRUPTS,
  runElectron,
  runExitCode,
  runFailureMessage,
  STEP_PREFIX,
  stepLine,
  waitUntilGone,
} from './electron-run.mjs'

/** Where a run's output goes in a test: collected, so a test can read it back. */
interface TestIo {
  readonly stdout: PassThrough
  readonly stderr: PassThrough
  readonly interrupts: EventEmitter
  readonly out: () => string
  readonly err: () => string
}

function testIo(): TestIo {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const chunks = { out: '', err: '' }
  stdout.on('data', (chunk: Buffer) => (chunks.out += chunk.toString()))
  stderr.on('data', (chunk: Buffer) => (chunks.err += chunk.toString()))
  return { stdout, stderr, interrupts: new EventEmitter(), out: () => chunks.out, err: () => chunks.err }
}

/**
 * Options that run a stub child: Node on `script`, which gets the run's data folder as `USER_DATA`. It stands in for
 * Electron: it prints what Electron would, and can hang as Electron did.
 */
function stub(script: string, io: TestIo, overrides: Partial<ElectronRunOptions> = {}): ElectronRunOptions {
  return {
    tool: 'render-design',
    command: process.execPath,
    args: ['-e', script],
    cwd: tmpdir(),
    env: (userData) => ({ PATH: process.env.PATH, USER_DATA: userData }),
    timeoutMs: 10_000,
    io,
    ...overrides,
  }
}

/**
 * A stub that ignores SIGTERM (as a hung Electron did), prints a step and then its pid, and then never exits. Its pid
 * comes last, so a test that has seen it knows the run has read the step too.
 */
const HANGS = `
process.on('SIGTERM', () => console.log('ignoring SIGTERM'))
console.log(${JSON.stringify(stepLine('21-settings: waiting for the window to be 1920×1200'))})
console.log('pid ' + process.pid)
setInterval(() => {}, 1000)
`

/** Whether a process is still alive. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The pid a stub printed. */
function pidOf(output: string): number {
  const match = /pid (\d+)/.exec(output)
  if (match === null) throw new Error(`no pid in ${output}`)
  return Number(match[1])
}

/** The pid of the helper a stub printed as `helper <pid>`. */
function helperOf(output: string): number {
  const match = /helper (\d+)/.exec(output)
  if (match === null) throw new Error(`no helper in ${output}`)
  return Number(match[1])
}

/**
 * Resolves once the run has printed `text`. It waits on the output, not on a clock, so a child that's slow to start
 * (a loaded machine can take most of a second to start Node) can't fail a test.
 */
function printed(io: TestIo, text: string): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (!io.out().includes(text)) return
      io.stdout.off('data', check)
      resolve()
    }
    io.stdout.on('data', check)
    check()
  })
}

/**
 * Fakes the run's timers, so a test says when its timeout or stall window runs out: only once the child is up and has
 * printed what the test needs. A real 400 ms timeout raced the child's start, and on a loaded machine killed it before
 * it printed anything.
 */
function fakeRunTimers(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
}

/** Moves the run's clock on by `ms`, then goes back to real timers for the rest of the run (its wait for the group). */
function passTime(ms: number): void {
  vi.advanceTimersByTime(ms)
  vi.useRealTimers()
}

/** A tool name only this test file uses, so other runs' data folders in the temp folder don't count. */
const FOLDER_TOOL = `electron-run-test-${String(process.pid)}`

/** The throwaway data folders this file's runs have left in the temp folder. */
function leftoverFolders(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`glade-${FOLDER_TOOL}-`))
}

/**
 * How long a test that starts real Node processes may take. Its timings run on fake timers, so this only bounds how
 * slowly a loaded machine starts Node, which can take seconds.
 */
const SPAWNS_TIMEOUT_MS = 30_000

describe('runElectron', { timeout: SPAWNS_TIMEOUT_MS }, () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('passes the output through and returns the exit code when the child exits by itself', async () => {
    const io = testIo()
    const result = await runElectron(
      stub(`console.log('Rendered one'); console.error('a warning'); process.exit(3)`, io),
    )
    expect(result).toEqual({ kind: 'exited', code: 3, signal: null })
    expect(io.out()).toBe('Rendered one\n')
    expect(io.err()).toBe('a warning\n')
  })

  it('SIGKILLs a child that ignores SIGTERM when it runs out of time, and names the step it was on', async () => {
    fakeRunTimers()
    const io = testIo()
    const options = stub(HANGS, io, { timeoutMs: 500 })
    const running = runElectron(options)
    await printed(io, 'pid ')
    vi.advanceTimersByTime(499)
    // Not out of time yet.
    expect(alive(pidOf(io.out()))).toBe(true)
    passTime(1)
    const result = await running
    expect(result).toEqual({
      kind: 'stopped',
      reason: 'timeout',
      step: '21-settings: waiting for the window to be 1920×1200',
    })
    // The step line is the run's to keep, not printed.
    expect(io.out()).not.toContain(STEP_PREFIX)
    expect(alive(pidOf(io.out()))).toBe(false)
    expect(runFailureMessage(options, result)).toBe(
      "render-design: Electron didn't finish in 1 s, so it was stopped. " +
        `It was stuck on: 21-settings: waiting for the window to be 1920×1200.\n${HANG_HINT}`,
    )
    expect(runExitCode(result)).toBe(1)
  })

  it('fails fast when no progress line comes, long before the timeout', async () => {
    fakeRunTimers()
    const io = testIo()
    const options = stub(HANGS, io, { timeoutMs: 60_000, stall: { ms: 400, progress: /^Rendered / } })
    const running = runElectron(options)
    await printed(io, 'pid ')
    // The stall window, a small part of the timeout, is enough to stop it.
    passTime(400)
    const result = await running
    expect(result).toMatchObject({ kind: 'stopped', reason: 'stall' })
    expect(alive(pidOf(io.out()))).toBe(false)
    expect(runFailureMessage(options, result)).toMatch(
      /^render-design: nothing finished in 0 s, so Electron was stopped/,
    )
  })

  it('keeps going while progress lines come, and stops once they stop', async () => {
    fakeRunTimers()
    const io = testIo()
    // Renders five screens, each once the test lets it (by writing a go-<n> file into its data folder), then prints a
    // step and a line that isn't progress, and hangs.
    const script = `
      const { existsSync } = require('node:fs')
      const { join } = require('node:path')
      let count = 0
      const next = () => {
        count++
        if (count > 5) {
          console.log(${JSON.stringify(stepLine('6: waiting for fonts'))})
          console.log('idle')
          setInterval(() => {}, 1000)
          return
        }
        console.log('Rendered ' + count)
        const gate = join(process.env.USER_DATA, 'go-' + count)
        const wait = setInterval(() => { if (existsSync(gate)) { clearInterval(wait); next() } }, 10)
      }
      next()`
    let folder = ''
    const options = stub(script, io, {
      stall: { ms: 350, progress: /^Rendered / },
      env: (userData) => {
        folder = userData
        return { PATH: process.env.PATH, USER_DATA: userData }
      },
    })
    const running = runElectron(options)
    for (let screen = 1; screen <= 5; screen++) {
      await printed(io, `Rendered ${String(screen)}\n`)
      // Most of the stall window passes on each screen, 1.5 s in all, but each progress line starts it over.
      vi.advanceTimersByTime(300)
      writeFileSync(join(folder, `go-${String(screen)}`), '')
    }
    await printed(io, 'idle\n')
    // The window runs out 350 ms after the last progress line; the line that isn't progress didn't start it over.
    passTime(50)
    const result = await running
    expect(io.out()).toBe('Rendered 1\nRendered 2\nRendered 3\nRendered 4\nRendered 5\nidle\n')
    expect(result).toEqual({ kind: 'stopped', reason: 'stall', step: '6: waiting for fonts' })
  })

  it('says the child never named a step when it hung before printing one', async () => {
    const io = testIo()
    const options = stub('setInterval(() => {}, 1000)', io, { stall: { ms: 200, progress: /^Rendered / } })
    const result = await runElectron(options)
    expect(result).toEqual({ kind: 'stopped', reason: 'stall', step: undefined })
    expect(runFailureMessage(options, result)).toContain('It never said what it was waiting on.')
  })

  it('SIGKILLs the child when the tool is interrupted, and stops listening for interrupts after', async () => {
    const io = testIo()
    const options = stub(HANGS, io)
    const running = runElectron(options)
    await printed(io, 'pid ')
    expect(io.interrupts.listenerCount('SIGTERM')).toBe(1)
    io.interrupts.emit('SIGTERM')
    const result = await running
    expect(result).toMatchObject({ kind: 'stopped', reason: 'interrupt' })
    expect(alive(pidOf(io.out()))).toBe(false)
    expect(io.out()).not.toContain('ignoring SIGTERM')
    for (const signal of INTERRUPTS) expect(io.interrupts.listenerCount(signal)).toBe(0)
    expect(runFailureMessage(options, result)).toBe(
      'render-design: interrupted, so Electron was stopped. ' +
        'It was stuck on: 21-settings: waiting for the window to be 1920×1200.',
    )
  })

  it('SIGKILLs the helpers a hung child started along with it, and returns only once they are gone', async () => {
    fakeRunTimers()
    const io = testIo()
    // A helper that ignores SIGTERM, as a wedged GPU process would, and outlives the child.
    const script = `
      const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      )}], { stdio: 'ignore' })
      console.log('helper ' + helper.pid)
      ${HANGS}`
    const running = runElectron(stub(script, io, { timeoutMs: 500 }))
    await printed(io, 'pid ')
    passTime(500)
    const result = await running
    expect(result).toMatchObject({ kind: 'stopped', reason: 'timeout' })
    expect(alive(helperOf(io.out()))).toBe(false)
    expect(alive(pidOf(io.out()))).toBe(false)
  })

  it('SIGKILLs a helper left running after the child exits by itself, and returns only once it is gone', async () => {
    const io = testIo()
    const script = `
      const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      helper.unref()
      console.log('helper ' + helper.pid)`
    const result = await runElectron(stub(script, io))
    expect(result).toEqual({ kind: 'exited', code: 0, signal: null })
    expect(alive(helperOf(io.out()))).toBe(false)
  })

  it('reports a child it could not start', async () => {
    const io = testIo()
    const options = stub('', io, { command: '/no/such/electron' })
    const result = await runElectron(options)
    expect(result).toMatchObject({ kind: 'failed' })
    expect(runFailureMessage(options, result)).toMatch(/^render-design: couldn't start Electron: .*ENOENT/)
    expect(runExitCode(result)).toBe(1)
  })

  it('stops waiting for output that a process the child started holds open after the child exits', async () => {
    fakeRunTimers()
    const io = testIo()
    // A grandchild inherits the child's output and outlives it by longer than the grace period.
    const script = `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit', detached: true }).unref()
      console.log('Rendered')`
    let done = false
    const running = runElectron(stub(script, io)).finally(() => {
      done = true
    })
    // The child has exited once the run starts its grace period, a second timer beside the run's timeout.
    while (vi.getTimerCount() < 2) await new Promise((resolve) => setImmediate(resolve))
    vi.advanceTimersByTime(CLOSE_GRACE_MS - 1)
    await new Promise((resolve) => setImmediate(resolve))
    expect(done).toBe(false)
    passTime(1)
    expect(await running).toEqual({ kind: 'exited', code: 0, signal: null })
    expect(io.out()).toBe('Rendered\n')
  })

  describe('its data folder', () => {
    afterEach(() => {
      expect(leftoverFolders()).toEqual([])
    })

    it('is a fresh one per run, in the temp folder, removed after the run', async () => {
      const io = testIo()
      // Each run writes to its folder, and prints it.
      const script = `
        const fs = require('node:fs')
        fs.writeFileSync(require('node:path').join(process.env.USER_DATA, 'SingletonLock'), 'locked')
        console.log(process.env.USER_DATA + ' ' + fs.readdirSync(process.env.USER_DATA).join(','))`
      const options = stub(script, io, { tool: FOLDER_TOOL })
      const [first, second] = await Promise.all([runElectron(options), runElectron(options)])
      expect(first).toMatchObject({ kind: 'exited', code: 0 })
      expect(second).toMatchObject({ kind: 'exited', code: 0 })
      const folders = io
        .out()
        .trim()
        .split('\n')
        .map((line) => line.split(' '))
      expect(folders).toHaveLength(2)
      for (const [folder, files] of folders) {
        expect(folder?.startsWith(join(tmpdir(), `glade-${FOLDER_TOOL}-`))).toBe(true)
        expect(files).toBe('SingletonLock')
        expect(existsSync(folder ?? '')).toBe(false)
      }
      expect(folders[0]?.[0]).not.toBe(folders[1]?.[0])
    })

    it('is removed after a hung child is killed, so the next run starts clean', async () => {
      fakeRunTimers()
      const io = testIo()
      // A helper in the child's group writes cache files into the folder nonstop, as Electron's do, until it's killed.
      const writesCache = `
        const fs = require('node:fs')
        const { join } = require('node:path')
        const cache = join(process.env.USER_DATA, 'Cache')
        fs.mkdirSync(cache, { recursive: true })
        let count = 0
        const write = () => {
          fs.writeFileSync(join(cache, 'f' + count++), 'x'.repeat(4096))
          if (count === 1) console.log('writing')
          setImmediate(write)
        }
        write()`
      const script = `
        const { join } = require('node:path')
        require('node:fs').writeFileSync(join(process.env.USER_DATA, 'SingletonLock'), 'locked')
        const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(writesCache)}], {
          stdio: ['ignore', 'inherit', 'ignore'],
        })
        console.log('folder ' + process.env.USER_DATA)
        console.log('helper ' + helper.pid)
        ${HANGS}`
      const running = runElectron(stub(script, io, { tool: FOLDER_TOOL, timeoutMs: 400 }))
      await printed(io, 'pid ')
      await printed(io, 'writing\n')
      const folder = /folder (\S+)/.exec(io.out())?.[1] ?? ''
      expect(readdirSync(folder).sort()).toEqual(['Cache', 'SingletonLock'])
      passTime(400)
      const result = await running
      expect(result).toMatchObject({ kind: 'stopped', reason: 'timeout' })
      expect(alive(pidOf(io.out()))).toBe(false)
      expect(alive(helperOf(io.out()))).toBe(false)
      expect(existsSync(folder)).toBe(false)
    })
  })
})

describe('groupAlive', { timeout: SPAWNS_TIMEOUT_MS }, () => {
  it('is true while a process group has a process in it, and false once they are all gone', async () => {
    const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
    await once(leader, 'spawn')
    const group = leader.pid ?? 0
    expect(groupAlive(group)).toBe(true)
    const exited = once(leader, 'exit')
    process.kill(-group, 'SIGKILL')
    await exited
    expect(groupAlive(group)).toBe(false)
  })
})

describe('waitUntilGone', () => {
  it('is done at once when nothing is left', async () => {
    const stillThere = vi.fn(() => false)
    expect(await waitUntilGone({ alive: stillThere, timeoutMs: 1000, intervalMs: 10 })).toBe(true)
    expect(stillThere).toHaveBeenCalledOnce()
  })

  it('looks again until it is gone', async () => {
    let looks = 0
    const stillThere = (): boolean => ++looks < 4
    expect(await waitUntilGone({ alive: stillThere, timeoutMs: 10_000, intervalMs: 5 })).toBe(true)
    expect(looks).toBe(4)
  })

  it('gives up once its time is up, so a process that never goes can’t hold up the run', async () => {
    const stillThere = vi.fn(() => true)
    expect(await waitUntilGone({ alive: stillThere, timeoutMs: 50, intervalMs: 10 })).toBe(false)
    expect(stillThere.mock.calls.length).toBeGreaterThan(1)
  })
})

describe('runFailureMessage', () => {
  const options = stub('', testIo(), { timeoutMs: 300_000, stall: { ms: 60_000, progress: /^Rendered / } })

  it('says nothing when the child exited by itself', () => {
    expect(runFailureMessage(options, { kind: 'exited', code: 1, signal: null })).toBeUndefined()
  })

  it('gives the timeout and the stall window in words', () => {
    const timedOut: ElectronRunResult = { kind: 'stopped', reason: 'timeout', step: undefined }
    expect(runFailureMessage(options, timedOut)).toContain("didn't finish in 5 minutes")
    const stalled: ElectronRunResult = { kind: 'stopped', reason: 'stall', step: 'a: waiting for fonts' }
    expect(runFailureMessage(options, stalled)).toBe(
      'render-design: nothing finished in 60 s, so Electron was stopped. It was stuck on: a: waiting for fonts.\n' +
        HANG_HINT,
    )
  })

  it('falls back to the timeout for a stall without a stall window', () => {
    const withoutStall: ElectronRunOptions = { ...options, stall: undefined }
    const stalled: ElectronRunResult = { kind: 'stopped', reason: 'stall', step: undefined }
    expect(runFailureMessage(withoutStall, stalled)).toContain('nothing finished in 5 minutes')
  })
})

describe('runExitCode', () => {
  it("is the child's own code, or 1 when it was killed by a signal", () => {
    expect(runExitCode({ kind: 'exited', code: 0, signal: null })).toBe(0)
    expect(runExitCode({ kind: 'exited', code: null, signal: 'SIGSEGV' })).toBe(1)
  })
})

describe('describeDuration', () => {
  it('uses seconds below two minutes, and whole minutes from there', () => {
    expect(describeDuration(60_000)).toBe('60 s')
    expect(describeDuration(90_000)).toBe('90 s')
    expect(describeDuration(120_000)).toBe('2 minutes')
    expect(describeDuration(300_000)).toBe('5 minutes')
    expect(describeDuration(150_000)).toBe('150 s')
  })
})

describe('exitWhenOrphaned', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('exits once the parent is gone, and only once', () => {
    vi.useFakeTimers()
    let parent = 100
    const exit = vi.fn()
    const timer = exitWhenOrphaned({ parent: 100, currentParent: () => parent, exit, intervalMs: 1000 })
    expect(timer.hasRef()).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(exit).not.toHaveBeenCalled()
    // The parent died; the child was handed to launchd.
    parent = 1
    vi.advanceTimersByTime(1000)
    expect(exit).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(5000)
    expect(exit).toHaveBeenCalledOnce()
  })
})

describe('exitOnErrors', () => {
  it('abandons the run when an output stream breaks, without reporting to no one', () => {
    const stdout = new EventEmitter()
    const stderr = new EventEmitter()
    const exit = vi.fn()
    const abandon = vi.fn()
    const report = vi.fn()
    exitOnErrors({ streams: [stdout, stderr], errors: new EventEmitter(), report, exit, abandon })
    // Without a listener, this error would be thrown: the uncaught exception behind Electron's dialog.
    stdout.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))
    expect(abandon).toHaveBeenCalledOnce()
    stderr.emit('error', new Error('write EPIPE'))
    expect(abandon).toHaveBeenCalledTimes(2)
    expect(report).not.toHaveBeenCalled()
    expect(exit).not.toHaveBeenCalled()
  })

  it('reports an uncaught error and exits, instead of leaving it to a dialog', () => {
    const errors = new EventEmitter()
    const exit = vi.fn()
    const abandon = vi.fn()
    const report = vi.fn()
    exitOnErrors({ streams: [], errors, report, exit, abandon })
    const error = new Error('boom')
    errors.emit('uncaughtException', error)
    expect(report).toHaveBeenCalledWith(error)
    expect(exit).toHaveBeenCalledOnce()
    expect(abandon).not.toHaveBeenCalled()
  })
})
