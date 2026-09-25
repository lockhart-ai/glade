// The log file, written for real with electron-log into a temp folder.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileLogSink, LOG_FILE_NAME, LOG_KEEP, LOG_MAX_BYTES, rotatedFile, rotateLogFiles } from './file-sink'
import { createLogger, LogScope } from './logger'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'glade-logs-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

/** The lines of a log file, parsed. */
function lines(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((text) => text !== '')
    .map((text) => JSON.parse(text) as Record<string, unknown>)
}

describe('createFileLogSink', () => {
  it('appends each record to main.log as a line of JSON, making the folder, debug records included', () => {
    const folder = join(dir, 'Logs', 'Glade')
    const sink = createFileLogSink({ dir: folder, toConsole: false })
    const log = createLogger({ sink })

    log.debug('sdk message', { taskId: 'task-1', type: 'assistant' })
    log.info('turn started', { taskId: 'task-1', turn: 1 })
    log.scoped(LogScope.Ipc).warn('command failed', { command: 'tasks.send' })
    log.error('uncaught exception', { error: new Error('boom') })

    expect(sink.file).toBe(join(folder, LOG_FILE_NAME))
    expect(lines(sink.file)).toEqual([
      expect.objectContaining({
        level: 'debug',
        scope: 'app',
        taskId: 'task-1',
        msg: 'sdk message',
        type: 'assistant',
      }),
      expect.objectContaining({ level: 'info', taskId: 'task-1', msg: 'turn started', turn: 1 }),
      expect.objectContaining({ level: 'warn', scope: 'ipc', msg: 'command failed', command: 'tasks.send' }),
      expect.objectContaining({ level: 'error', error: expect.objectContaining({ message: 'boom' }) as unknown }),
    ])
  })

  it('adds to a log that is already there, as the next launch does', () => {
    writeFileSync(join(dir, LOG_FILE_NAME), '{"msg":"last launch"}\n')

    createLogger({ sink: createFileLogSink({ dir, toConsole: false }) }).info('this launch')

    expect(lines(join(dir, LOG_FILE_NAME)).map(({ msg }) => msg)).toEqual(['last launch', 'this launch'])
  })

  it('rotates the log by size, keeping the newest records and only so many old files', () => {
    const sink = createFileLogSink({ dir, toConsole: false, maxBytes: 400, keep: 2 })
    const log = createLogger({ sink })

    for (let index = 0; index < 40; index += 1) log.info('record', { index })

    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.2.log', 'main.log'])
    const current = lines(join(dir, 'main.log')).map(({ index }) => index as number)
    const previous = lines(join(dir, 'main.1.log')).map(({ index }) => index as number)
    const oldest = lines(join(dir, 'main.2.log')).map(({ index }) => index as number)
    expect(current.at(-1)).toBe(39)
    // Each file carries on where the older one stopped.
    expect(previous.at(-1)).toBe((current[0] ?? 0) - 1)
    expect(oldest.at(-1)).toBe((previous[0] ?? 0) - 1)
    for (const file of ['main.log', 'main.1.log', 'main.2.log']) {
      expect(readFileSync(join(dir, file)).length).toBeLessThan(400 + 100)
    }
  })

  it('rotates at 5 MB, keeping 5 old files, by default', () => {
    expect(LOG_MAX_BYTES).toBe(5 * 1024 * 1024)
    expect(LOG_KEEP).toBe(5)
  })

  it('prints each record on the terminal too when asked, warnings and errors to stderr', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const logger = createLogger({ sink: createFileLogSink({ dir, toConsole: true }) })

    logger.debug('one')
    logger.info('two')
    logger.warn('three')
    logger.error('four')

    const printed = (spy: typeof log): string[] =>
      spy.mock.calls.map(([text]) => (JSON.parse(String(text)) as { msg: string }).msg)
    expect(printed(log)).toEqual(['one', 'two'])
    expect(printed(warn)).toEqual(['three'])
    expect(printed(error)).toEqual(['four'])
  })

  it('prints nothing when not asked to', () => {
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => undefined),
    )

    createLogger({ sink: createFileLogSink({ dir, toConsole: false }) }).error('quiet')

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('rotateLogFiles', () => {
  it('names the rotated files main.1.log, main.2.log…', () => {
    expect(rotatedFile('/logs/main.log', 0)).toBe('/logs/main.log')
    expect(rotatedFile('/logs/main.log', 3)).toBe('/logs/main.3.log')
  })

  it('moves each file a place back and drops the one past the last kept', () => {
    const file = join(dir, 'main.log')
    for (const [name, text] of [
      ['main.log', 'current'],
      ['main.1.log', 'one'],
      ['main.2.log', 'two'],
    ]) {
      writeFileSync(join(dir, name ?? ''), text ?? '')
    }

    rotateLogFiles(file, 2)

    expect(existsSync(file)).toBe(false)
    expect(readFileSync(join(dir, 'main.1.log'), 'utf8')).toBe('current')
    expect(readFileSync(join(dir, 'main.2.log'), 'utf8')).toBe('one')
    expect(existsSync(join(dir, 'main.3.log'))).toBe(false)
  })

  it('copes with gaps, and with no old files at all', () => {
    const file = join(dir, 'main.log')
    writeFileSync(file, 'current')
    writeFileSync(join(dir, 'main.3.log'), 'three')

    rotateLogFiles(file, 5)

    expect(readdirSync(dir).sort()).toEqual(['main.1.log', 'main.4.log'])
  })
})
