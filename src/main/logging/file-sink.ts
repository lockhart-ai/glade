/**
 * The log file (`docs/logs.md`): `main.log` in the logs folder (`~/Library/Logs/Glade/` in the app), one JSON record per
 * line (`./format`), written with electron-log. Once it passes `maxBytes` it's rotated: it becomes `main.1.log`, the
 * old `main.1.log` becomes `main.2.log`, and so on, keeping `keep` old files. In development the records also go to the
 * terminal.
 *
 * electron-log's Node entry point is used, not its Electron one: it needs nothing from Electron but the folder, which
 * the app passes in, and it sets up no IPC channel of its own (the renderer's errors come through Glade's own bridge).
 */
import { existsSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join, parse } from 'node:path'
import electronLog from 'electron-log/node'
import { formatRecord } from './format'
import { LogLevel, type LogSink } from './logger'

/** The log file's name in the logs folder. */
export const LOG_FILE_NAME = 'main.log'

/** How big the log file gets before it's rotated. */
export const LOG_MAX_BYTES = 5 * 1024 * 1024

/** How many rotated files are kept, besides the current one. */
export const LOG_KEEP = 5

export interface FileLogSinkOptions {
  /** The folder the log goes in. */
  readonly dir: string
  /** Whether the records also go to the terminal: in development. */
  readonly toConsole: boolean
  readonly maxBytes?: number
  readonly keep?: number
}

/** The log file, as a sink, and where it is. */
export interface FileLogSink extends LogSink {
  readonly file: string
}

/**
 * The rotated file `index` places back from `file`: `main.log` → `main.1.log`, `main.2.log`, …; `main.log` itself for 0.
 */
export function rotatedFile(file: string, index: number): string {
  if (index === 0) return file
  const { dir, name, ext } = parse(file)
  return join(dir, `${name}.${String(index)}${ext}`)
}

/**
 * Moves `file` aside as the newest rotated file, each older one a place further back, and removes the one that falls
 * past `keep`. Called by electron-log, which then starts `file` afresh.
 */
export function rotateLogFiles(file: string, keep: number): void {
  rmSync(rotatedFile(file, keep), { force: true })
  for (let index = keep - 1; index >= 0; index -= 1) {
    const from = rotatedFile(file, index)
    if (existsSync(from)) renameSync(from, rotatedFile(file, index + 1))
  }
}

/** A sink that appends each record to `main.log` in `dir`, rotating it by size, and prints it too if asked. */
export function createFileLogSink({
  dir,
  toConsole,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
}: FileLogSinkOptions): FileLogSink {
  const file = join(dir, LOG_FILE_NAME)
  // An instance of its own, so its settings are nobody else's.
  const log = electronLog.create({ logId: `glade-${randomUUID()}` })
  const { file: fileTransport, console: consoleTransport } = log.transports
  fileTransport.resolvePathFn = () => file
  fileTransport.format = '{text}'
  fileTransport.level = 'debug'
  fileTransport.maxSize = maxBytes
  fileTransport.archiveLogFn = () => {
    rotateLogFiles(file, keep)
  }
  consoleTransport.format = '{text}'
  consoleTransport.level = toConsole ? 'debug' : false
  // Errors and warnings to stderr, the rest to stdout, as the same line the file gets.
  consoleTransport.writeFn = ({ message }) => {
    const print = message.level === 'error' ? console.error : message.level === 'warn' ? console.warn : console.log
    print(...(message.data as unknown[]))
  }
  // Only the file and the terminal: nothing is sent anywhere (electron-log can also post to a server, or over IPC).
  Reflect.deleteProperty(log.transports, 'ipc')
  Reflect.deleteProperty(log.transports, 'remote')
  return {
    file,
    write(record) {
      const line = formatRecord(record)
      switch (record.level) {
        case LogLevel.Debug:
          log.debug(line)
          return
        case LogLevel.Info:
          log.info(line)
          return
        case LogLevel.Warn:
          log.warn(line)
          return
        case LogLevel.Error:
          log.error(line)
          return
      }
    },
  }
}
