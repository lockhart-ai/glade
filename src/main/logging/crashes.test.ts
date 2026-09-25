import { EventEmitter } from 'node:events'
import { expect, it } from 'vitest'
import { logCrashes } from './crashes'
import { LogLevel } from './logger'
import { createMemoryLog } from './memory-sink'

it('logs uncaught exceptions and unhandled rejections as errors, until it is stopped', () => {
  const source = new EventEmitter()
  const log = createMemoryLog()
  const stop = logCrashes(source, log.logger)
  const error = new Error('main blew up')

  source.emit('uncaughtExceptionMonitor', error, 'uncaughtException')
  source.emit('unhandledRejection', 'a plain string', Promise.resolve())
  stop()
  source.emit('unhandledRejection', 'after stopping', Promise.resolve())

  expect(log.records).toEqual([
    expect.objectContaining({
      level: LogLevel.Error,
      message: 'uncaught exception',
      fields: { origin: 'uncaughtException', error },
    }),
    expect.objectContaining({
      level: LogLevel.Error,
      message: 'unhandled rejection',
      fields: { reason: 'a plain string' },
    }),
  ])
  expect(source.listenerCount('uncaughtExceptionMonitor')).toBe(0)
  expect(source.listenerCount('unhandledRejection')).toBe(0)
})
