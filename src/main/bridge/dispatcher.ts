import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  EVENT_BATCH,
  type BridgeResult,
  type CommandResponse,
  type GladeEvent,
  type WindowEvent,
} from '../../shared/bridge'
import { SILENT_LOGGER, type LogFields, type Logger } from '../logging/logger'
import { CommandFailure } from './errors'
import type { Emit } from './events'
import type { Handlers } from './handlers'
import { describeIssues, type RequestSchemas } from './requests'

/** Runs a command that arrived over IPC. Never throws: every failure comes back as a `BridgeResult` error. */
export type Dispatch = (command: unknown, request: unknown) => Promise<BridgeResult<unknown>>

function isCommandName(value: unknown): value is CommandName {
  return Object.values<unknown>(CommandName).includes(value)
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function run<C extends CommandName>(
  handlers: Handlers,
  schemas: RequestSchemas,
  command: C,
  raw: unknown,
): Promise<BridgeResult<CommandResponse<C>>> {
  const parsed = schemas[command].safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      error: bridgeError(BridgeErrorCode.InvalidRequest, `${command}: ${describeIssues(parsed.error)}`),
    }
  }
  return { ok: true, value: await handlers[command](parsed.data) }
}

/** A string property of an object, if it has one. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const field: unknown = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}

/**
 * The task a command is about, for the log: its request's `taskId`, a `tasks.*` command's `id`, or the task it answers
 * with (`tasks.create`). Undefined for a command about no task.
 */
export function commandTaskId(
  command: CommandName,
  request: unknown,
  result?: BridgeResult<unknown>,
): string | undefined {
  const own = stringField(request, 'taskId') ?? (command.startsWith('tasks.') ? stringField(request, 'id') : undefined)
  if (own !== undefined || result?.ok !== true) return own
  return stringField(Reflect.get(Object(result.value), 'task'), 'id')
}

/** What the log says about a command: its name, its task, and the id it names when that isn't the task's. */
function commandFields(command: CommandName, request: unknown, result: BridgeResult<unknown>): LogFields {
  const taskId = commandTaskId(command, request, result)
  const id = stringField(request, 'id')
  return {
    command,
    ...(taskId === undefined ? {} : { taskId }),
    ...(id === undefined || id === taskId ? {} : { id }),
  }
}

/**
 * Validates each request at the boundary, then hands it to the command's handler. Every command is logged, with its
 * task and how it went, but never its request, which may be anything you typed.
 */
export function createDispatcher(handlers: Handlers, schemas: RequestSchemas, log: Logger = SILENT_LOGGER): Dispatch {
  const answer = async (command: CommandName, request: unknown): Promise<BridgeResult<unknown>> => {
    try {
      return await run(handlers, schemas, command, request)
    } catch (error) {
      if (error instanceof CommandFailure) {
        return { ok: false, error: bridgeError(error.code, `${command}: ${error.message}`) }
      }
      log.error('command threw', { ...commandFields(command, request, { ok: true, value: null }), error })
      return { ok: false, error: bridgeError(BridgeErrorCode.Internal, `${command} failed: ${describe(error)}`) }
    }
  }
  return async (command, request) => {
    if (!isCommandName(command)) {
      log.warn('unknown command', { command: String(command) })
      return { ok: false, error: bridgeError(BridgeErrorCode.UnknownCommand, `Unknown command ${String(command)}`) }
    }
    const started = performance.now()
    const result = await answer(command, request)
    const durationMs = Math.round(performance.now() - started)
    const fields = { ...commandFields(command, request, result), durationMs }
    if (result.ok) log.debug('command', { ...fields, ok: true })
    else log.warn('command failed', { ...fields, ok: false, code: result.error.code, error: result.error.message })
    return result
  }
}

/** Where events go: each open window's `webContents`. */
export interface EventTarget {
  send(channel: string, event: WindowEvent): void
}

/**
 * Runs `run`, and sends the windows every event emitted meanwhile as one `EventBatch`, once it has returned (or
 * thrown). Answers with what `run` answered.
 */
export type Batch = <T>(run: () => T) => T

/** What sends events to the windows. */
export interface WindowBroadcast {
  /** Sends an event to every window open when it's emitted, or adds it to the batch being gathered. */
  readonly emit: Emit
  /**
   * Gathers a burst of events (`Batch`): a window applies them in one change, not one per event. A lone event goes as
   * itself, and none sends nothing. A batch started inside another joins it.
   */
  readonly batch: Batch
}

/** Sends events on `channel` to every target open when they're sent. */
export function createBroadcast(channel: string, targets: () => readonly EventTarget[]): WindowBroadcast {
  const send = (event: WindowEvent): void => {
    for (const target of targets()) target.send(channel, event)
  }
  // The events of the batch being gathered, or null when each goes as it's emitted.
  let gathered: GladeEvent[] | null = null
  return {
    emit: (event) => {
      if (gathered === null) send(event)
      else gathered.push(event)
    },
    batch: (run) => {
      if (gathered !== null) return run()
      const events: GladeEvent[] = []
      gathered = events
      try {
        return run()
      } finally {
        gathered = null
        const [only] = events
        if (events.length > 1) send({ type: EVENT_BATCH, events })
        else if (only !== undefined) send(only)
      }
    },
  }
}
