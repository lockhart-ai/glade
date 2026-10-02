import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
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

it('leaves an uncaught exception to Electron by default: it only watches', () => {
  const source = new EventEmitter()
  const stop = logCrashes(source, createMemoryLog().logger)
  expect(source.listenerCount('uncaughtException')).toBe(0)
  stop()
})

// #439: Electron's dialog for an uncaught exception in main is modal, so a test mode's app hung on screen behind it.
it('handles an uncaught exception itself when given what to do, once it is logged, until it is stopped', () => {
  const source = new EventEmitter()
  const log = createMemoryLog()
  const fatal = vi.fn(() => {
    expect(log.records.map(({ message }) => message)).toEqual(['uncaught exception'])
  })
  const stop = logCrashes(source, log.logger, fatal)
  const error = new Error('main blew up')

  // As Node does: the monitor first, then the handlers. Having a handler is what keeps Electron's dialog away.
  source.emit('uncaughtExceptionMonitor', error, 'uncaughtException')
  expect(source.emit('uncaughtException', error, 'uncaughtException')).toBe(true)
  expect(fatal).toHaveBeenCalledOnce()

  stop()
  expect(source.listenerCount('uncaughtException')).toBe(0)
})
