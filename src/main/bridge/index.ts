import type { Database } from 'better-sqlite3'
import { COMMAND_CHANNEL, EVENT_CHANNEL } from '../../shared/bridge'
import type { AgentBackend } from '../agent/backend'
import { createGladeMcpServer, GLADE_SERVER } from '../agent/glade-tools'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import type { NotifyReply } from '../notifications/notifications'
import { createBroadcast, createDispatcher, type EventTarget } from './dispatcher'
import type { Emit } from './events'
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
  /** Shows the native open-folder dialog; resolves with the chosen path, or null when cancelled. */
  readonly chooseFolder: () => Promise<string | null>
  /** What runs the tasks' agents: the Claude Agent SDK in the app, a scripted stand-in in tests. */
  readonly agentBackend: AgentBackend
  /** Notifies an agent reply in a task you aren't viewing (`../notifications`). Nothing by default. */
  readonly notifyReply?: NotifyReply
  /** Whether the network is up, for resuming a task paused offline (the runner's `isOnline`). Always up by default. */
  readonly isOnline?: () => boolean
}

/** What the bridge started, for the app to shut down. */
export interface RegisteredBridge {
  readonly runner: AgentRunner
  /** Broadcasts an event to the windows. */
  readonly emit: Emit
}

/**
 * Answers the renderer's commands on the command channel and broadcasts events on the event channel, with an agent
 * runner on `agentBackend` for the tasks' agents.
 */
export function registerBridge({
  ipc,
  db,
  targets,
  chooseFolder,
  agentBackend,
  notifyReply,
  isOnline,
}: BridgeOptions): RegisteredBridge {
  const emit = createBroadcast(EVENT_CHANNEL, targets)
  const runner = createAgentRunner({
    db,
    emit,
    backend: agentBackend,
    notifyReply,
    isOnline,
    // Each session gets its own Glade tools, built for its task.
    mcpServers: (task) => ({ [GLADE_SERVER]: createGladeMcpServer({ db, emit }, task.id) }),
  })
  const dispatch = createDispatcher(createHandlers({ db, emit, chooseFolder, runner }), REQUEST_SCHEMAS)
  ipc.handle(COMMAND_CHANNEL, (_event, command, request) => dispatch(command, request))
  return { runner, emit }
}
