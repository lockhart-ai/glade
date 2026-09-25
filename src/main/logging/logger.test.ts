import { afterEach, describe, expect, it, vi } from 'vitest'
import { CONSOLE_LOGGER, createLogger, LogLevel, LogScope, passes, SILENT_LOGGER, type LogRecord } from './logger'
import { createMemoryLog } from './memory-sink'

const NOW = new Date('2026-09-24T10:15:00.000Z')

/** A logger that keeps its records, at `level`, stamped `NOW`. */
function keeping(level?: LogLevel): { records: LogRecord[]; logger: ReturnType<typeof createLogger> } {
  const records: LogRecord[] = []
  const logger = createLogger({
    sink: { write: (record) => records.push(record) },
    now: () => NOW,
    ...(level === undefined ? {} : { level }),
  })
  return { records, logger }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('passes', () => {
  it('lets through its own level and the more severe ones', () => {
    expect(passes(LogLevel.Debug, LogLevel.Debug)).toBe(true)
    expect(passes(LogLevel.Error, LogLevel.Info)).toBe(true)
    expect(passes(LogLevel.Info, LogLevel.Warn)).toBe(false)
    expect(passes(LogLevel.Debug, LogLevel.Info)).toBe(false)
  })
})

describe('createLogger', () => {
  it('writes each level, in the app scope, stamped with when it happened', () => {
    const { records, logger } = keeping()

    logger.debug('one')
    logger.info('two', { count: 2 })
    logger.warn('three')
    logger.error('four')

    expect(records).toEqual([
      { time: NOW, level: LogLevel.Debug, scope: LogScope.App, message: 'one', fields: {} },
      { time: NOW, level: LogLevel.Info, scope: LogScope.App, message: 'two', fields: { count: 2 } },
      { time: NOW, level: LogLevel.Warn, scope: LogScope.App, message: 'three', fields: {} },
      { time: NOW, level: LogLevel.Error, scope: LogScope.App, message: 'four', fields: {} },
    ])
  })

  it('writes debug records by default, and drops what is below its level', () => {
    const { records, logger } = keeping(LogLevel.Warn)

    logger.debug('dropped')
    logger.info('dropped')
    logger.warn('kept')
    logger.error('kept')

    expect(records.map(({ level }) => level)).toEqual([LogLevel.Warn, LogLevel.Error])
    const all = keeping()
    all.logger.debug('kept')
    expect(all.records).toHaveLength(1)
  })

  it('stamps each record with the time it was written by default', () => {
    const records: LogRecord[] = []
    const logger = createLogger({ sink: { write: (record) => records.push(record) } })
    const before = Date.now()

    logger.info('now')

    expect(records[0]?.time.getTime()).toBeGreaterThanOrEqual(before)
    expect(records[0]?.time.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('carries a scope and bound fields to every record, and a record’s own fields win', () => {
    const { records, logger } = keeping()
    const task = logger.scoped(LogScope.Runner).with({ taskId: 'task-1', turn: 1 })

    task.info('turn started', { turn: 2 })
    task.scoped(LogScope.Agent).debug('sdk message')
    task.with({ toolUseId: 'toolu_01' }).warn('tool call failed')
    logger.info('unbound')

    expect(records.map(({ scope, message, fields }) => ({ scope, message, fields }))).toEqual([
      { scope: LogScope.Runner, message: 'turn started', fields: { taskId: 'task-1', turn: 2 } },
      { scope: LogScope.Agent, message: 'sdk message', fields: { taskId: 'task-1', turn: 1 } },
      {
        scope: LogScope.Runner,
        message: 'tool call failed',
        fields: { taskId: 'task-1', turn: 1, toolUseId: 'toolu_01' },
      },
      { scope: LogScope.App, message: 'unbound', fields: {} },
    ])
  })

  it('starts in the scope it is given', () => {
    const records: LogRecord[] = []
    createLogger({ sink: { write: (record) => records.push(record) }, scope: LogScope.Db }).info('opened')
    expect(records[0]?.scope).toBe(LogScope.Db)
  })
})

describe('CONSOLE_LOGGER', () => {
  it('prints the scope and message at the record’s level, with its fields when it has some', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    CONSOLE_LOGGER.warn('plain')
    CONSOLE_LOGGER.scoped(LogScope.TestMode).error('failed', { code: 1 })

    expect(warn).toHaveBeenCalledExactlyOnceWith('[app] plain')
    expect(error).toHaveBeenCalledExactlyOnceWith('[test-mode] failed', { code: 1 })
  })
})

describe('SILENT_LOGGER', () => {
  it('prints nothing, however it is scoped', () => {
    const spies = (['debug', 'info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level))

    SILENT_LOGGER.scoped(LogScope.Runner).with({ taskId: 't' }).error('nothing')
    SILENT_LOGGER.debug('nothing')

    for (const spy of spies) expect(spy).not.toHaveBeenCalled()
  })
})

describe('createMemoryLog', () => {
  it('keeps every record, and finds them by message and scope', () => {
    const log = createMemoryLog(LogScope.Runner)

    log.logger.info('turn started')
    log.logger.scoped(LogScope.Agent).info('session starting')
    log.logger.info('turn started')

    expect(log.records).toHaveLength(3)
    expect(log.withMessage('turn started')).toHaveLength(2)
    expect(log.inScope(LogScope.Agent)).toEqual([expect.objectContaining({ message: 'session starting' })])
    expect(createMemoryLog().logger.scoped(LogScope.App)).toBeDefined()
  })
})
