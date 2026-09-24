import type { Database } from 'better-sqlite3'
import { COMMAND_CHANNEL, EVENT_CHANNEL } from '../../shared/bridge'
import { createBroadcast, createDispatcher, type EventTarget } from './dispatcher'
import { createHandlers } from './handlers'
import { REQUEST_PARSERS } from './requests'

/** The part of Electron's `ipcMain` the bridge uses, so tests can stand in a fake. */
export interface MainIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface BridgeOptions {
  readonly ipc: MainIpc
  readonly db: Database
  /** The windows' `webContents` open now, which events are sent to. */
  readonly targets: () => readonly EventTarget[]
}

/** Answers the renderer's commands on the command channel and broadcasts events on the event channel. */
export function registerBridge({ ipc, db, targets }: BridgeOptions): void {
  const emit = createBroadcast(EVENT_CHANNEL, targets)
  const dispatch = createDispatcher(createHandlers({ db, emit }), REQUEST_PARSERS)
  ipc.handle(COMMAND_CHANNEL, (_event, command, request) => dispatch(command, request))
}
