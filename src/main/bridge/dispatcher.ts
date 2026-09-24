import {
  bridgeError,
  BridgeErrorCode,
  CommandName,
  type BridgeResult,
  type CommandResponse,
  type GladeEvent,
} from '../../shared/bridge'
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

/** Validates each request at the boundary, then hands it to the command's handler. */
export function createDispatcher(handlers: Handlers, schemas: RequestSchemas): Dispatch {
  return async (command, request) => {
    if (!isCommandName(command)) {
      return { ok: false, error: bridgeError(BridgeErrorCode.UnknownCommand, `Unknown command ${String(command)}`) }
    }
    try {
      return await run(handlers, schemas, command, request)
    } catch (error) {
      if (error instanceof CommandFailure) {
        return { ok: false, error: bridgeError(error.code, `${command}: ${error.message}`) }
      }
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
