/**
 * The main process's logger (`docs/logs.md`): every part of main that logs is handed a `Logger`, rather than importing
 * one, so a test can hand it one that keeps what it logs (`./memory-sink`). The app hands everything one logger, made
 * on the log file (`./file-sink`), each part with its own scope.
 *
 * A record is one line of JSON: when, how bad, which part of the app (`LogScope`), the task it's about where there is
 * one (`taskId`), what happened, and its fields (`./format`).
 */

/** How bad a record is. Debug records carry the most detail, message text included; they're on while we dogfood. */
export enum LogLevel {
  Debug = 'debug',
  Info = 'info',
  Warn = 'warn',
  Error = 'error',
}

/** The levels from least to most severe. */
const SEVERITY: readonly LogLevel[] = [LogLevel.Debug, LogLevel.Info, LogLevel.Warn, LogLevel.Error]

/** Whether a record at `level` passes a logger set to `threshold`. */
export function passes(level: LogLevel, threshold: LogLevel): boolean {
  return SEVERITY.indexOf(level) >= SEVERITY.indexOf(threshold)
}

/** Which part of the app a record comes from. */
export enum LogScope {
  /** Starting, quitting, windows, crashes. */
  App = 'app',
  /** The login shell's environment the agents run in. */
  Env = 'env',
  /** Opening and migrating the database. */
  Db = 'db',
  /** The renderer's commands to main. */
  Ipc = 'ipc',
  /** Agent sessions and every message the SDK sends. */
  Agent = 'agent',
  /** The agent runner: turns, queue, stops, retries, pauses, compaction and subagents. */
  Runner = 'runner',
  /** A task's state, activity, error and pause as they change; tasks created and deleted. */
  Task = 'task',
  /** The chat: the user's and the agent's messages, and the message queue. */
  Chat = 'chat',
  /** The tool log: each tool call, narration, divider and compaction. */
  Tools = 'tools',
  /** The agent's questions, asked, answered and withdrawn. */
  Questions = 'questions',
  /** Native notifications. */
  Notifications = 'notifications',
  /** The terminal tabs and their shells. */
  Terminal = 'terminal',
  /** Errors in the window, forwarded by the renderer. */
  Renderer = 'renderer',
  /** The screenshot and e2e test modes. */
  TestMode = 'test-mode',
}

/** A record's fields: anything JSON can say, and errors (`./format` turns them into their name, message and stack). */
export type LogFields = Readonly<Record<string, unknown>>

/** One thing that happened. */
export interface LogRecord {
  readonly time: Date
  readonly level: LogLevel
  readonly scope: LogScope
  readonly message: string
  readonly fields: LogFields
}

/** Where records go: the log file, the terminal, or, in tests, memory. */
export interface LogSink {
  write(record: LogRecord): void
}

export interface Logger {
  debug(message: string, fields?: LogFields): void
  info(message: string, fields?: LogFields): void
  warn(message: string, fields?: LogFields): void
  error(message: string, fields?: LogFields): void
  /** The same logger, for another part of the app. */
  scoped(scope: LogScope): Logger
  /** The same logger, with `fields` on every record it writes: e.g. `{ taskId }`. A record's own fields win. */
  with(fields: LogFields): Logger
}

export interface LoggerOptions {
  readonly sink: LogSink
  /** The least severe level written. Debug by default. */
  readonly level?: LogLevel
  readonly scope?: LogScope
  /** When a record happened: now, by default. */
  readonly now?: () => Date
}

/** A logger that writes to `sink`, in the app's scope unless told otherwise. */
export function createLogger({
  sink,
  level: threshold = LogLevel.Debug,
  scope = LogScope.App,
  now = () => new Date(),
}: LoggerOptions): Logger {
  const make = (current: LogScope, bound: LogFields): Logger => {
    const write =
      (level: LogLevel) =>
      (message: string, fields: LogFields = {}): void => {
        if (!passes(level, threshold)) return
        sink.write({ time: now(), level, scope: current, message, fields: { ...bound, ...fields } })
      }
    return {
      debug: write(LogLevel.Debug),
      info: write(LogLevel.Info),
      warn: write(LogLevel.Warn),
      error: write(LogLevel.Error),
      scoped: (next) => make(next, bound),
      with: (fields) => make(current, { ...bound, ...fields }),
    }
  }
  return make(scope, {})
}

/** A sink that prints each record's message and fields on the console, at its level. */
export const CONSOLE_SINK: LogSink = {
  write({ level, scope, message, fields }) {
    const text = `[${scope}] ${message}`
    if (Object.keys(fields).length === 0) console[level](text)
    else console[level](text, fields)
  },
}

/**
 * What a part of main logs to when it isn't handed a logger: the console. The app always hands one over, so this is
 * only ever for tests that don't care what's logged.
 */
export const CONSOLE_LOGGER: Logger = createLogger({ sink: CONSOLE_SINK })
