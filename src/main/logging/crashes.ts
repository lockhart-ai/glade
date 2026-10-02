/**
 * Logs the main process's uncaught exceptions and unhandled rejections. An uncaught exception is only watched
 * (`uncaughtExceptionMonitor`), so Electron still handles it as it would have; an unhandled rejection is logged in
 * place of Node's warning.
 *
 * Electron handles an uncaught exception in main by putting up an error dialog, which is modal: main stops until it's
 * answered. A test mode must never show anything, and nobody is there to answer it, so the app hung, on screen, until
 * it was killed (#375, #439). A test mode passes `fatal` instead: the exception is then handled here, so Electron shows
 * no dialog, and `fatal` ends the app at once, which fails the test that hit it.
 */
import type { Logger } from './logger'

/** The part of `process` crash logging listens to. */
export interface CrashSource {
  on(event: 'uncaughtExceptionMonitor' | 'uncaughtException', listener: NodeJS.UncaughtExceptionListener): unknown
  on(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): unknown
  off(event: 'uncaughtExceptionMonitor' | 'uncaughtException', listener: NodeJS.UncaughtExceptionListener): unknown
  off(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): unknown
}

/**
 * Starts logging `source`'s crashes. Answers with what stops it. With `fatal`, an uncaught exception is handled here in
 * Electron's place (no error dialog), by calling it once the exception is logged.
 */
export function logCrashes(source: CrashSource, log: Logger, fatal?: () => void): () => void {
  const onException: NodeJS.UncaughtExceptionListener = (error, origin) => {
    log.error('uncaught exception', { origin, error })
  }
  const onRejection: NodeJS.UnhandledRejectionListener = (reason) => {
    log.error('unhandled rejection', { reason })
  }
  const onFatal: NodeJS.UncaughtExceptionListener = () => {
    fatal?.()
  }
  source.on('uncaughtExceptionMonitor', onException)
  if (fatal !== undefined) source.on('uncaughtException', onFatal)
  source.on('unhandledRejection', onRejection)
  return () => {
    source.off('uncaughtExceptionMonitor', onException)
    source.off('uncaughtException', onFatal)
    source.off('unhandledRejection', onRejection)
  }
}
