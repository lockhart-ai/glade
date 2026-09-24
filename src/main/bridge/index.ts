import type { Database } from 'better-sqlite3'
import { COMMAND_CHANNEL, EVENT_CHANNEL } from '../../shared/bridge'
import type { AgentBackend } from '../agent/backend'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import { createBroadcast, createDispatcher, type EventTarget } from './dispatcher'
import { createHandlers } from './handlers'
import { REQUEST_SCHEMAS } from './requests'

/** The part of Electron's `ipcMain` the bridge uses, so tests can stand in a fake. */
export interface MainIpc {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void
}

export interface BridgeOptions {
  readonly ipc: MainIpc
  readonly db: Database
  /** The windows' `webContents` open now, which events are sent to. */
  readonly targets: () => readonly EventTarget[]
  /** What runs the tasks' agents: the Claude Agent SDK in the app, a scripted stand-in in tests. */
  readonly agentBackend: AgentBackend
}

/** What the bridge started, for the app to shut down. */
export interface RegisteredBridge {
  readonly runner: AgentRunner
}

/**
 * Answers the renderer's commands on the command channel and broadcasts events on the event channel, with an agent
 * runner on `agentBackend` for the tasks' agents.
 */
export function registerBridge({ ipc, db, targets, agentBackend }: BridgeOptions): RegisteredBridge {
  const emit = createBroadcast(EVENT_CHANNEL, targets)
  const runner = createAgentRunner({ db, emit, backend: agentBackend })
  const dispatch = createDispatcher(createHandlers({ db, emit, runner }), REQUEST_SCHEMAS)
  ipc.handle(COMMAND_CHANNEL, (_event, command, request) => dispatch(command, request))
  return { runner }
}
