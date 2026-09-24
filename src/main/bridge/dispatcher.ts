import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  type BridgeResult,
  type CommandResponse,
  type GladeEvent,
} from '../../shared/bridge'
import type { Emit, Handlers } from './handlers'
import { InvalidRequestError, type RequestParsers } from './requests'

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
  parsers: RequestParsers,
  command: C,
  raw: unknown,
): Promise<BridgeResult<CommandResponse<C>>> {
  let request
  try {
    request = parsers[command](raw)
  } catch (error) {
    if (!(error instanceof InvalidRequestError)) throw error
    return { ok: false, error: bridgeError(BridgeErrorCode.InvalidRequest, `${command}: ${error.message}`) }
  }
  return { ok: true, value: await handlers[command](request) }
}

/** Validates each request at the boundary, then hands it to the command's handler. */
export function createDispatcher(handlers: Handlers, parsers: RequestParsers): Dispatch {
  return async (command, request) => {
    if (!isCommandName(command)) {
      return { ok: false, error: bridgeError(BridgeErrorCode.UnknownCommand, `Unknown command ${String(command)}`) }
    }
    try {
      return await run(handlers, parsers, command, request)
    } catch (error) {
      console.error(`Command ${command} failed`, error)
      return { ok: false, error: bridgeError(BridgeErrorCode.Internal, `${command} failed: ${describe(error)}`) }
    }
  }
}

/** Where events go: each open window's `webContents`. */
export interface EventTarget {
  send(channel: string, event: GladeEvent): void
}

/** Sends an event on `channel` to every target open when it's emitted. */
export function createBroadcast(channel: string, targets: () => readonly EventTarget[]): Emit {
  return (event) => {
    for (const target of targets()) target.send(channel, event)
  }
}
