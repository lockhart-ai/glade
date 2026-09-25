/**
 * A logger that keeps what it's given, for tests: hand `logger` to the code under test, then read `records`.
 */
import { createLogger, type LogRecord, type Logger, type LogScope } from './logger'

export interface MemoryLog {
  readonly logger: Logger
  /** Every record written, oldest first. */
  readonly records: LogRecord[]
  /** The records whose message is `message`, oldest first. */
  withMessage(message: string): LogRecord[]
  /** The records in `scope`, oldest first. */
  inScope(scope: LogScope): LogRecord[]
}

export function createMemoryLog(scope?: LogScope): MemoryLog {
  const records: LogRecord[] = []
  const logger = createLogger({
    sink: {
      write(record) {
        records.push(record)
      },
    },
    ...(scope === undefined ? {} : { scope }),
  })
  return {
    logger,
    records,
    withMessage: (message) => records.filter((record) => record.message === message),
    inScope: (wanted) => records.filter((record) => record.scope === wanted),
  }
}
