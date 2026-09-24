import type { Database } from 'better-sqlite3'
import { COMMAND_CHANNEL, EVENT_CHANNEL } from '../../shared/bridge'
import type { MenuState } from '../../shared/commands'
import type { AgentBackend } from '../agent/backend'
import { createGladeMcpServer, GLADE_SERVER } from '../agent/glade-tools'
import { createAgentRunner, type AgentRunner } from '../agent/runner'
import type { OpenPath, RevealPath, WriteClipboard } from '../files/files'
import type { NotifyReply } from '../notifications/notifications'
import { getSettings } from '../db/repositories/settings'
import { createQuestionBroker } from '../questions/questions'
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
  /** Opens a file in the app macOS opens its kind of file with (Electron's `shell.openPath`): Open in editor. */
  readonly openPath: OpenPath
  /** Shows a file in Finder, selected (Electron's `shell.showItemInFolder`): an artifact's Reveal in folder. */
  readonly revealPath: RevealPath
  /** Puts text on the clipboard (Electron's `clipboard.writeText`): an artifact's Copy. */
  readonly writeClipboard: WriteClipboard
  /** What runs the tasks' agents: the Claude Agent SDK in the app, a scripted stand-in in tests. */
  readonly agentBackend: AgentBackend
  /** Notifies an agent reply in a task you aren't viewing (`../notifications`). Nothing by default. */
  readonly notifyReply?: NotifyReply
  /** Whether the network is up, for resuming a task paused offline (the runner's `isOnline`). Always up by default. */
  readonly isOnline?: () => boolean
  /** Rebuilds the menu bar from what the window says it shows (`menu.update`). Nothing by default. */
  readonly updateMenu?: (state: MenuState) => void
  /** Closes the focused window (`window.close`). Nothing by default. */
  readonly closeWindow?: () => void
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
  openPath,
  revealPath,
  writeClipboard,
  agentBackend,
  notifyReply,
  isOnline,
  updateMenu,
  closeWindow,
}: BridgeOptions): RegisteredBridge {
  const emit = createBroadcast(EVENT_CHANNEL, targets)
  // One broker for the agent's questions: the Glade tools' `ask` waits on it, and the runner answers through it.
  const questions = createQuestionBroker({ db, emit }, notifyReply)
  const runner = createAgentRunner({
    db,
    emit,
    backend: agentBackend,
    notifyReply,
    questions,
    isOnline,
    // Each session gets its own Glade tools, built for its task, with the upkeep Settings has on as it starts.
    mcpServers: (task) => ({
      [GLADE_SERVER]: createGladeMcpServer({ db, emit, questions }, task.id, getSettings(db)),
    }),
  })
  const dispatch = createDispatcher(
    createHandlers({ db, emit, chooseFolder, openPath, revealPath, writeClipboard, runner, updateMenu, closeWindow }),
    REQUEST_SCHEMAS,
  )
  ipc.handle(COMMAND_CHANNEL, (_event, command, request) => dispatch(command, request))
  return { runner, emit }
}
