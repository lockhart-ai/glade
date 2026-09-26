import { EventEmitter } from 'node:events'
import { existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  describeDuration,
  type ElectronRunOptions,
  type ElectronRunResult,
  exitOnErrors,
  exitWhenOrphaned,
  HANG_HINT,
  INTERRUPTS,
  runElectron,
  runExitCode,
  runFailureMessage,
  STEP_PREFIX,
  stepLine,
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

/** A stub that ignores SIGTERM (as a hung Electron did), prints its pid and a step, and then never exits. */
const HANGS = `
process.on('SIGTERM', () => console.log('ignoring SIGTERM'))
console.log('pid ' + process.pid)
console.log(${JSON.stringify(stepLine('21-settings: waiting for the window to be 1920×1200'))})
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

/** A tool name only this test file uses, so other runs' data folders in the temp folder don't count. */
const FOLDER_TOOL = `electron-run-test-${String(process.pid)}`

/** The throwaway data folders this file's runs have left in the temp folder. */
function leftoverFolders(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith(`glade-${FOLDER_TOOL}-`))
}

describe('runElectron', () => {
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
    const io = testIo()
    const options = stub(HANGS, io, { timeoutMs: 500 })
    const result = await runElectron(options)
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
    const io = testIo()
    const started = Date.now()
    const options = stub(HANGS, io, { timeoutMs: 60_000, stall: { ms: 400, progress: /^Rendered / } })
    const result = await runElectron(options)
    expect(Date.now() - started).toBeLessThan(5000)
    expect(result).toMatchObject({ kind: 'stopped', reason: 'stall' })
    expect(alive(pidOf(io.out()))).toBe(false)
    expect(runFailureMessage(options, result)).toMatch(
      /^render-design: nothing finished in 0 s, so Electron was stopped/,
    )
  })

  it('keeps going while progress lines come, and stops once they stop', async () => {
    const io = testIo()
    // Renders a screen every 100 ms, five in all, then hangs on the sixth.
    const script = `
      let count = 0
      const timer = setInterval(() => {
        count++
        if (count <= 5) console.log('Rendered ' + count)
        else { console.log(${JSON.stringify(stepLine('6: waiting for fonts'))}); clearInterval(timer); setInterval(() => {}, 1000) }
      }, 100)`
    const result = await runElectron(stub(script, io, { stall: { ms: 350, progress: /^Rendered / } }))
    // Each screen came well inside the stall window, though all five together took longer than it.
    expect(io.out()).toBe('Rendered 1\nRendered 2\nRendered 3\nRendered 4\nRendered 5\n')
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
    await vi.waitFor(() => {
      expect(io.out()).toContain('pid ')
    })
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

  it('SIGKILLs the helpers a hung child started along with it', async () => {
    const io = testIo()
    // A helper that ignores SIGTERM, as a wedged GPU process would, and outlives the child.
    const script = `
      const helper = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      )}], { stdio: 'ignore' })
      console.log('helper ' + helper.pid)
      ${HANGS}`
    const result = await runElectron(stub(script, io, { timeoutMs: 500 }))
    expect(result).toMatchObject({ kind: 'stopped', reason: 'timeout' })
    const helper = Number(/helper (\d+)/.exec(io.out())?.[1])
    await vi.waitFor(() => {
      expect(alive(helper)).toBe(false)
    })
    expect(alive(pidOf(io.out()))).toBe(false)
  })

  it('SIGKILLs a helper left running after the child exits by itself', async () => {
    const io = testIo()
    const script = `
      const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
      helper.unref()
      console.log('helper ' + helper.pid)`
    const result = await runElectron(stub(script, io))
    expect(result).toEqual({ kind: 'exited', code: 0, signal: null })
    const helper = Number(/helper (\d+)/.exec(io.out())?.[1])
    await vi.waitFor(() => {
      expect(alive(helper)).toBe(false)
    })
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
    const io = testIo()
    // A grandchild inherits the child's output and outlives it by longer than the grace period.
    const script = `
      require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { stdio: 'inherit', detached: true }).unref()
      console.log('Rendered')`
    const started = Date.now()
    const result = await runElectron(stub(script, io))
    expect(result).toEqual({ kind: 'exited', code: 0, signal: null })
    expect(Date.now() - started).toBeLessThan(4500)
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
      const io = testIo()
      const script = `
        require('node:fs').writeFileSync(require('node:path').join(process.env.USER_DATA, 'SingletonLock'), 'locked')
        ${HANGS}`
      const result = await runElectron(stub(script, io, { tool: FOLDER_TOOL, timeoutMs: 400 }))
      expect(result).toMatchObject({ kind: 'stopped', reason: 'timeout' })
      expect(alive(pidOf(io.out()))).toBe(false)
    })
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
