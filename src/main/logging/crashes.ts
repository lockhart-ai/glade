/**
 * Logs the main process's uncaught exceptions and unhandled rejections. An uncaught exception is only watched
 * (`uncaughtExceptionMonitor`), so Electron still handles it as it would have; an unhandled rejection is logged in
 * place of Node's warning.
 */
import type { Logger } from './logger'

/** The part of `process` crash logging listens to. */
export interface CrashSource {
  on(event: 'uncaughtExceptionMonitor', listener: NodeJS.UncaughtExceptionListener): unknown
  on(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): unknown
  off(event: 'uncaughtExceptionMonitor', listener: NodeJS.UncaughtExceptionListener): unknown
  off(event: 'unhandledRejection', listener: NodeJS.UnhandledRejectionListener): unknown
}

/** Starts logging `source`'s crashes. Answers with what stops it. */
export function logCrashes(source: CrashSource, log: Logger): () => void {
  const onException: NodeJS.UncaughtExceptionListener = (error, origin) => {
    log.error('uncaught exception', { origin, error })
  }
  const onRejection: NodeJS.UnhandledRejectionListener = (reason) => {
    log.error('unhandled rejection', { reason })
  }
  source.on('uncaughtExceptionMonitor', onException)
  source.on('unhandledRejection', onRejection)
  return () => {
    source.off('uncaughtExceptionMonitor', onException)
    source.off('unhandledRejection', onRejection)
  }
}
